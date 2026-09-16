import { useCallback, useEffect, useRef, useState } from 'react';
import { autoCorrelate, noteFromPitch, centsOffFromPitch, frequencyFromNote, noteName } from './pitch';

// Drives the guitar tuner card: mic access, an AnalyserNode, and a
// requestAnimationFrame loop running autoCorrelate() on each frame.
export function useTuner(a4) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState(null);
  const [reading, setReading] = useState(null); // { frequency, note, cents }

  const audioCtxRef = useRef(null);
  const streamRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);
  const bufRef = useRef(null);
  const a4Ref = useRef(a4);
  useEffect(() => { a4Ref.current = a4; }, [a4]);

  const tick = useCallback(() => {
    const analyser = analyserRef.current;
    const buf = bufRef.current;
    if (!analyser || !buf) return;
    analyser.getFloatTimeDomainData(buf);
    const frequency = autoCorrelate(buf, audioCtxRef.current.sampleRate);
    if (frequency !== -1 && frequency > 0) {
      const midi = noteFromPitch(frequency, a4Ref.current);
      const target = frequencyFromNote(midi, a4Ref.current);
      setReading({ frequency, note: noteName(midi), cents: centsOffFromPitch(frequency, target) });
    }
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioContextClass();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      analyserRef.current = analyser;
      bufRef.current = new Float32Array(analyser.fftSize);
      setListening(true);
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      setError("Couldn't access the microphone — check the browser's permission prompt.");
    }
  }, [tick]);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    streamRef.current = null;
    analyserRef.current = null;
    rafRef.current = null;
    setListening(false);
    setReading(null);
  }, []);

  // Release the mic/audio context if the tuner card unmounts (e.g. the user
  // switches tabs) while still listening.
  useEffect(() => () => stop(), [stop]);

  return { listening, error, reading, start, stop };
}
