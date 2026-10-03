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
//
// 2026-10-03 — THE REPLY'S LENGTH IS BOUNDED BY ITS SHAPE, NOT BY A CAP. Measured: Rob asked
// "how much money do you think there is waiting in the emails" and the reply was 743 output
// tokens (~550 words) in 9.0s, against a persona that already said "usually one to four
// sentences". The instruction was present and ignored, so the reply call now names its role,
// carries a `{ reply: string }` schema whose description repeats the length rule, and — if it
// still overshoots the named budget — gets ONE bounded repair pass that keeps the ORIGINAL on
// any failure. The budget, the reasoning for its size, the long-form exemption and every
// decision live in lib/jarvisReplyBudget.js (pure, import-free, asserted with no model).
// MAX_REPLY_TOKENS is NOT lowered: a smaller cap turns verbosity into OUTPUT_TRUNCATED (H6).
//
// 2026-10-04 — IT STREAMS, AND SAYS WHAT IT IS DOING. Rob: *"i think the problem is it doesnt look like
// its doing anything but i thought we were trying to get it to instantly start streaming the output then
// it can read it when its done if that easier but i want to see it earlier and being written if it can
// start reading behind the streamed output even better"*. Three things, in the order he asked for them:
//
//   1. a live `{type:'stage'}` event the moment the message arrives, with what is happening and an ETA
//      from this deployment's own measured latency — the shape chatWithMorpheus.js has had since
//      2026-09-03;
//   2. `{type:'delta'}` events, one per fragment of the reply as the model writes it, so the words appear
//      while they are being made rather than in one lump at the end;
//   3. the client speaks the first complete sentence as soon as it exists (useMorpheusVoice.js).
//
// NEGOTIATION — copied exactly from generateSeoMeta.js, because it is this change's safety property:
// streaming is opted into with a `stream: true` FIELD in the body, deliberately not the Accept header
// (`functions.invoke` and `functions.invokeStream` send byte-identical requests today, so a header could
// not tell them apart). A caller that sends no `stream` field — an older deployed bundle, curl, a posted
// script — gets exactly today's plain JSON `{ reply }`, the same status codes and the same stored row.
// The decision itself lives in lib/jarvisReplyStream.js so it is asserted directly rather than being a
// condition buried here.
//
// THE LENGTH FIX AND THE STREAM ARE THE SAME PATH, not two. The reply is still the `{ reply: string }`
// schema call on `planner`, still measured against CONVERSATIONAL_REPLY_TARGET_CHARS, still repaired at
// most once and still exempt for an explicit report/plan/breakdown request — the streaming call carries
// the same schema and role (`invokeAIStream`'s `deltaField` is what makes a JSON envelope showable as
// prose), and EVERY failure falls back to `blockingReply`, which is #489's own call extracted verbatim.
// So the text that ends up stored does not depend on which transport answered.
import { prisma } from '../db.js';
import { invokeAI, invokeAIStream } from '../ai.js';
import { getJarvisMemory, formatMemoryBlock, HISTORY_WINDOW } from '../lib/deckMemory.js';
import { buildConversationBlock } from '../lib/promptBounds.js';
import { getDeckBusinessContext, getDeckOperatingRegions } from '../lib/deckBusinessProfile.js';
import { buildDeckSnapshot } from '../lib/deckSnapshot.js';
import { buildJarvisSystemPrompt } from '../lib/jarvisPersona.js';
import { SNAPSHOT_NEED_SCHEMA, buildSnapshotNeedPrompt, shouldIncludeSnapshot, selectedCareerKeys } from '../lib/deckSnapshotGate.js';
import {
  CONVERSATIONAL_REPLY_TARGET_CHARS,
  REPLY_SCHEMA,
  REPAIR_SCHEMA,
  buildRepairPrompt,
  extractReply,
  isLongFormRequest,
  repairDecision,
  shouldRepairReply,
} from '../lib/jarvisReplyBudget.js';
import { estimateCallMs, PROSE_TIMING_ROLE } from '../lib/timingStats.js';
import {
  wantsStreamedReply, streamReplyDecision,
  JARVIS_READING_STAGE, JARVIS_READING_LABEL, JARVIS_REPLY_STAGE, JARVIS_REPLY_LABEL,
  JARVIS_TRIM_STAGE, JARVIS_TRIM_LABEL,
} from '../lib/jarvisReplyStream.js';
import { runBuildDeckWidget } from './buildDeckWidget.js';

