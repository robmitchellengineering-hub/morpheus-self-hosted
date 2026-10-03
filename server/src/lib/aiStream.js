// What an OpenAI-compatible STREAMING response is, and what it means once the last chunk has landed.
//
// WHY THIS EXISTS (2026-10-04, Rob): *"it doesnt look like its doing anything but i thought we were
// trying to get it to instantly start streaming the output ... i want to see it earlier and being
// written"*. `invokeAI` blocks until the provider has finished the whole completion and hands back one
// JSON body, so nothing at all can be shown while it runs — for the Jarvis reply that is up to a minute
// of a blank bubble. `ai.js` now has an additive `invokeAIStream` beside it; this module is the part of
// that which DECIDES rather than talks to the network, so it can be tested with no model, no key and no
// browser — `scripts/verify-jarvis-stream.mjs`.
//
// THE WIRE FORMAT. Server-sent events, one `data: {...}` line per chunk, terminated by `data: [DONE]`
// (OpenAI, and everything that copies it, including this deployment's DeepSeek endpoint). Each chunk
// carries a `choices[0].delta.content` fragment; only the FINAL chunk carries `choices[0].finish_reason`
// and — when `stream_options: { include_usage: true }` was requested — the `usage` object. That last
// fact is the whole reason a streamed call can still be metered honestly: the token counts do not
// dribble out per chunk, they arrive once, at the end, and this module's accumulator is what holds them
// until then.
//
// WHAT THIS MODULE WILL NOT DO: throw. A provider can send a comment line, a bare newline, a truncated
// JSON payload, a `retry:` hint, or a chunk shape nobody documented. None of those may kill a chat turn
// that is already half written on the operator's screen, so every one of them is either ignored or
// COUNTED (`malformedLines`) and the stream carries on. That count is the honest record that something
// arrived which this module did not understand.
//
// Pure and import-free, on purpose: it is read by `ai.js` at runtime and by a CI guard, and the guards
// job runs with no `npm install` (see scripts/verify-guards-no-install.mjs).

/** A fresh accumulator. One per streamed call; never shared between calls. */
export function initialStreamState() {
  return {
    text: '',
    finishReason: null,
    usage: null,
    model: null,
    // Terminal, from either signal the provider may use: a `data: [DONE]` sentinel, or a chunk
    // carrying a finish_reason. They are the two ways this format says "that is the whole answer",
    // and treating only one of them as terminal hangs the reader on providers that send the other.
    done: false,
    malformedLines: 0,
  };
}

/**
 * One SSE line → the next state. `line` is whatever the reader split on `\n`; it may be a fragment of
 * a chunk if the caller is feeding a buffer naively, which is exactly why this never throws.
 */
export function reduceStreamLine(state, line) {
  const s = state || initialStreamState();
  const trimmed = String(line ?? '').trim();
  // Blank keep-alive, an SSE comment (`: ping`), and the `event:` / `id:` / `retry:` fields are all
  // real parts of the format that carry none of the answer.
  if (!trimmed || trimmed.startsWith(':')) return s;
  if (!trimmed.startsWith('data:')) return s;
  const payload = trimmed.slice(5).trim();
  if (!payload) return s;
  if (payload === '[DONE]') return { ...s, done: true };

  let chunk;
  try {
    chunk = JSON.parse(payload);
  } catch {
    // Half a JSON object — a provider that closed mid-chunk, or a caller that split on something
    // other than a line boundary. Counted, never fatal: the text already accumulated is still real.
    return { ...s, malformedLines: s.malformedLines + 1 };
  }
  return reduceStreamChunk(s, chunk);
}

/**
 * One decoded chunk → the next state. A chunk with nothing recognizable in it is a legitimate no-op
 * (many providers open with a role-only delta and close with a usage-only one).
 */
export function reduceStreamChunk(state, chunk) {
  const s = state || initialStreamState();
  if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) return s;

  const next = { ...s };
  // The response's own `model` names the concrete model that served the call even when the request
  // asked for an alias — the same reason invokeAI reads `data.model` rather than the request's.
  if (typeof chunk.model === 'string' && chunk.model) next.model = chunk.model;

  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  if (choice && typeof choice === 'object') {
    const delta = choice.delta || choice.message || null;
    if (delta && typeof delta.content === 'string' && delta.content) next.text = s.text + delta.content;
    if (choice.finish_reason) next.finishReason = choice.finish_reason;
  }

  if (chunk.usage && typeof chunk.usage === 'object') next.usage = chunk.usage;

  // A finish_reason IS the end of the completion, whether or not the provider also sends `[DONE]`.
  if (next.finishReason) next.done = true;
  return next;
}

