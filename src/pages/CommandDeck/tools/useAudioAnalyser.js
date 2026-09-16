import { useCallback, useEffect, useRef, useState } from 'react';

const FFT_SIZE = 2048;
const MIN_FREQ = 20;
const MAX_FREQ = 20000;

// Drives the Audio analyser card: mic access, an AnalyserNode reading
// frequency-domain data each frame (getByteFrequencyData, 0-255 per bin),
// a live peak-bin readout, a held-until-reset peak, and a log-frequency
// waterfall painted directly onto a caller-owned canvas — same
// mic/AudioContext lifecycle shape as useTuner.js's time-domain version.
export function useAudioAnalyser() {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState(null);
  const [live, setLive] = useState(null); // { freq, level } — level is a 0-100 relative reading, not calibrated dB SPL
  const [peak, setPeak] = useState(null); // { freq, level }, held until resetPeak()

  const audioCtxRef = useRef(null);
  const streamRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);
  const dataRef = useRef(null);
  const canvasRef = useRef(null);
  const peakRef = useRef(null);

  const tick = useCallback(() => {
    const analyser = analyserRef.current;
    const data = dataRef.current;
    if (!analyser || !data || !audioCtxRef.current) return;
    analyser.getByteFrequencyData(data);

    const binHz = audioCtxRef.current.sampleRate / (2 * data.length);
    const minBin = Math.max(1, Math.floor(MIN_FREQ / binHz));
    const maxBin = Math.min(data.length - 1, Math.ceil(MAX_FREQ / binHz));

    let maxVal = 0;
    let maxBinIdx = minBin;
    for (let i = minBin; i <= maxBin; i++) {
      if (data[i] > maxVal) { maxVal = data[i]; maxBinIdx = i; }
    }
    const freq = Math.round(maxBinIdx * binHz);
    const level = Math.round((maxVal / 255) * 100);

    if (maxVal > 4) {
      setLive({ freq, level });
      if (!peakRef.current || level > peakRef.current.level) {
        peakRef.current = { freq, level };
        setPeak(peakRef.current);
      }
    } else {
      setLive(null);
    }

    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      const w = canvas.width;
      const h = canvas.height;
      // Scroll the existing waterfall up by one row, then paint a fresh row
      // at the bottom — classic scrolling-spectrogram construction.
      const img = ctx.getImageData(0, 1, w, h - 1);
      ctx.putImageData(img, 0, 0);
      const logMin = Math.log10(MIN_FREQ);
      const logMax = Math.log10(MAX_FREQ);
      for (let x = 0; x < w; x++) {
        const frac = x / (w - 1);
        const f = Math.pow(10, logMin + frac * (logMax - logMin));
        const bin = Math.min(data.length - 1, Math.round(f / binHz));
        const v = data[bin];
        const pct = v / 255;
        // Walnut/brass-toned heat map instead of a generic rainbow, so it
        // reads as part of this theme rather than a stock analyser widget.
        const hue = 32; // brass hue
        const light = 6 + pct * 46;
        const sat = 20 + pct * 60;
        ctx.fillStyle = `hsl(${hue}, ${sat}%, ${light}%)`;
        ctx.fillRect(x, h - 1, 1, 1);
      }
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
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      analyserRef.current = analyser;
      dataRef.current = new Uint8Array(analyser.frequencyBinCount);
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
    setLive(null);
  }, []);

  const resetPeak = useCallback(() => {
    peakRef.current = null;
    setPeak(null);
  }, []);

  // Release the mic/audio context if the card unmounts while still listening.
  useEffect(() => () => stop(), [stop]);

  return { listening, error, live, peak, canvasRef, start, stop, resetPeak };
}