const MAX_REPLY_TOKENS = 6000; // generous — this deployment's model can burn a chunk of the budget on reasoning before the actual reply, and the prompt now carries the full energy log + long-term memory, which makes a longer, pattern-spotting reply more likely. 2026-10-03: NOT lowered to force shorter replies. The length is bounded by the reply's SHAPE (REPLY_SCHEMA + one repair pass, see lib/jarvisReplyBudget.js); a smaller cap only turns verbosity into OUTPUT_TRUNCATED.
const MAX_REPAIR_TOKENS = 2000; // the shortening pass writes at most ~600 characters; 2000 leaves a flash-class model room for its own reasoning before it does

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

// The cheap classify call on the same hot path, and the main speed lever of this change: it answers
// TWO questions about the message — does it need the ~2,400-token Deck snapshot at all, and which of
// Jarvis's 36 past careers is it asking about (at most three briefs get attached). One call, because
// the classifier is already reading the message and being paid for it.
//
// The DECISIONS are not made here: `shouldIncludeSnapshot` and `selectedCareerKeys` own them, and
// they deliberately fail in OPPOSITE directions — the snapshot fails open (never answer blind), the
// careers fail empty (there is no token headroom, and the 36 names are always in the persona, so a
// miss is less sharp rather than wrong). Both rules are testable with fixtures and no model.
async function classifyTurnContext(userId, message) {
  const { result } = await invokeAI({ userId, prompt: buildSnapshotNeedPrompt(message), schema: SNAPSHOT_NEED_SCHEMA, role: 'classify', maxTokens: 1500 });
  return { includeSnapshot: shouldIncludeSnapshot(result), careers: selectedCareerKeys(result) };
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

/**
 * The transport decision, and nothing else.
 *
 * A caller with no `stream` field runs exactly the code path this handler has always run — one plain
 * JSON `{ reply }` and today's status codes — and none of the streaming apparatus is entered.
 * Argument validation still throws real HTTP statuses for either kind of caller, because it happens
 * before a single byte is written.
 */
export default async function handler({ user, body, res }) {
  const message = (body?.message || '').trim();
  const fileUrls = Array.isArray(body?.fileUrls) ? body.fileUrls.filter((u) => typeof u === 'string' && u) : [];
  if (!message && fileUrls.length === 0) throw Object.assign(new Error('message is required'), { status: 400 });

  if (!wantsStreamedReply(body) || !res || typeof res.writeHead !== 'function') {
    return runReply({ user, message, fileUrls });
  }

  // From here the status code is spent, so a failure travels as the terminal event rather than as an
  // HTTP error — the same contract generateSeoMeta.js and chatWithMorpheus.js use.
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no', // don't buffer, flush each line (the SEO and chat paths do the same)
  });
  const emit = (event) => { try { res.write(JSON.stringify(event) + '\n'); } catch { /* client went away */ } };

  const readingStartedAt = Date.now();
  // FIRST BYTE IMMEDIATELY. The two classifiers and the snapshot read all happen before the reply call
  // even starts, so without this the operator's first evidence that anything was happening would be the
  // first token of the answer. The ETA is this deployment's own rolling average for `classify` (the role
  // those gates run on), not a guess — lib/timingStats.js.
  emit({
    type: 'stage', stage: JARVIS_READING_STAGE, status: 'start', label: JARVIS_READING_LABEL,
    etaSeconds: Math.round(estimateCallMs('classify') / 1000),
  });

  // A heartbeat, because the worst silence on this path is the reply call itself: if the provider streams
  // nothing for a while, no event is emitted at all, and one long silence is exactly what an ingress in
  // front of Express cuts. The client acts only on stage/delta/result/error, so this costs the UI nothing.
  const beat = setInterval(() => emit({ type: 'ping', elapsedMs: Date.now() - readingStartedAt }), 15000);
  beat.unref?.();

  try {
    emit({ type: 'result', data: await runReply({ user, message, fileUrls, emit, readingStartedAt }) });
  } catch (err) {
    // `message`/`error` are both set: `message` is what base44Client's reader surfaces, `error` is what a
    // caller reading a thrown function error would, so the surface shows the same wording either way.
    emit({
      type: 'error',
      message: err?.message || 'Internal error',
      error: err?.message || 'Internal error',
      ...(err?.code ? { code: err.code } : {}),
      ...(err?.status ? { status: err.status } : {}),
    });
  } finally {
    clearInterval(beat);
    try { res.end(); } catch { /* already closed */ }
  }
  return undefined;
}

