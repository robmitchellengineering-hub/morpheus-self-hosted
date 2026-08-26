import { useState, useRef, useCallback, useEffect } from 'react';
import { base44 } from '@/api/base44Client';

// Primary voice path: server-side TTS (generateMorpheusSpeech), which honours
// the user's Voice settings — defaulting to the deepest built-in voice ("storm")
// or routing to a custom engine (ElevenLabs / OpenAI / custom endpoint).
// Falls back to the browser's deepest male voice if the server call fails, so
// the play button always produces sound even offline.

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
  const audioRef = useRef(null);
  const voicesRef = useRef([]);
  const utterRef = useRef(null);
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
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.onended = null; audioRef.current.onerror = null; audioRef.current = null; }
    if (utterRef.current) { window.speechSynthesis.cancel(); utterRef.current = null; }
    setSpeakingId(null);
  }, []);

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
        const audio = new Audio(audioUrl);
        audioRef.current = audio;
        audio.onplay = () => { setSpeakingId(message.id); setLoadingId(null); };
        audio.onended = () => { setSpeakingId(prev => prev === message.id ? null : prev); audioRef.current = null; };
        audio.onerror = () => { audioRef.current = null; setSpeakingId(prev => prev === message.id ? null : prev); setLoadingId(null); speakBrowser(message); };
        audio.play().catch(() => { audioRef.current = null; setLoadingId(null); speakBrowser(message); });
      })
      .catch(() => { setLoadingId(null); speakBrowser(message); });
  }, [stop, speakBrowser]);

  return { speak, stop, speakingId, loadingId, supported: true };
}