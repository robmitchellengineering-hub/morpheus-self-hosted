// Runtime verification for Jarvis's streamed reply and the speech that runs behind it.
//
// Dependency-free (pure modules, plus source assertions on the two files that need Prisma), so it runs
// in CI's no-install guards job.
// Run:  node scripts/verify-jarvis-stream.mjs
//
// WHY THIS EXISTS (2026-10-04, Rob: *"i think the problem is it doesnt look like its doing anything but
// i thought we were trying to get it to instantly start streaming the output then it can read it when
// its done if that easier but i want to see it earlier and being written if it can start reading behind
// the streamed output even better"*). Three things he asked for, in order, and each one has a way to be
// silently wrong:
//
//   1. IT LOOKS LIKE IT IS DOING SOMETHING. The Deck showed the constant string "Jarvis is thinking…"
//      for as long as the model took. The turn now streams a labelled stage with a real ETA and a
//      client-side clock, and `src/lib/jarvisStream.js` is the pure reducer that turns those events into
//      that state.
//   2. THE WORDS ARRIVE AS THEY ARE WRITTEN. The reply is a `{ reply: string }` JSON envelope (PR #489
//      bounds its length that way), so the fragments cannot be shown raw — `readJsonStringField` in
//      `server/src/lib/aiStream.js` decodes the one field out of a half-written envelope, and the whole
//      stream is framed by `reduceStreamLine`.
//   3. IT SPEAKS BEHIND THE STREAM. The sentence boundary is `nextSpeakableSegment`
//      (`src/lib/jarvisSpeech.js`) — the one thing that decides when there is something safe to say.
//
// And one safety property the whole change rests on:
//
//   4. A CALLER THAT SENT NO `stream` FIELD MUST BE UNAFFECTED, and any stream failure must fall back
//      to the blocking call rather than losing the turn. `streamReplyDecision` is that decision, and the
//      handler's wiring of it is asserted too — including that BOTH transports store the same text
//      through the same `requireReply` and `repairReply`, so the reply-length fix from #489 cannot be
//      traded away for streaming.
import { readFileSync } from 'node:fs';

import {
  initialStreamState, reduceStreamLine, reduceStreamChunk, streamOutcome, readJsonStringField,
} from '../server/src/lib/aiStream.js';
import { wantsStreamedReply, streamReplyDecision } from '../server/src/lib/jarvisReplyStream.js';
import {
  initialJarvisLive, reduceJarvisEvent, jarvisElapsedSeconds, jarvisRemainingSeconds, formatElapsed,
} from '../src/lib/jarvisStream.js';
import { nextSpeakableSegment, speechModeFor } from '../src/lib/jarvisSpeech.js';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
// Comments masked before any source assertion, so a regex cannot be satisfied by the comment that
// explains the fix, and never anchored to a lazy wildcard over the whole file (H19).
const maskComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

const chatSrc = maskComments(read('server/src/functions/chatWithJarvis.js'));
const aiSrc = maskComments(read('server/src/ai.js'));

// ── fixtures ─────────────────────────────────────────────────────────────────
const chunk = (obj) => `data: ${JSON.stringify(obj)}`;
const delta = (text) => chunk({ choices: [{ delta: { content: text }, finish_reason: null }] });

/** Feed whole lines through the reducer, the way the reader does. */
const feedAll = (lines) => lines.reduce((state, line) => reduceStreamLine(state, line), initialStreamState());

console.log('\n1. streaming is OPT IN — a caller with no `stream` field is untouched');
// Only an explicit boolean true. The asymmetry is deliberate: the cost of wrongly streaming is paid by
// every existing caller, the cost of not streaming is one caller that asked badly.
check('no field at all', wantsStreamedReply({}), false);
check('an explicit false', wantsStreamedReply({ stream: false }), false);
check('the string "true" is not a yes', wantsStreamedReply({ stream: 'true' }), false);
check('nor is 1', wantsStreamedReply({ stream: 1 }), false);
check('nor is null', wantsStreamedReply({ stream: null }), false);
check('an explicit true IS the yes', wantsStreamedReply({ stream: true }), true);
check('…even beside other fields', wantsStreamedReply({ message: 'hi', stream: true, fileUrls: [] }), true);
// The off switch must be a GATE, not a branch taken after the response has started: a non-streaming
// caller has to reach the blocking path before any header is written, or it gets NDJSON it never asked
// for and a status code it can no longer be told an error with.
check('the handler gates on it before writing anything',
  chatSrc.includes('if (!wantsStreamedReply(body) || !res || typeof res.writeHead !== \'function\') {')
    && chatSrc.includes('return runReply({ user, message, fileUrls });'), true);
