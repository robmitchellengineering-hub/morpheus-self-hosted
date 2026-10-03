// Jarvis — Command Deck's AI persona (later phase). A plain conversation
// grounded in a live snapshot of the caller's Deck* data, NOT a fork of
// chatWithMorpheus.js: no plannedFiles/fileOperations, no reviewer/coder
// stages, no NDJSON stage streaming — those all exist to build app code,
// which has nothing to do with a life/business chat. This reuses only the
// low-level plumbing (invokeAI) and returns a plain JSON { reply }, same as
// any other simple function (see functions.routes.js — a handler that just
// returns a value gets `res.json(result)` for free).
//
// 2026-10-03 — THE SNAPSHOT IS GATED ON THE QUESTION. Measured: persona + rules ≈ 690
// tokens, the live snapshot ≈ 2,400, so the snapshot was 78% of every prompt including
// "say hello to my sister". A cheap `classify` boolean now decides whether the snapshot
// is fetched and interpolated at all, and — because dropping the data while the persona
// still said "You're looking at a live snapshot of…" would build a hallucination machine
// — the persona has a variant that says plainly it was not given one. See
// lib/deckSnapshotGate.js (the gate and its load-bearing failure direction),
// lib/jarvisPersona.js (both variants) and scripts/verify-jarvis-snapshot-gate.mjs.
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { getJarvisMemory, formatMemoryBlock, HISTORY_WINDOW } from '../lib/deckMemory.js';
import { buildConversationBlock } from '../lib/promptBounds.js';
import { getDeckBusinessContext } from '../lib/deckBusinessProfile.js';
import { buildDeckSnapshot } from '../lib/deckSnapshot.js';
import { buildJarvisSystemPrompt } from '../lib/jarvisPersona.js';
import { SNAPSHOT_NEED_SCHEMA, buildSnapshotNeedPrompt, shouldIncludeSnapshot } from '../lib/deckSnapshotGate.js';
import { runBuildDeckWidget } from './buildDeckWidget.js';

const MAX_REPLY_TOKENS = 6000; // generous — this deployment's model can burn a chunk of the budget on reasoning before the actual reply, and the prompt now carries the full energy log + long-term memory, which makes a longer, pattern-spotting reply more likely

// Phase 3 of the Jarvis-built widgets plan (2026-09-18) — a cheap classifier,
// same pattern as classifyDeckDumpItem.js, run before the full Jarvis reply
// so an explicit "build me a widget" request routes straight to
// runBuildDeckWidget instead of Jarvis just explaining he can't do that.
// Deliberately narrow: only an unambiguous request to build/make/create a
// NEW Command Deck widget trips it — never a question about an existing
// one, a feature idea floated in passing, or ordinary conversation. A false
// positive here kicks off a real, unattended ~15-minute build against the
// shared self-dev workspace, so the bar is "unambiguous ask", not "sounds
// vaguely related".
const WIDGET_BUILD_INTENT_SCHEMA = {
  type: 'object',
  properties: {
    isWidgetBuildRequest: {
      type: 'boolean',
      description: 'true ONLY if the user is explicitly and unambiguously asking to build/create/make a brand NEW Command Deck widget for their dashboard right now. False for everything else — a question, a feature idea floated in passing, feedback about an EXISTING widget, or any normal conversation.',
    },
  },
  required: ['isWidgetBuildRequest'],
};

async function classifyWidgetBuildIntent(userId, message) {
  const prompt = `Does this message from a Command Deck user explicitly ask to build/create/make a brand new widget for their dashboard, right now?

MESSAGE: "${message}"

Say true only for an unambiguous build request ("build me a widget that...", "can you make a widget for...", "create a widget to..."). Say false for a question, a vague idea, feedback on an existing widget, or normal conversation.`;
  // `classify` (flash @ 0.4), not the platform default. This is a yes/no question asked on
  // EVERY deck message before the reply is even attempted, so the expensive model was
  // answering a boolean on the hot path of every turn — and it named no role at all, so it
  // resolved to default_model (v4-pro) @ 0.7 with a 600-token cap: the same hidden-reasoning
  // trap the note that used to sit here was written to outrun.
  const { result } = await invokeAI({ userId, prompt, schema: WIDGET_BUILD_INTENT_SCHEMA, role: 'classify', maxTokens: 1500 });
  return result?.isWidgetBuildRequest === true;
}