/**
 * The turn itself, shared by both transports.
 *
 * With no `emit` this is the pre-2026-10-04 handler, line for line: one blocking reply, the empty-reply
 * refusal, one stored row, `{ reply }`. With `emit` the only differences are that the reply is streamed
 * (see streamReply below) and the stages are announced — everything before that point (the two booleans,
 * the history read, the user row, the widget-build branch, the prompt and its composition log) is
 * identical for both, which is why it lives in one function rather than two.
 */
async function runReply({ user, message, fileUrls, emit = null, readingStartedAt = null }) {
  // Both cheap booleans run together with the data fetches, so the two extra round-trips
  // are not serial. Each one FAILS OPEN in the direction that cannot hurt the operator:
  // a failed widget check is ordinary chat, a failed snapshot check INCLUDES the snapshot
  // (a false "no deck needed" answers a real question blind; a false "deck needed" costs
  // tokens — prefer the tokens).
  //
  // The history is read BEFORE this turn's user row is written below, so the prompt's
  // conversation block is what was said before — not the message being answered.
  const [wantsWidgetBuild, turnContext, history, memory, businessContext, regions] = await Promise.all([
    message
      ? classifyWidgetBuildIntent(user.id, message).catch((err) => {
          console.warn('[chatWithJarvis] widget-build intent check failed — treating this as an ordinary chat turn:', err?.message || err);
          return false;
        })
      : false,
    message
      ? classifyTurnContext(user.id, message).catch((err) => {
          // Both failure directions from one dead call, and they are not the same: the snapshot is
          // INCLUDED (never answer a real question blind) and the careers are EMPTY (no headroom,
          // and the 36 names are still in the persona, so this is the pre-feature behaviour).
          console.warn('[chatWithJarvis] snapshot-need check failed — including the snapshot, attaching no career briefs:', err?.message || err);
          return { includeSnapshot: true, careers: [] };
        })
      : { includeSnapshot: true, careers: [] },
    prisma.deckJarvisMessage.findMany({
      where: { created_by_id: user.id },
      orderBy: { created_date: 'desc' },
      take: HISTORY_WINDOW,
    }),
    getJarvisMemory(user.id),
    getDeckBusinessContext(user.id),
    // Where they operate, so jurisdiction-specific advice can be grounded rather than assumed.
    // An empty list is the honest "we were never told" variant — see buildRegionsClaim.
    getDeckOperatingRegions(user.id),
  ]);
  const { includeSnapshot, careers } = turnContext;
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
  const personaBlock = buildJarvisSystemPrompt({ firstName, businessContext, hasSnapshot: includeSnapshot, regions, careers });
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
  // Careers and regions are named because "no brief was attached" and "no region is stored" are the
  // two silent-degradation paths of this feature: without this line, a selector that never fires
  // looks exactly like a message that needed nothing.
  console.log(`[chatWithJarvis] snapshot gate: included=${includeSnapshot} careers=[${careers.join(', ')}] regions=${regions.length}`);

  // A turn that explicitly asks for a report, plan or breakdown keeps the long path: the budget
  // in lib/jarvisReplyBudget.js does not apply to it, and its reply is never sent for repair.
  const longForm = isLongFormRequest(message);

  if (emit) {
    return streamReply({ user, prompt, fileUrls, emit, readingStartedAt, longForm });
  }

  let { reply, truncated } = await blockingReply({ user, prompt, fileUrls });
  reply = requireReply(reply);

  const repairedReply = await repairReply({ user, reply, longForm });
  logReplySize({ reply: repairedReply.reply, repaired: repairedReply.repaired, longForm, truncated });

  await prisma.deckJarvisMessage.create({ data: { created_by_id: user.id, role: 'jarvis', content: repairedReply.reply } });

  return { reply: repairedReply.reply };
}

/**
 * The BLOCKING reply call — the `{ reply: string }` schema call, and the plain-prose retry when the
 * ceiling cut it off.
 *
 * Extracted from the non-streaming path verbatim (PR #489) and used by BOTH transports: the streaming
 * path's fallback is this exact call, never a second, weaker one. That is what makes "the same final
 * stored text either way" true by construction rather than by inspection — the length budget, the role
 * and the truncation recovery cannot drift apart between the two transports, because there is only one
 * of each.
 */