check('…and the stream branch opens the response only after that gate',
  chatSrc.indexOf('return runReply({ user, message, fileUrls });') < chatSrc.indexOf('res.writeHead(200'), true);
// The blocking call itself is unchanged and still the single place a reply is asked for without a stream.
check('the blocking reply call is still the schema call on the persona role, exactly once',
  occurrences(chatSrc, "schema: REPLY_SCHEMA, role: 'planner', maxTokens: MAX_REPLY_TOKENS });"), 1);
check('…and the blocking path is the pre-existing one',
  chatSrc.includes('let { reply, truncated } = await blockingReply({ user, prompt, fileUrls });')
    && chatSrc.includes('return { reply: repairedReply.reply };'), true);
check('invokeAI\u2019s own return contract is untouched by any of this',
  aiSrc.includes('return { result: content, provider, model: resolvedModel, usage };'), true);

console.log('\n2. the SSE framing survives everything a provider can send');
check('a blank keep-alive line changes nothing', reduceStreamLine(initialStreamState(), ''), initialStreamState());
check('an SSE comment changes nothing', reduceStreamLine(initialStreamState(), ': ping'), initialStreamState());
check('an `event:` field is not ours', reduceStreamLine(initialStreamState(), 'event: message'), initialStreamState());
check('an `id:` field is not ours', reduceStreamLine(initialStreamState(), 'id: 42'), initialStreamState());
check('an empty data field is ignored', reduceStreamLine(initialStreamState(), 'data:'), initialStreamState());

const twoChunks = feedAll([delta('Hel'), delta('lo')]);
check('fragments accumulate in order', streamOutcome(twoChunks).text, 'Hello');
check('and nothing has finished yet', streamOutcome(twoChunks).complete, false);

// A malformed line is COUNTED, never fatal: the text already accumulated is real and a chat turn that is
// half-written on the operator's screen must not die because one chunk was cut in transit.
const malformed = feedAll([delta('Hel'), 'data: {"choices":[', delta('lo')]);
check('a broken JSON chunk does not throw and does not lose the text', streamOutcome(malformed).text, 'Hello');
check('…and it is counted, so an unreadable stream is visible rather than silent',
  streamOutcome(malformed).malformedLines !== undefined || malformed.malformedLines, 1);
const partial = feedAll([delta('Hel'), 'data: {"cho']);
check('a partial line is survivable too', streamOutcome(partial).text, 'Hel');
check('…and the next WHOLE line still applies', streamOutcome(feedAll([delta('Hel'), 'data: {"cho', delta('lo')])).text, 'Hello');

const terminated = feedAll([delta('Hi'), 'data: [DONE]']);
check('the [DONE] sentinel is terminal', streamOutcome(terminated).complete, true);
// A provider may end the completion with a finish_reason instead of the sentinel, and treating only one
// of the two as terminal hangs the reader on the other.
const finished = feedAll([delta('Hi'), chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] })]);
check('a finish_reason is terminal too', streamOutcome(finished).complete, true);
check('…and it is reported', streamOutcome(finished).finishReason, 'stop');