// The second cheap boolean on the same hot path, and the main speed lever of this change:
// does this message need the ~2,400-token Deck snapshot at all? Same shape as the widget
// check above — `classify`, a one-field schema, 1500 tokens. The DECISION is not made here:
// `shouldIncludeSnapshot` owns the failure direction (only an explicit, usable `false`
// drops the snapshot), so the rule is testable with fixtures and no model.
async function classifySnapshotNeed(userId, message) {
  const { result } = await invokeAI({ userId, prompt: buildSnapshotNeedPrompt(message), schema: SNAPSHOT_NEED_SCHEMA, role: 'classify', maxTokens: 1500 });
  return shouldIncludeSnapshot(result);
}

// Rob, 2026-09-18: the build should get the same grounding a normal Jarvis
// reply does (what business/person this is for), not just the bare
// sentence the user typed — so the planner writes a widget that actually
// fits their business, not a generic guess. Deliberately just the business
// context, not the full live Deck snapshot (energy log, tasks, etc.) — that
// data is personal and ephemeral, irrelevant to widget CODE, and a widget
// build's own scope_policy already keeps it from reading anything at build
// time anyway (a widget reads live data at RUNTIME, via lib/deck*.js — see
// widgetAuthoringContext in buildDeckWidget.js).
function widgetBuildGoal(message, { firstName, businessContext }) {
  return `${message}\n\n(For context: this is for ${firstName}, who runs ${businessContext}.)`;
}

// Photo/PDF/Word/Excel attachments (Rob, 2026-09-17: "javis needs to be
// able to accept file input"). The actual content (a vision description for
// a photo, extracted text for a PDF/DOCX/XLSX — both handled generically by
// invokeAI's own fileUrls support, see ai.js) is only ever used for THIS
// turn's prompt. What gets saved to DeckJarvisMessage — and therefore what
// deckMemory.js ever sees once this turn ages out of the recent window — is
// just a short filename reference, never the extracted content: "keep this
// lite" (Rob) means Command Deck's own persistent storage stays small no
// matter how large the attached document was.
function fileRefNote(fileUrls) {
  if (!fileUrls?.length) return '';
  const names = fileUrls.map((u) => decodeURIComponent(u.split('/').pop().split('?')[0]));
  return `\n[attached: ${names.join(', ')}]`;
}

