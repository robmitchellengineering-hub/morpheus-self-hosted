import { useState, useRef, useCallback, useEffect } from 'react';

// Picks the deepest-sounding en-US voice the device offers.
// Heuristic: prefer known deep/male voices, then any en-US male, then en-US fallback.
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

export function useMorpheusVoice() {
  const [speakingId, setSpeakingId] = useState(null);
  const [loadingId, setLoadingId] = useState(null);
  const voicesRef = useRef([]);
  const utterRef = useRef(null);
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;

  const loadVoices = useCallback(() => {
    if (!supported) return;
    const v = window.speechSynthesis.getVoices();
    if (v.length) voicesRef.current = v;
  }, [supported]);

  useEffect(() => {
    if (!supported) return;
    loadVoices();
    window.speechSynthesis.addEventListener('voiceschanged', loadVoices);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', loadVoices);
  }, [supported, loadVoices]);

  const stop = useCallback(() => {
    if (!supported) return;
    window.speechSynthesis.cancel();
    utterRef.current = null;
    setSpeakingId(null);
  }, [supported]);

  const speak = useCallback((message) => {
    if (!supported || !message?.id || !message?.content) return;
    // Cancel anything in flight (also clears the previous utterance's handlers)
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(message.content);
    const voice = pickVoice(voicesRef.current);
    if (voice) utter.voice = voice;
    utter.lang = 'en-US';
    utter.pitch = 0.8;   // deeper than default (1.0)
    utter.rate = 0.95;   // calm, measured mentor cadence
    utter.volume = 1;
    utter.onstart = () => setSpeakingId(message.id);
    utter.onend = () => { setSpeakingId(prev => prev === message.id ? null : prev); utterRef.current = null; };
    utter.onerror = () => { setSpeakingId(prev => prev === message.id ? null : prev); utterRef.current = null; };
    utterRef.current = utter;
    setLoadingId(message.id);
    // slight delay so loadingId can render before the synchronous speak
    try {
      window.speechSynthesis.speak(utter);
    } finally {
      // browser TTS is effectively instant to start; clear loading right away
      setLoadingId(null);
    }
  }, [supported]);

  return { speak, stop, speakingId, loadingId, supported };
}