const withUsage = feedAll([
  delta('Hi'),
  chunk({ model: 'real-model-1', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 22 } }),
]);
const usageOutcome = streamOutcome(withUsage);
check('the final chunk is where usage lives, and it is kept', usageOutcome.usage, { prompt_tokens: 11, completion_tokens: 22 });
check('…along with the concrete model that served the call', usageOutcome.model, 'real-model-1');
check('a clean stop is not a truncation', usageOutcome.truncated, false);
check('but finish_reason length IS', streamOutcome(feedAll([delta('H'), chunk({ choices: [{ delta: {}, finish_reason: 'length' }] })])).truncated, true);
// The load-bearing one: a body that just stops. `complete:false` is what makes the caller fall back
// instead of storing a fragment.
const dropped = feedAll([delta('Half a sent')]);
check('a body that ends with no terminal chunk is NOT complete', streamOutcome(dropped).complete, false);
check('…and is not reported as a clean truncation either', streamOutcome(dropped).truncated, false);
check('a usage-only chunk is a legitimate no-op', reduceStreamChunk(initialStreamState(), { usage: {} }).text, '');
check('junk is refused without throwing', reduceStreamChunk(initialStreamState(), null), initialStreamState());
check('…and so is an array', reduceStreamChunk(initialStreamState(), [1, 2]), initialStreamState());

console.log('\n3. the reply is a JSON envelope, and only its prose is shown');
check('nothing is read before the key arrives', readJsonStringField('', 'reply'), { text: '', complete: false, found: false });
check('…or when the key is absent', readJsonStringField('{"other": "x"}', 'reply'), { text: '', complete: false, found: false });
check('…or when the value has not opened yet', readJsonStringField('{"reply":', 'reply'), { text: '', complete: false, found: false });
check('a half-written value reads as what it already says',
  readJsonStringField('{"reply": "The money', 'reply'), { text: 'The money', complete: false, found: true });
check('…and keeps reading as it grows',
  readJsonStringField('{"reply": "The money is', 'reply').text, 'The money is');
check('a closed value is complete',
  readJsonStringField('{"reply": "Done."}', 'reply'), { text: 'Done.', complete: true, found: true });
check('escapes are decoded, not shown raw',
  readJsonStringField('{"reply": "a\\nb\\"c"}', 'reply').text, 'a\nb"c');
check('a unicode escape is decoded', readJsonStringField('{"reply": "\\u0041"}', 'reply').text, 'A');
// An unfinished escape is HELD BACK rather than half-shown: printing a literal `\u00` and replacing it a
// moment later is worse than the fragment arriving a few milliseconds late.
check('an unfinished escape is held back', readJsonStringField('{"reply": "a\\', 'reply').text, 'a');
check('…including a partial unicode escape', readJsonStringField('{"reply": "a\\u00', 'reply').text, 'a');
check('…and the character after it is not lost once it lands',
  readJsonStringField('{"reply": "a\\u0041b"}', 'reply').text, 'aAb');
check('a different field is not confused for the reply',
  readJsonStringField('{"note": "shown", "reply": "the reply"}', 'reply').text, 'the reply');

console.log('\n4. every failure falls back — and a truncated stream stores nothing');
check('a failed stream falls back', streamReplyDecision({ ok: false }), { action: 'fallback', reason: 'stream-failed' });
// H6 through the transport: a body that ended without a terminal chunk left a FRAGMENT, and a fragment
// must never be written down as the answer. It is not "stored with a warning" — it is not stored.
check('a truncated stream falls back rather than storing its fragment',
  streamReplyDecision({ ok: true, complete: false, text: 'Half a sent' }), { action: 'fallback', reason: 'stream-truncated' });
check('…even when the fragment looks like a complete answer',
  streamReplyDecision({ ok: true, complete: false, text: 'All done.' }).action, 'fallback');
check('an empty reply falls back to the path that owns the empty-reply refusal',
  streamReplyDecision({ ok: true, complete: true, text: '   ' }), { action: 'fallback', reason: 'stream-empty' });
check('a complete reply is the one thing that is stored',
  streamReplyDecision({ ok: true, complete: true, text: 'The money is in the inbox.' }),
  { action: 'store', content: 'The money is in the inbox.' });
check('…and it is stored verbatim', streamReplyDecision({ ok: true, complete: true, text: '  spaced  ' }).content, '  spaced  ');
check('the handler acts on that decision by falling back into the SAME blocking call',
  chatSrc.includes('({ reply, truncated } = await blockingReply({ user, prompt, fileUrls }));'), true);

