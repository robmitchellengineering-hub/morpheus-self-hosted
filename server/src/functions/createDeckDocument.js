// Jarvis-driven, professionally formatted Google Doc creation — Rob's own
// framing: "a document based around what you have been chatting about,
// synthesised research, a letter you need to send, a table you need to
// create... a professionally formatted document creation tool driven by
// Jarvis." Takes a plain instruction, drafts a structured outline via
// invokeAI (title + typed blocks: heading/subheading/paragraph/bullet), then
// converts that directly into Docs batchUpdate requests. Deliberately
// structured-block AI output rather than parsing raw markdown text — a much
// smaller, more reliable surface than a real CommonMark parser, and covers
// exactly what a drafted document actually needs (see lib/deckGoogle.js's
// own comment above createGoogleDoc/batchUpdateGoogleDoc).
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { getDeckGoogleToken, createGoogleDoc, batchUpdateGoogleDoc, deleteDriveFile } from '../lib/deckGoogle.js';
import { getDeckBusinessContext } from '../lib/deckBusinessProfile.js';

const MAX_HISTORY_MESSAGES = 20;

const DOC_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'A short, specific title for the document (not "Untitled" or generic).' },
    blocks: {
      type: 'array',
      description: 'The document body, in order. Use heading/subheading sparingly for real structure, bullet only where a list genuinely fits.',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['heading', 'subheading', 'paragraph', 'bullet'] },
          text: { type: 'string' },
        },
        required: ['type', 'text'],
      },
    },
  },
  required: ['title', 'blocks'],
};

// Converts ordered {type, text} blocks into a single insertText call plus
// paragraph-style/bullet requests over the ranges that text lands at —
// Docs applies requests within one batchUpdate in order, so styling
// requests can safely reference ranges from the insert that precedes them
// in the same call.
function buildDocRequests(blocks) {
  let index = 1; // a fresh Google Doc's body starts at index 1
  let text = '';
  const styleRequests = [];
  const bulletRanges = [];

  for (const block of blocks) {
    const startIndex = index;
    const lineText = `${block.text}\n`;
    text += lineText;
    const endIndex = startIndex + lineText.length;

    if (block.type === 'heading') styleRequests.push({ startIndex, endIndex: endIndex - 1, style: 'HEADING_1' });
    else if (block.type === 'subheading') styleRequests.push({ startIndex, endIndex: endIndex - 1, style: 'HEADING_2' });
    else if (block.type === 'bullet') bulletRanges.push({ startIndex, endIndex: endIndex - 1 });

    index = endIndex;
  }

  const requests = [{ insertText: { location: { index: 1 }, text } }];
  for (const { startIndex, endIndex, style } of styleRequests) {
    requests.push({
      updateParagraphStyle: {
        range: { startIndex, endIndex },
        paragraphStyle: { namedStyleType: style },
        fields: 'namedStyleType',
      },
    });
  }
  for (const { startIndex, endIndex } of bulletRanges) {
    requests.push({
      createParagraphBullets: {
        range: { startIndex, endIndex },
        bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
      },
    });
  }
  return requests;
}

export default async function handler({ user, body }) {
  const instruction = (body?.instruction || '').trim();
  if (!instruction) throw Object.assign(new Error('instruction is required'), { status: 400 });

  const [history, businessContext] = await Promise.all([
    prisma.deckJarvisMessage.findMany({
      where: { created_by_id: user.id },
      orderBy: { created_date: 'desc' },
      take: MAX_HISTORY_MESSAGES,
    }),
    getDeckBusinessContext(user.id),
  ]);
  history.reverse();
  const firstName = (user.full_name || '').trim().split(/\s+/)[0] || 'the account owner';
  const conversationBlock = history.length
    ? history.map((m) => `${m.role === 'user' ? firstName : 'Jarvis'}: ${m.content}`).join('\n')
    : '(no prior conversation)';

  const prompt = `You are Jarvis, drafting a professionally formatted document for ${firstName}, who runs ${businessContext}. Given the instruction and recent conversation below, produce the actual finished document content — not a summary of what you're about to write.

INSTRUCTION: ${instruction}

RECENT CONVERSATION (pull in anything relevant — e.g. "summarize our conversation" or "write a letter based on what we discussed" both need this):
${conversationBlock}

Structure it with real headings/subheadings only where they genuinely help, plain paragraphs otherwise, and bullet points only where a list actually fits. Write ready-to-use content — no placeholders, no "[insert X here]".`;

  // Generous — a real document plus this model's own reasoning overhead
  // (the same lesson chatWithJarvis.js and every other Deck classifier
  // already learned the hard way) can easily exceed a tighter cap.
  // `role: 'draft'` — mechanical prose, like suggestDeckReply. This named no role and so
  // resolved to default_model (v4-pro @ 0.7) by accident; nothing recorded the choice.
  const { result } = await invokeAI({ userId: user.id, prompt, schema: DOC_SCHEMA, maxTokens: 8000, role: 'draft' });

  const title = (result?.title || 'Untitled Document').trim();
  const blocks = Array.isArray(result?.blocks) ? result.blocks.filter((b) => b?.text?.trim()) : [];
  if (blocks.length === 0) throw new Error('Jarvis could not draft this document — try rephrasing the instruction.');

  const { token } = await getDeckGoogleToken(user.id);
  // Built BEFORE the document exists, so a bad block cannot leave one behind.
  const requests = buildDocRequests(blocks);

  const doc = await createGoogleDoc(token, title);
  try {
    await batchUpdateGoogleDoc(token, doc.documentId, requests);
  } catch (err) {
    // Create-then-fill means a failed fill leaves an EMPTY document titled `title` in the
    // operator's own Drive — junk, in their account, from an operation that reported
    // failure, and nothing ever cleaned it up. Remove it; if the cleanup itself fails, log
    // that rather than replacing the error the operator needs to see.
    await deleteDriveFile(token, doc.documentId).catch((cleanupErr) => {
      console.error(`[createDeckDocument] left an empty document behind — could not remove ${doc.documentId}:`, cleanupErr?.message || cleanupErr);
    });
    throw err;
  }

  return { url: `https://docs.google.com/document/d/${doc.documentId}/edit`, documentId: doc.documentId, title };
}