async function blockingReply({ user, prompt, fileUrls }) {
  // The reply call names its own ROLE and carries a `{ reply: string }` SCHEMA. The schema is
  // what removes the preamble and the markdown wrapper, and it is where the length rule lives a
  // second time, next to the persona — because the persona is prose and prose does not throw.
  // The role is `planner`, on purpose: it resolves to deepseek-v4-pro @ 0.7, which is EXACTLY
  // what this call already got from the platform default (MODEL-DECISIONS: the deck's
  // conversation stays on pro — persona and judgement, Rob's call). Naming it moves the model by
  // nothing and makes the choice visible instead of accidental. It is NOT moved to flash.
  let reply = '';
  let truncated = false;
  try {
    const { result, truncated: wasTruncated = false } = await invokeAI({ userId: user.id, prompt, fileUrls, schema: REPLY_SCHEMA, role: 'planner', maxTokens: MAX_REPLY_TOKENS });
    reply = extractReply(result);
    truncated = wasTruncated;
  } catch (err) {
    // H6: a SCHEMA call that hits the cap THROWS (the old plain-prose call returned the cut-off
    // text instead). That is right for a value the caller acts on and wrong here — without this
    // branch a long-form answer that ran to the ceiling would be LOST, where before this change
    // it came back readable but cut. So the truncation is answered the way this call always
    // did: one retry WITHOUT the schema, which returns the prose it managed to write. A verbose
    // answer beats a lost one, and this is the only reason the cap is still the guard rail it was.
    if (!/^OUTPUT_TRUNCATED/.test(err?.message || '')) throw err;
    console.warn('[chatWithJarvis] reply hit the token ceiling as JSON — retrying as plain prose so a long answer is not lost');
    const { result: prose } = await invokeAI({ userId: user.id, prompt, fileUrls, role: 'planner', maxTokens: MAX_REPLY_TOKENS });
    reply = extractReply(prose);
    truncated = true;
  }
  return { reply, truncated };
}

/** Today's refusal, unchanged and in ONE place: an empty reply is never stored, on either transport. */
function requireReply(reply) {
  if (!String(reply || '').trim()) {
    // A 200 with an empty body was stored as an empty bubble: the operator saw a blank
    // message and no error. The comment at the top of this file records the same thing
    // happening before. Nothing is persisted this time, and the caller is told the turn
    // produced nothing, rather than being handed a blank Jarvis reply to interpret.
    throw new Error('Jarvis returned an empty reply — nothing was stored. Ask again.');
  }
  return reply;
}

/**
 * At most ONE bounded repair pass, and only for a conversational turn that overshot the target.
 * `draft` is this repo's mechanical-prose role (flash @ 0.4) — a rewrite is prose work, not
 * classification. The DECISION is pure (`repairDecision`): a failed, truncated, junk or no-shorter
 * rewrite keeps the ORIGINAL reply, because a verbose answer beats a lost one and nothing is ever
 * stored empty.
 *
 * One implementation for both transports. This is the one thing streaming cannot show happening — it
 * rewrites text the operator has already read — so the streaming caller passes `emit` and the pass is
 * announced as a stage instead; the terminal event's reply then replaces the streamed bubble.
 */
async function repairReply({ user, reply, longForm, emit = null }) {
  if (!shouldRepairReply(reply, { longForm })) return { reply, repaired: false };
  const startedAt = Date.now();
  emit?.({
    type: 'stage', stage: JARVIS_TRIM_STAGE, status: 'start', label: JARVIS_TRIM_LABEL,
    etaSeconds: Math.round(estimateCallMs('draft') / 1000),
  });
  let repaired = false;
  try {
    const { result: repairResult, truncated: repairTruncated = false } = await invokeAI({
      userId: user.id,
      prompt: buildRepairPrompt({ reply }),
      schema: REPAIR_SCHEMA,
      role: 'draft',
      maxTokens: MAX_REPAIR_TOKENS,
    });
    const decision = repairDecision({ original: reply, result: repairResult, truncated: repairTruncated });
    if (decision.repaired) {
      reply = decision.reply;
      repaired = true;
    } else {
      console.warn(`[chatWithJarvis] reply repair kept the original (${decision.reason}) — nothing was lost`);
    }
  } catch (err) {
    // A throw here must never take the turn down: the original reply is already in hand.
    console.warn('[chatWithJarvis] reply repair failed — keeping the original reply:', err?.message || err);
  }
  emit?.({
    type: 'stage', stage: JARVIS_TRIM_STAGE, status: 'done', label: JARVIS_TRIM_LABEL,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
  });
  return { reply, repaired };
}

/**
 * The ANSWER's size, LENGTHS ONLY — the same contract as the prompt-composition line above, and the
 * measurement that makes the length fix visible. A reply at or under the target is smaller than
 * CONVERSATION_PER_MESSAGE_CHARS (1500), so the next turn's conversation block carries it whole
 * instead of slicing it — and a smaller stored reply is a smaller prompt on the next turn.
 *
 * One line for both transports: which one answered is visible in the `repaired`/`truncated` fields and
 * in the stage log, and a second copy of this line would be a second thing to keep in step.
 */