console.log('\n5. both transports store the same text through the same rules (#489 holds)');
// The streaming call carries the SAME shape as the blocking one: the schema that bounds the length, the
// same role, the same cap. If any of these drift, a streamed reply is a different product from a
// blocking one — which is exactly the trade this change refuses to make.
const streamCall = chatSrc.slice(chatSrc.indexOf('await invokeAIStream({'), chatSrc.indexOf('onDelta: (text) => emit'));
check('the streamed reply call is found (parser sanity)', streamCall.length > 0, true);
check('…and carries the reply schema (so the length rule applies mid-stream too)',
  streamCall.includes('schema: REPLY_SCHEMA'), true);
check('…and names the prose field, so a JSON envelope is showable as prose',
  streamCall.includes("deltaField: 'reply'"), true);
check('…and stays on the persona role', streamCall.includes("role: 'planner'"), true);
check('…and on the same token cap', streamCall.includes('maxTokens: MAX_REPLY_TOKENS'), true);
// The empty-reply refusal and the repair pass are shared, not re-implemented per transport.
check('the empty-reply refusal is one function used by both transports',
  occurrences(chatSrc, '= requireReply(reply);'), 2);
check('the repair pass is one function used by both transports',
  chatSrc.includes('repairReply({ user, reply, longForm })') && chatSrc.includes('repairReply({ user, reply, longForm, emit })'), true);
check('…and the streamed reply is measured against the budget before it is stored',
  chatSrc.includes('const repairedReply = await repairReply({ user, reply, longForm, emit });'), true);
check('both transports store the repaired reply, so the stored text cannot depend on the transport',
  occurrences(chatSrc, 'content: repairedReply.reply'), 2);
check('the size is logged once, for both transports',
  occurrences(chatSrc, 'chars=${reply.length} target=${CONVERSATIONAL_REPLY_TARGET_CHARS}'), 1);
// The long-form exemption is decided once, from the operator's own message, and reaches both transports.
check('the long-form exemption is decided once', occurrences(chatSrc, 'isLongFormRequest(message)'), 1);
check('…and is handed to the streaming transport as well',
  chatSrc.includes('streamReply({ user, prompt, fileUrls, emit, readingStartedAt, longForm })'), true);
check('the streaming transport does not re-implement the budget',
  !chatSrc.slice(chatSrc.indexOf('async function streamReply(')).includes('CONVERSATIONAL_REPLY_TARGET_CHARS'), true);

console.log('\n6. the streamed call is metered once, at the end, from the final chunk');
const streamFn = aiSrc.slice(aiSrc.indexOf('export async function invokeAIStream('));
check('the streaming call is found (parser sanity)', streamFn.length > 0, true);
check('…and asks the provider for usage, which is the only reason it can be metered at all',
  streamFn.includes('stream_options: { include_usage: true }'), true);
const feedSrc = streamFn.slice(streamFn.indexOf('const feed = (line) => {'), streamFn.indexOf('if (res.body?.getReader)'));
check('the per-fragment path is found (parser sanity)', feedSrc.length > 0, true);
// The failure this pins: recording usage per fragment would write a row of zeroes per chunk and call it
// a success, and it is exactly what "record it where the tokens arrive" looks like done wrong.
check('…and NEVER records usage per fragment', /recordUsageEvent/.test(feedSrc), false);
check('the round trip is timed for the ETA, in a bucket of its own',
  streamFn.includes('recordCallDuration(PROSE_TIMING_ROLE, Date.now() - callStartedAt);'), true);
check('a schema without a named prose field is refused rather than streamed as raw JSON',
  streamFn.includes('if (schema && !deltaField)'), true);
check('attachments are refused, so invokeAI keeps owning vision and document extraction',
  streamFn.includes('attachments are answered by the blocking invokeAI call'), true);
check('…and a provider that goes quiet is an IDLE gap, not a wall-clock cap on a long reply',
  streamFn.includes('armIdle'), true);

