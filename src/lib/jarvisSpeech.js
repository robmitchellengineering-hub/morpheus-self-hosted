// When to start speaking, given a reply that is still being written — one pure decision.
//
// WHY THIS EXISTS (2026-10-04, Rob): *"then it can read it when its done if that easier but i want to
// see it earlier and being written if it can start reading behind the streamed output even better"*.
// The third thing he asked for, in his own order of preference, is speech that starts before the reply
// has finished. It needs exactly one piece of judgement: where does a half-written reply stop being
// safe to say? A fragment ("I've looked at your —") is not speakable; a sentence is. So the boundary is
// a complete terminator followed by whitespace, which proves more text is already there.
//
// Over-splitting is the safe direction: one extra text-to-speech call is cheap and invisible, and the
// sentences are still played in order, so the listener hears the same reply. Under-splitting is the
// failure — withholding sentence one until sentence two has landed is just the old "wait for the whole
// thing" with extra steps.
//
// The pure half of the streaming speech path, so `scripts/verify-jarvis-stream.mjs` can assert the
// boundaries with no browser, no voice and no network. `useMorpheusVoice.js` owns the playing.
//
// NOTE ON WHAT IS DELIBERATELY SIMPLE HERE: the terminator rule does not try to know that "Mr. " or
// "e.g. " is not the end of a sentence. A wrong split costs one extra pause in a butler's voice; a
// dictionary of English abbreviations costs a table nobody maintains, and Jarvis is asked for one to
// four sentences (lib/jarvisPersona.js), so the overwhelming majority of replies contain one boundary.

/** The closed punctuation that may follow a terminator and still belong to the sentence. */
const CLOSER = '["\'”’)\\]]';

/**
 * The next complete sentence in a growing reply.
 *
 * @param {{spokenChars?: number, text?: string, done?: boolean}} opts `spokenChars` is how much of
 *   `text` has already been handed to the speaker; `done` says no more text is coming.
 * @returns {{segment: string, spokenChars: number}} `segment` is '' when there is nothing speakable
 *   yet, and `spokenChars` then stays exactly where it was — so calling this on every delta is
 *   idempotent and never loses or repeats a word.
 */
export function nextSpeakableSegment({ spokenChars = 0, text = '', done = false } = {}) {
  const full = String(text ?? '');
  // Clamp: `text` can only grow, but a caller replaying a shorter string (a fallback replacing the
  // fragments with the final reply) must not read past the end.
  const from = Math.max(0, Math.min(Number.isFinite(spokenChars) ? spokenChars : 0, full.length));
  const rest = full.slice(from);
  if (!rest.trim()) return { segment: '', spokenChars: from };

  if (done) {
    // Nothing more is coming, so whatever is left is the final sentence whether or not it has a full
    // stop — a reply ending on "…and that's the lot" is still a thing to say.
    return { segment: rest.trim(), spokenChars: full.length };
  }

  // A terminator, any closing quote/bracket that belongs to it, and then whitespace — the whitespace
  // is the proof that the sentence is finished rather than still being spelled out.
  const m = new RegExp(`[.!?…]+${CLOSER}*(?=\\s)`).exec(rest);
  if (!m) return { segment: '', spokenChars: from };

  const end = m.index + m[0].length;
  const segment = rest.slice(0, end).trim();
  if (!segment) return { segment: '', spokenChars: from + end };
  return { segment, spokenChars: from + end };
}

/**
 * Which voice path a streamed reply uses, decided ONCE from the first segment's own answer and then held
 * for the whole reply — a reply half in the configured TTS voice and half in the browser's default would
 * be worse than either. `generateMorpheusSpeech` answers `{ audioUrl: null, useBrowserFallback: true }`
 * when the account has no server-side TTS configured (still the default), so this decides on the server's
 * own reply rather than on any client-side guess.
 *
 * @returns {'audio'|'browser'}
 */
export function speechModeFor(ttsResponse) {
  const audioUrl = ttsResponse?.data?.audioUrl ?? ttsResponse?.audioUrl;
  return typeof audioUrl === 'string' && audioUrl ? 'audio' : 'browser';
}