function logReplySize({ reply, repaired, longForm, truncated }) {
  console.log(`[chatWithJarvis] reply chars: chars=${reply.length} target=${CONVERSATIONAL_REPLY_TARGET_CHARS} repaired=${repaired} longForm=${longForm} truncated=${truncated}`);
}

/**
 * The reply, streamed — and the fallback when streaming cannot do it.
 *
 * The order is deliberate. The stage events bracket the whole attempt so the operator's clock is running
 * even if the stream then fails and the blocking call takes over; the failure path is `blockingReply`,
 * the SAME call the non-streaming transport makes, so a broken stream degrades to today's behaviour
 * rather than to an error; and what gets stored goes through the same `requireReply` and `repairReply`
 * as the blocking path, so the stored text cannot depend on which transport answered.
 */
async function streamReply({ user, prompt, fileUrls, emit, readingStartedAt, longForm }) {
  emit({
    type: 'stage', stage: JARVIS_READING_STAGE, status: 'done', label: JARVIS_READING_LABEL,
    elapsedSeconds: readingStartedAt ? Math.round((Date.now() - readingStartedAt) / 1000) : undefined,
  });
  const replyStartedAt = Date.now();
  emit({
    type: 'stage', stage: JARVIS_REPLY_STAGE, status: 'start', label: JARVIS_REPLY_LABEL,
    // The role-less prose bucket (lib/timingStats.js's PROSE_TIMING_ROLE) is what learns from a streamed
    // reply's duration; `planner`'s bucket is already fed by the blocking call and by every build.
    etaSeconds: Math.round(estimateCallMs(PROSE_TIMING_ROLE) / 1000),
  });
  const finish = (finalReply) => {
    emit({ type: 'stage', stage: JARVIS_REPLY_STAGE, status: 'done', label: JARVIS_REPLY_LABEL, elapsedSeconds: Math.round((Date.now() - replyStartedAt) / 1000) });
    return { reply: finalReply };
  };

  let outcome = null;
  let failure = null;
  try {
    outcome = await invokeAIStream({
      userId: user.id,
      prompt,
      // The SAME call shape as the blocking path — the reply's own schema and role, so the length rule
      // applies mid-stream too. `deltaField` is what makes a JSON envelope showable as prose: only the
      // reply's decoded value is ever emitted, never the braces or the key.
      schema: REPLY_SCHEMA,
      deltaField: 'reply',
      role: 'planner',
      maxTokens: MAX_REPLY_TOKENS,
      task: 'chatWithJarvis',
      onDelta: (text) => emit({ type: 'delta', text }),
    });
  } catch (err) {
    failure = err;
  }

  // ONE decision, and it is the pure one (lib/jarvisReplyStream.js): a failed stream, a body that ended
  // without a terminal chunk, or an empty/half envelope all fall back; only a complete, non-empty reply
  // is stored from the stream itself.
  const decision = streamReplyDecision({
    ok: !failure,
    complete: outcome?.complete === true,
    text: outcome ? extractReply(outcome.result) : '',
  });

  let reply = '';
  let truncated = false;
  if (decision.action === 'fallback') {
    // Loud, because every one of these is a real reason the operator is not seeing words as they are
    // written: attachments (by design), an endpoint that refuses `stream_options`, a stream that died
    // mid-answer, or a ceiling cut that left the envelope unparseable. The turn is not lost — the next
    // call is the one the non-streaming transport makes, and it owns the prose retry (PR #489).
    console.warn(`[chatWithJarvis] streamed reply ${decision.reason} — falling back to the blocking call (${failure?.message || 'the stream did not produce a complete reply'})`);
    ({ reply, truncated } = await blockingReply({ user, prompt, fileUrls }));
    reply = requireReply(reply);
  } else {
    reply = decision.content;
    // A schema stream that reached the ceiling cannot have parsed, so this is normally false; it is
    // reported rather than assumed either way.
    truncated = outcome.finishReason === 'length';
  }

  const repairedReply = await repairReply({ user, reply, longForm, emit });
  logReplySize({ reply: repairedReply.reply, repaired: repairedReply.repaired, longForm, truncated });

  // The authority. The stream has already put the draft on the operator's screen, and the client
  // REPLACES that with this value when the terminal event lands — so when the repair shortened the
  // reply, or a fallback produced something other than the fragments, the surface never keeps showing
  // words the database does not have.
  await prisma.deckJarvisMessage.create({ data: { created_by_id: user.id, role: 'jarvis', content: repairedReply.reply } });
  return finish(repairedReply.reply);
}
