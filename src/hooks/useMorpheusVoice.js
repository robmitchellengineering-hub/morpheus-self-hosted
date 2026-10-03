import { useState, useRef, useCallback, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { nextSpeakableSegment } from '@/lib/jarvisSpeech';

// Primary voice path: server-side TTS (generateMorpheusSpeech), which honours
// the user's Voice settings — defaulting to the deepest built-in voice ("storm")
// or routing to a custom engine (ElevenLabs / OpenAI / custom endpoint).
// Falls back to the browser's deepest male voice if the server call fails, so
// the play button always produces sound even offline.
//
// 2026-10-04 — STREAMED SPEECH. Rob: *"i want to see it earlier and being
// written if it can start reading behind the streamed output even better"*.
// `speak()` below still speaks a whole finished message, unchanged, and every
// existing caller keeps using it. The three functions added beside it speak a
// reply that is STILL BEING WRITTEN: `speakStreamStart` opens a session,
// `speakStreamText` is fed the reply so far on every fragment, and
// `speakStreamEnd` flushes whatever is left when the turn finishes. The
// sentence boundary — the only judgement involved — is the pure
// `nextSpeakableSegment` in src/lib/jarvisSpeech.js, so it is tested with no
// browser and no voice.
//
// Two things make this work rather than fight the browser. Segments are played
// sequentially through one small queue, so sentence two starts the moment
// sentence one finishes rather than cutting it off — which is exactly what
// calling `speak()` repeatedly would do, because it stops the current audio
// first. And the voice path is decided ONCE, from the first segment's real
// answer: server TTS if the account has it configured, the browser's own queue
// otherwise (the default — generateMorpheusSpeech answers `useBrowserFallback`
// without calling any provider), so a reply is never half one voice and half
// another.

const DEEP_VOICE_HINTS = [
  'Google US English',
  'Microsoft David',
  'Daniel',
  'Alex',
  'Rishi',
  'Guy',
  'Male'
];

function pickVoice(voices) {
  if (!voices || voices.length === 0) return null;
  const en = voices.filter(v => /^en(-US)?$/i.test(v.lang) || /en[_-]US/i.test(v.lang));
  const pool = en.length ? en : voices;
  for (const hint of DEEP_VOICE_HINTS) {
    const match = pool.find(v => v.name.toLowerCase().includes(hint.toLowerCase()));
    if (match) return match;
  }
  return pool[0];
}

// The butler voice plays at 1.3×, which is what the old base44 deck did
// (`Jarvis.jsx`: `audio.playbackRate = 1.3`). Rob, 2026-10-02: "i remeber javis
// on the base 44 app being a better experiance ... the chat was super fast". The
// voice is unchanged; it is simply delivered 30% faster, which is most of what
// that memory actually is. One constant, so it is one place to tune.
const PLAYBACK_RATE = 1.3;

/**
 * One audio element for a server-synthesised piece of speech, at the butler's speed.
 *
 * ONE place applies PLAYBACK_RATE, for the whole-message path and the streamed one alike: the 1.3× is a
 * property of the VOICE, not of which transport produced the text. A second copy of the assignment would
 * be a second speed to keep in step, and the guard that pins it (`verify-jarvis-voice.mjs`) would stop
 * being able to prove anything about the first one.
 */
function startAudio(audioUrl) {
  const audio = new Audio(audioUrl);
  audio.playbackRate = PLAYBACK_RATE;
  return audio;
}

export function useMorpheusVoice() {
  const [speakingId, setSpeakingId] = useState(null);
  const [loadingId, setLoadingId] = useState(null);
  const audioRef = useRef(null);
  const voicesRef = useRef([]);
  const utterRef = useRef(null);
  // The in-flight streamed-reply session, or null. `{ id, spokenChars, queue, playing, done, mode }` —
  // all in a ref because every fragment arrives from a network callback, where React state would be a
  // render behind the text it is speaking.
  const streamRef = useRef(null);
  // How many browser utterances the streaming session currently has queued or playing, so the session
  // knows when it is genuinely finished rather than when the last segment was handed over.
  const streamUtterancesRef = useRef(0);
  const browserSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

  const loadVoices = useCallback(() => {
    if (!browserSupported) return;
    const v = window.speechSynthesis.getVoices();
    if (v.length) voicesRef.current = v;
  }, [browserSupported]);

  useEffect(() => {
    if (!browserSupported) return;
    loadVoices();
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', loadVoices);
  }, [browserSupported, loadVoices]);

  const stop = useCallback(() => {
    streamRef.current = null;
    streamUtterancesRef.current = 0;
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.onended = null; audioRef.current.onerror = null; audioRef.current = null; }
    // A streamed reply may have several utterances queued in the browser, so this no longer waits for
    // `utterRef` to be set — cancelling an empty queue is a no-op. Stopping now also clears the loading
    // state, which used to survive a mute and leave a spinner on a bubble that would never play.
    if (browserSupported) { try { window.speechSynthesis.cancel(); } catch { /* unsupported */ } }
    utterRef.current = null;
    setSpeakingId(null);
    setLoadingId(null);
  }, [browserSupported]);

  const speakBrowser = useCallback((message) => {
    if (!browserSupported || !message?.id || !message?.content) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(message.content);
    const voice = pickVoice(voicesRef.current);
    if (voice) utter.voice = voice;
    utter.lang = 'en-US';
    utter.pitch = 0.8;
    utter.rate = 0.95;
    utter.volume = 1;
    utter.onstart = () => setSpeakingId(message.id);
    utter.onend = () => { setSpeakingId(prev => prev === message.id ? null : prev); utterRef.current = null; };
    utter.onerror = () => { setSpeakingId(prev => prev === message.id ? null : prev); utterRef.current = null; };
    utterRef.current = utter;
    setLoadingId(null);
    try { window.speechSynthesis.speak(utter); } catch {}
  }, [browserSupported]);

  const speak = useCallback((message) => {
    if (!message?.id || !message?.content) return;
    stop();
    setLoadingId(message.id);
    base44.functions.invoke('generateMorpheusSpeech', { text: message.content })
      .then((res) => {
        const audioUrl = res?.data?.audioUrl;
        if (!audioUrl) throw new Error('No audio URL returned');
        const audio = startAudio(audioUrl);
        audioRef.current = audio;
        audio.onplay = () => { setSpeakingId(message.id); setLoadingId(null); };
        audio.onended = () => { setSpeakingId(prev => prev === message.id ? null : prev); audioRef.current = null; };
        audio.onerror = () => { audioRef.current = null; setSpeakingId(prev => prev === message.id ? null : prev); setLoadingId(null); speakBrowser(message); };
        audio.play().catch(() => { audioRef.current = null; setLoadingId(null); speakBrowser(message); });
      })
      .catch(() => { setLoadingId(null); speakBrowser(message); });
  }, [stop, speakBrowser]);

  // ── the streamed reply ─────────────────────────────────────────────────────

  /**
   * One segment through the browser's OWN queue: `speechSynthesis` plays utterances strictly in the
   * order they were spoken, so no queue of our own is needed on this path — only a count, so the
   * session knows when the last one has actually finished.
   */
  const speakSegmentBrowser = useCallback((session, segment) => {
    if (!browserSupported || !segment) return;
    const utter = new SpeechSynthesisUtterance(segment);
    const voice = pickVoice(voicesRef.current);
    if (voice) utter.voice = voice;
    utter.lang = 'en-US';
    utter.pitch = 0.8;
    utter.rate = 0.95;
    utter.volume = 1;
    streamUtterancesRef.current += 1;
    const settle = () => {
      streamUtterancesRef.current = Math.max(0, streamUtterancesRef.current - 1);
      if (streamRef.current !== session) return;
      if (streamUtterancesRef.current === 0 && session.queue.length === 0 && session.done) {
        setSpeakingId(prev => (prev === session.id ? null : prev));
        streamRef.current = null;
      }
    };
    utter.onstart = () => { setSpeakingId(session.id); setLoadingId(null); };
    utter.onend = settle;
    utter.onerror = settle;
    try { window.speechSynthesis.speak(utter); } catch { settle(); }
  }, [browserSupported]);

  /**
   * Play the queue, one segment at a time. Self-referencing on purpose: each segment's end is what
   * starts the next, which is how sentence two begins the instant sentence one finishes instead of
   * cancelling it (`speak()` above stops the current audio, so calling it per sentence would leave only
   * the last one heard).
   */
  const drainStream = useCallback((session) => {
    if (!session || streamRef.current !== session) return;

    if (session.queue.length === 0) {
      if (session.done && !session.playing && streamUtterancesRef.current === 0) {
        setSpeakingId(prev => (prev === session.id ? null : prev));
        streamRef.current = null;
      }
      return;
    }
    if (session.playing) return;

    const segment = session.queue.shift();
    session.playing = true;
    const viaBrowser = () => {
      // Decided once and then held: a reply half in the configured voice and half in the browser's
      // default is worse than either. Also the path taken when the account has no server-side TTS at
      // all, which is the default and costs nothing.
      session.mode = 'browser';
      session.playing = false;
      speakSegmentBrowser(session, segment);
      drainStream(session);
    };

    base44.functions.invoke('generateMorpheusSpeech', { text: segment })
      .then((res) => {
        if (streamRef.current !== session) return;
        const audioUrl = res?.data?.audioUrl;
        if (!audioUrl) { viaBrowser(); return; }
        session.mode = 'audio';
        const audio = startAudio(audioUrl);
        audioRef.current = audio;
        const next = () => {
          if (audioRef.current === audio) audioRef.current = null;
          session.playing = false;
          drainStream(session);
        };
        audio.onplay = () => { setSpeakingId(session.id); setLoadingId(null); };
        audio.onended = next;
        audio.onerror = next;
        audio.play().catch(() => {
          // Autoplay refused, or the URL would not load: degrade THIS segment to the browser voice and
          // keep the queue moving — one bad segment must not silence the rest of the reply.
          if (audioRef.current === audio) audioRef.current = null;
          session.playing = false;
          session.mode = 'browser';
          speakSegmentBrowser(session, segment);
          drainStream(session);
        });
      })
      .catch(() => { if (streamRef.current === session) viaBrowser(); });
  }, [speakSegmentBrowser]);

  /** Open a speaking session for one streaming reply. Supersedes anything already speaking. */
  const speakStreamStart = useCallback((id) => {
    if (!id) return;
    stop();
    streamRef.current = { id, spokenChars: 0, queue: [], playing: false, done: false, mode: null };
    streamUtterancesRef.current = 0;
    setLoadingId(id);
  }, [stop]);

  /** Feed the reply SO FAR. Safe to call on every fragment — it only ever speaks each sentence once. */
  const speakStreamText = useCallback((id, text) => {
    const session = streamRef.current;
    if (!session || session.id !== id) return;
    const next = nextSpeakableSegment({ spokenChars: session.spokenChars, text, done: false });
    if (!next.segment) return;
    session.spokenChars = next.spokenChars;
    session.queue.push(next.segment);
    if (session.mode === 'browser') {
      while (session.queue.length) speakSegmentBrowser(session, session.queue.shift());
      return;
    }
    drainStream(session);
  }, [drainStream, speakSegmentBrowser]);

  /** The turn is over: speak whatever is left, even without a closing full stop, then go quiet. */
  const speakStreamEnd = useCallback((id, text) => {
    const session = streamRef.current;
    if (!session || session.id !== id) return;
    const next = nextSpeakableSegment({ spokenChars: session.spokenChars, text, done: true });
    if (next.segment) {
      session.spokenChars = next.spokenChars;
      session.queue.push(next.segment);
    }
    session.done = true;
    if (session.mode === 'browser') {
      while (session.queue.length) speakSegmentBrowser(session, session.queue.shift());
    }
    drainStream(session);
  }, [drainStream, speakSegmentBrowser]);

  return { speak, stop, speakStreamStart, speakStreamText, speakStreamEnd, speakingId, loadingId, supported: true };
}