/**
 * What actually arrived, once the body has ended. `complete` is the load-bearing field: a stream that
 * ended without either terminal signal is a TRUNCATED reply — the reader closing on a dropped
 * connection, a provider that never flushed its last chunk — and what is in `text` is a fragment.
 * Nothing may treat that fragment as the answer.
 */
export function streamOutcome(state) {
  const s = state || initialStreamState();
  const text = typeof s.text === 'string' ? s.text : '';
  return {
    text,
    finishReason: s.finishReason || null,
    usage: s.usage || null,
    model: s.model || null,
    complete: s.done === true,
    // A clean finish that hit the provider's ceiling. Different from `complete: false` — the answer
    // ended, it is just not all of it — and the caller is told which of the two happened.
    truncated: s.done === true && s.finishReason === 'length',
    empty: text.trim() === '',
  };
}

/**
 * The value of one string field in a JSON object that is STILL BEING STREAMED.
 *
 * WHY THIS IS NEEDED AT ALL (2026-10-04). Jarvis's reply is not bare prose any more: it is a
 * `{ reply: string }` schema call, because that is how the length rule is enforced (PR #489,
 * lib/jarvisReplyBudget.js). A streamed schema call sends the reply as JSON — `{"reply": "The ` first,
 * `money is…"}` later — so the fragments cannot be shown to anyone as they are without putting braces
 * and escapes on the operator's screen. This reads the current text of one field out of the
 * accumulator's raw JSON without waiting for it to close, which is what lets the streaming and the
 * length fix coexist instead of trading against each other.
 *
 * It is careful about exactly one thing: an unfinished escape. `\` and `\u00` are held back until the
 * character they are part of has fully arrived, because showing a literal `\u00` and then replacing it
 * is worse than a fragment arriving a few milliseconds later. A value that has not started yet (the key
 * has not been seen) reads as an empty string; a value that has closed reads as `complete: true`.
 *
 * Pure, never throws, and tolerant of a truncated envelope — that is the normal state of a stream
 * mid-flight, not an error.
 *
 * @param {string} raw the JSON text accumulated so far
 * @param {string} field the property name whose string value is wanted
 * @returns {{text: string, complete: boolean, found: boolean}}
 */
export function readJsonStringField(raw, field) {
  const text = String(raw ?? '');
  const empty = { text: '', complete: false, found: false };
  if (!field) return empty;

  const keyAt = text.indexOf(`"${field}"`);
  if (keyAt < 0) return empty;

  let i = keyAt + field.length + 2;
  const skipSpace = () => { while (i < text.length && /\s/.test(text[i])) i += 1; };
  skipSpace();
  if (text[i] !== ':') return empty;
  i += 1;
  skipSpace();
  if (text[i] !== '"') return empty;
  i += 1;

  let out = '';
  while (i < text.length) {
    const c = text[i];
    if (c === '"') return { text: out, complete: true, found: true };
    if (c !== '\\') { out += c; i += 1; continue; }
    // An escape: the character after the backslash is part of the value, so if it has not arrived the
    // whole escape is held back rather than half-shown.
    if (i + 1 >= text.length) break;
    const e = text[i + 1];
    if (e === 'n') { out += '\n'; i += 2; }
    else if (e === 't') { out += '\t'; i += 2; }
    else if (e === 'r') { out += '\r'; i += 2; }
    else if (e === 'b') { out += '\b'; i += 2; }
    else if (e === 'f') { out += '\f'; i += 2; }
    else if (e === 'u') {
      const hex = text.slice(i + 2, i + 6);
      if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) break; // partial \u escape — hold it back
      out += String.fromCharCode(parseInt(hex, 16));
      i += 6;
    } else { out += e; i += 2; } // \" \\ \/ and anything unrecognized
  }
  return { text: out, complete: false, found: true };
}
