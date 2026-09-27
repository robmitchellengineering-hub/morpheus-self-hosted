// Jarvis — Command Deck's AI persona (later phase). A plain conversation
// grounded in a live snapshot of the caller's Deck* data, NOT a fork of
// chatWithMorpheus.js: no plannedFiles/fileOperations, no reviewer/coder
// stages, no NDJSON stage streaming — those all exist to build app code,
// which has nothing to do with a life/business chat. This reuses only the
// low-level plumbing (invokeAI) and returns a plain JSON { reply }, same as
// any other simple function (see functions.routes.js — a handler that just
// returns a value gets `res.json(result)` for free).
import { prisma } from '../db.js';
import { invokeAI } from '../ai.js';
import { getJarvisMemory, formatMemoryBlock, HISTORY_WINDOW } from '../lib/deckMemory.js';
import { getDeckBusinessContext } from '../lib/deckBusinessProfile.js';
import { buildDeckSnapshot } from '../lib/deckSnapshot.js';
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

// 2026-09-17: parameterized (was a fixed const hardcoding "Rob"/"Valiant
// Music"/his exact $100k-on-30hrs goal/his ADHD) so the same persona
// structure — butler + big brother, dry cutting wit, cross-domain expert
// framing, holistic-life worldview — works for any account, not just Rob's.
// He was the only account this ever ran for, so nothing about his own
// experience changes: his DeckBusinessProfile is backfilled with exactly
// this prompt's old hardcoded facts (see this feature's migration SQL).
function buildJarvisSystemPrompt({ firstName, businessContext }) {
  return `You are Jarvis — ${firstName}'s butler, and something like a big brother: fiercely on their side, never soft about it. Dry, devilish wit, understated rather than goofy. Your encouragement can be cutting — you'll rib them for sitting on something obvious in the same breath as pushing them to just do it, and it lands because they know you mean it.

You've had a string of careers, genuinely top of your field in every one of them — call on whichever fits what they're actually asking (finance, strategy, hospitality, leadership, whatever the moment calls for), name the hat you're wearing, and give real expert-grade advice, not generic life-coach platitudes, always tied back to what they're actually trying to build.

Your worldview: a successful life isn't just the business turning a profit. It's work, money, relationships, family, fun, real growth, actual strategy, and genuine downtime, all in balance — not one traded off against the rest indefinitely. ${firstName} runs ${businessContext} — but you notice just as fast when they're neglecting the people around them, haven't had a real day off, or are white-knuckling something that isn't actually moving them toward any of it.

Blunt beats gentle with this person — say the thing plainly instead of burying it in caveats.

You're looking at a live snapshot of their brain dump, tasks, strategy notes, knowledge/ideas, their business's own operational queues if they use them, their FULL energy log (every day they've ever logged, not just a recent window), and their life streams outside work (health, money, home, people, growth).

The energy log is one of your sharpest tools precisely because it's the whole history — actually scan it for real patterns (day-of-week dips, a slide over the last month, a level that never really recovered after something), not just today's number. When you spot one worth naming, don't just name it: either suggest tasks that actually work with the pattern (heavy stuff scheduled for when they're reliably sharp, not fought against a known slump), or give a real strategy to address it if it looks like something worth fixing rather than just working around.

Answer whatever they actually ask, grounded in that snapshot — connect the dots across business and life where it's relevant, flag anything stale or that could make money fast, and if the energy log shows a real pattern worth naming, name it plainly, dry wit intact, never therapy-speak. Be direct and specific, never generic boilerplate. Match your reply's length to the question — a quick question gets a quick, cutting answer, not a forced report. No preamble, no sign-off.`;
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

  const [snapshot, history, memory, businessContext] = await Promise.all([
    buildDeckSnapshot(user.id),
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
  // This classifier runs on EVERY message, before the reply, and it is an
  // optimisation: it recognises "build me a widget" and answers with a canned
  // acknowledgement instead of a chat reply. `invokeAI` throws on a timeout, a
  // truncation or a bad response, and a throw here used to propagate out of the
  // handler as a 500 — so an AI hiccup on a non-essential boolean cost the operator
  // the whole turn ("Couldn't reach Jarvis that time"), on top of an orphaned user
  // row, because the message is persisted above. A failure means "treat this as
  // ordinary chat", loudly logged; the build can simply be asked for again.
  let wantsWidgetBuild = false;
  if (message) {
    try {
      wantsWidgetBuild = await classifyWidgetBuildIntent(user.id, message);
    } catch (err) {
      console.warn('[chatWithJarvis] widget-build intent check failed — treating this as an ordinary chat turn:', err?.message || err);
    }
  }
  if (wantsWidgetBuild) {
    const reply = `Already building it — plan, code, review, ship, the whole thing, properly. That's a good fifteen minutes, not a parlour trick. Watch it happen in Settings → Widgets if you're itching to look, or just carry on talking to me while it cooks.`;
    await prisma.deckJarvisMessage.create({ data: { created_by_id: user.id, role: 'jarvis', content: reply } });
    runBuildDeckWidget(user, widgetBuildGoal(message, { firstName, businessContext })).catch((err) => {
      console.error('[chatWithJarvis] widget build crashed:', err.message);
    });
    return { reply };
  }

  const conversationBlock = history.length
    ? history.map((m) => `${m.role === 'user' ? firstName : 'Jarvis'}: ${m.content}`).join('\n')
    : '(no prior conversation)';

  // Named so the log line below can size each block. The assembled prompt is byte-identical
  // to what this was before — the same strings, in the same order.
  const personaBlock = buildJarvisSystemPrompt({ firstName, businessContext });
  const memoryBlock = formatMemoryBlock(memory);
  const prompt = `${personaBlock}
${memoryBlock}
DATA SNAPSHOT:
${snapshot}

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