console.log('\n7. the client turns those events into a live state, with no browser');
const t0 = 1_000_000;
const live0 = initialJarvisLive('turn-1', t0);
check('a fresh turn has no label and no words', [live0.label, live0.text, live0.done, live0.error], [null, '', false, null]);
const liveStarted = reduceJarvisEvent(live0, { type: 'stage', stage: 'reply', status: 'start', label: 'Writing the reply', etaSeconds: 30 }, t0);
check('a stage start names the step and carries its ETA', [liveStarted.label, liveStarted.etaSeconds], ['Writing the reply', 30]);
check('…and the clock ticks from the turn, not the step', jarvisElapsedSeconds(liveStarted, t0 + 12_000), 12);
check('…with the ETA counting down against that step', jarvisRemainingSeconds(liveStarted, t0 + 12_000), 18);
check('…and nothing is claimed once it overruns',
  jarvisRemainingSeconds(liveStarted, t0 + 40_000) > 0, false);
const liveText = reduceJarvisEvent(reduceJarvisEvent(liveStarted, { type: 'delta', text: 'The ' }, t0), { type: 'delta', text: 'money.' }, t0);
check('deltas accumulate into the words so far', liveText.text, 'The money.');
// The repair pass rewrites text the operator has already read; the terminal payload is the authority and
// must replace the fragments, or the surface keeps showing words the database never stored.
const liveDone = reduceJarvisEvent(liveText, { type: 'result', data: { reply: 'The money.' } }, t0);
check('the terminal reply is what stays on screen', liveDone.text, 'The money.');
check('…and the step is over', [liveDone.done, liveDone.label], [true, null]);
const liveTrimmed = reduceJarvisEvent(liveText, { type: 'result', data: { reply: 'Money.' } }, t0);
check('a shortened (repaired) reply REPLACES the streamed draft', liveTrimmed.text, 'Money.');
const liveErr = reduceJarvisEvent(liveText, { type: 'error', message: 'Jarvis was cut off before he finished — nothing was stored. Ask again.' }, t0);
check('a terminal error ends the turn and keeps the server\u2019s own words',
  [liveErr.done, liveErr.label, liveErr.error], [true, null, 'Jarvis was cut off before he finished — nothing was stored. Ask again.']);
check('a heartbeat is not a state change', reduceJarvisEvent(liveText, { type: 'ping', elapsedMs: 5 }, t0), liveText);
check('an event from a newer server is not a crash', [reduceJarvisEvent(liveText, { type: 'future', x: 1 }, t0), reduceJarvisEvent(liveText, null, t0)], [liveText, liveText]);
check('the elapsed clock is a real number, formatted like the Morpheus chat\u2019s',
  [formatElapsed(9), formatElapsed(65), formatElapsed(-1)], ['9s', '1m 05s', '0s']);

console.log('\n8. the speech boundary — speak the first sentence, never a fragment');
// The whole point of Rob's third ask. A fragment is not speakable; a terminator followed by whitespace
// proves the sentence is finished and more text is already there.
check('a finished sentence is speakable', nextSpeakableSegment({ text: 'Hello there. How are' }).segment, 'Hello there.');
check('a half-written sentence is not', nextSpeakableSegment({ text: 'Hello the' }), { segment: '', spokenChars: 0 });
check('a terminator with nothing after it yet is still not', nextSpeakableSegment({ text: 'Hello there.' }).segment, '');
check('…because the model may still be spelling out the next word', nextSpeakableSegment({ text: 'Hello there. W' }).segment, 'Hello there.');
check('the decimal point is not a full stop', nextSpeakableSegment({ text: 'It costs 3.5 million dollars. ' }).segment, 'It costs 3.5 million dollars.');
check('a closing quote belongs to the sentence it closes', nextSpeakableSegment({ text: 'He said "stop." Then' }).segment, 'He said "stop."');
check('a question mark ends a sentence too', nextSpeakableSegment({ text: 'Really? I had' }).segment, 'Really?');
// The invariant that matters: nothing is skipped and nothing is said twice.
const reply = 'One thing. Two things! Three? Fine — the last part has no stop at all';
const spoken = [];
let cursor = 0;
for (let i = 0; i < 5; i += 1) {
  const next = nextSpeakableSegment({ spokenChars: cursor, text: reply });
  if (!next.segment) break;
  spoken.push(next.segment);
  cursor = next.spokenChars;
}
const tail = nextSpeakableSegment({ spokenChars: cursor, text: reply, done: true });
check('every word is spoken exactly once, in order',
  [...spoken, tail.segment].join(' '), reply);
