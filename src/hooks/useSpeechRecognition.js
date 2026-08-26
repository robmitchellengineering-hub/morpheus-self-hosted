import { useState, useEffect, useRef, useCallback } from 'react';

export function useSpeechRecognition({ onResult, lang = 'en-US' } = {}) {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);
  const onResultRef = useRef(onResult);

  useEffect(() => { onResultRef.current = onResult; }, [onResult]);

  const supported = typeof window !== 'undefined' &&
    (window.SpeechRecognition || window.webkitSpeechRecognition);

  useEffect(() => {
    if (!supported) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = lang;

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      if (onResultRef.current) onResultRef.current(transcript);
    };
    recognition.onerror = () => { setListening(false); };
    recognition.onend = () => { setListening(false); };

    recognitionRef.current = recognition;
    return () => { try { recognition.abort(); } catch (e) {} };
  }, [supported, lang]);

  const start = useCallback(() => {
    if (!recognitionRef.current) return;
    try { recognitionRef.current.start(); setListening(true); } catch (e) {}
  }, []);

  const stop = useCallback(() => {
    if (!recognitionRef.current) return;
    try { recognitionRef.current.stop(); } catch (e) {}
    setListening(false);
  }, []);

  return { listening, start, stop, supported };
}