export default async function handler({ user, body }) {
  const message = (body?.message || '').trim();
  const fileUrls = Array.isArray(body?.fileUrls) ? body.fileUrls.filter((u) => typeof u === 'string' && u) : [];
  if (!message && fileUrls.length === 0) throw Object.assign(new Error('message is required'), { status: 400 });

  // Both cheap booleans run together with the data fetches, so the two extra round-trips
  // are not serial. Each one FAILS OPEN in the direction that cannot hurt the operator:
  // a failed widget check is ordinary chat, a failed snapshot check INCLUDES the snapshot
  // (a false "no deck needed" answers a real question blind; a false "deck needed" costs
  // tokens — prefer the tokens).
  //
  // The history is read BEFORE this turn's user row is written below, so the prompt's
  // conversation block is what was said before — not the message being answered.
  const [wantsWidgetBuild, includeSnapshot, history, memory, businessContext] = await Promise.all([
    message
      ? classifyWidgetBuildIntent(user.id, message).catch((err) => {
          console.warn('[chatWithJarvis] widget-build intent check failed — treating this as an ordinary chat turn:', err?.message || err);
          return false;
        })
      : false,
    message
      ? classifySnapshotNeed(user.id, message).catch((err) => {
          console.warn('[chatWithJarvis] snapshot-need check failed — including the snapshot:', err?.message || err);
          return true;
        })
      : true,
    prisma.deckJarvisMessage.findMany({
      where: { created_by_id: user.id },
      orderBy: { created_date: 'desc' },
      take: HISTORY_WINDOW,
    }),
    getJarvisMemory(user.id),
    getDeckBusinessContext(user.id),
  ]);
  history.reverse();

  const firstName = (user.full_name || '').trim().split(/\s+/)[0] || 'You';

  const savedUserContent = `${message}${fileRefNote(fileUrls)}`.trim();
  await prisma.deckJarvisMessage.create({ data: { created_by_id: user.id, role: 'user', content: savedUserContent } });

  // Phase 3: an explicit widget-build request skips the normal reply
  // entirely and fires the real, ~15-minute unattended build in the
  // background — Jarvis stays usable for normal chat while it runs, and the
  // real progress lives in Settings' widget manager (Rob, 2026-09-18: "if
  // javis can just tell you where to watch the build that's better cause
  // then you can still chat and use him while it's working in the
  // background"), not streamed into this reply.
  if (wantsWidgetBuild) {
    const reply = `Already building it — plan, code, review, ship, the whole thing, properly. That's a good fifteen minutes, not a parlour trick. Watch it happen in Settings → Widgets if you're itching to look, or just carry on talking to me while it cooks.`;
    await prisma.deckJarvisMessage.create({ data: { created_by_id: user.id, role: 'jarvis', content: reply } });
    runBuildDeckWidget(user, widgetBuildGoal(message, { firstName, businessContext })).catch((err) => {
      console.error('[chatWithJarvis] widget build crashed:', err.message);
    });
    return { reply };
  }

  // The snapshot is FETCHED only when the gate said so — a greeting should not pay for the
  // queries either — and the persona is built from the SAME boolean, so the data and the
  // words about the data cannot disagree.
  const snapshot = includeSnapshot ? await buildDeckSnapshot(user.id) : '';

  // Bounded by characters, not only by message count: the count bound was right, the size bound
  // was missing (~60k tokens worst case, and it has already grown to 6,927 characters in
  // production through Jarvis's own verbosity). The last exchange stays verbatim and any omission
  // is named — see lib/promptBounds.js.
  const conversationBlock = buildConversationBlock(history, { firstName });

  // Named so the log lines below can size each block.
  const personaBlock = buildJarvisSystemPrompt({ firstName, businessContext, hasSnapshot: includeSnapshot });
  const memoryBlock = formatMemoryBlock(memory);
  const snapshotBlock = includeSnapshot ? `DATA SNAPSHOT:\n${snapshot}\n` : '';
  const prompt = `${personaBlock}
${memoryBlock}
${snapshotBlock}
RECENT CONVERSATION:
${conversationBlock}

${firstName}: ${message || '(see attached file)'}
Jarvis:`;

  // Where the input tokens went — LENGTHS ONLY, never content. An audit of this call found two
  // replies at ~15.6k input tokens (45% of all audited reply input) that nothing in this code or
  // in the account's own data explains, and they cannot be attributed after the fact:
  // `usage_events` records how many tokens were sent, never what was in them. This is the line
  // that answers it the next time it happens. It is the only change here.
  console.log(`[chatWithJarvis] reply prompt chars: persona=${personaBlock.length} memory=${memoryBlock.length} snapshot=${snapshot.length} conversation=${conversationBlock.length} message=${message.length} total=${prompt.length} fileUrls=${fileUrls?.length || 0}`);
  // The gate's own decision, on its own line so the composition log above stays lengths-only.
  console.log(`[chatWithJarvis] snapshot gate: included=${includeSnapshot}`);

  const { result: reply } = await invokeAI({ userId: user.id, prompt, fileUrls, maxTokens: MAX_REPLY_TOKENS });

  if (!String(reply || '').trim()) {
    // A 200 with an empty body was stored as an empty bubble: the operator saw a blank
    // message and no error. The comment at the top of this file records the same thing
    // happening before. Nothing is persisted this time, and the caller is told the turn
    // produced nothing, rather than being handed a blank Jarvis reply to interpret.
    throw new Error('Jarvis returned an empty reply — nothing was stored. Ask again.');
  }

  await prisma.deckJarvisMessage.create({ data: { created_by_id: user.id, role: 'jarvis', content: reply } });

  return { reply };
}