check('the last unfinished sentence is spoken once the turn is over', tail.segment, 'Fine — the last part has no stop at all');
check('asking twice with the same cursor is idempotent',
  nextSpeakableSegment({ spokenChars: 0, text: reply }), nextSpeakableSegment({ spokenChars: 0, text: reply }));
check('a shorter text cannot read past its end',
  nextSpeakableSegment({ spokenChars: 900, text: 'short. ' }), { segment: '', spokenChars: 7 });
check('an empty reply is nothing to say', nextSpeakableSegment({ text: '', done: true }), { segment: '', spokenChars: 0 });
// The voice path is decided ONCE, from the server's own answer, so one reply is never half one voice:
// generateMorpheusSpeech answers `useBrowserFallback` when the account has no server-side TTS (the
// default), and an audio URL when it has.
check('a real audio URL means the configured voice',
  [speechModeFor({ data: { audioUrl: 'https://example.invalid/a.mp3' } }), speechModeFor({ audioUrl: 'x' })], ['audio', 'audio']);
check('no TTS configured means the browser\u2019s own queue',
  [speechModeFor({ data: { audioUrl: null, useBrowserFallback: true } }), speechModeFor({}), speechModeFor(undefined)], ['browser', 'browser', 'browser']);

console.log('\n9. the deck is wired to it');
const deckSrc = maskComments(read('src/pages/CommandDeck/DeckJarvis.jsx'));
const ctxSrc = maskComments(read('src/contexts/CommandDeckContext.jsx'));
const clientSrc = maskComments(read('src/api/base44Client.js'));
const voiceSrc = maskComments(read('src/hooks/useMorpheusVoice.js'));
check('the deck shows a labelled step and a live clock, not a constant phrase',
  deckSrc.includes('{jarvisSending && <JarvisLiveStatus live={jarvisLive} />}') && deckSrc.includes('{live?.label || \'Sending…\'}'), true);
check('…and renders the words as they are written', deckSrc.includes('{jarvisSending && jarvisLive?.text && ('), true);
check('the turn is streamed, not invoked',
  ctxSrc.includes("base44.functions.invokeStream(") && ctxSrc.includes('stream: true'), true);
check('…and its events are reduced by the pure reducer, not by the component',
  ctxSrc.includes('reduceJarvisEvent(live, evt)'), true);
check('…and the live state exists from the moment the message is sent, before any event arrives',
  ctxSrc.includes('setJarvisLive(initialJarvisLive(turnId));'), true);
check('the reader delivers every event, not only stages and the terminal line',
  clientSrc.includes('try { onEvent?.(evt); } catch {'), true);
check('…without changing what onStage already meant for the existing callers',
  clientSrc.includes("if (evt.type === 'stage') onStage?.(evt);"), true);
check('speech is fed the reply as it grows, and flushed when the turn ends',
  voiceSrc.includes('nextSpeakableSegment({ spokenChars: session.spokenChars, text, done: false })')
    && voiceSrc.includes('nextSpeakableSegment({ spokenChars: session.spokenChars, text, done: true })'), true);
check('…through a queue that plays one segment after another rather than cancelling the last one',
  voiceSrc.includes('const drainStream = useCallback((session) => {') && voiceSrc.includes('audio.onended = next;'), true);
check('…and the whole-message path still exists for what was not streamed',
  voiceSrc.includes('const speak = useCallback((message) => {') && deckSrc.includes('speak(last);'), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\nA streamed reply is a longer conversation with the network than one POST: more ways to fail,');
  console.log('and it fails later, after bytes have already reached the operator. Every one of those paths has');
  console.log('to end the same way — the blocking call — and a fragment must never be stored as the answer.\n');
  process.exit(1);
}
console.log('all good\n');
