// Real-time pitch detection — the standard autocorrelation technique used
// by most browser-based guitar tuners (trim to the loudest contiguous
// region, autocorrelate, parabolic-interpolate the peak for sub-sample
// accuracy). No external library — this is the whole implementation.

export const NOTE_STRINGS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

// Returns the fundamental frequency (Hz) of a time-domain audio buffer, or
// -1 if the signal is too quiet to read reliably.
export function autoCorrelate(buf, sampleRate) {
  const SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return -1; // too quiet — no clear signal to lock onto

  // Trim leading/trailing near-silence so the autocorrelation window is
  // centered on real signal, not the buffer's dead edges.
  const thres = 0.2;
  let r1 = 0;
  let r2 = SIZE - 1;
  for (let i = 0; i < SIZE / 2; i++) {
    if (Math.abs(buf[i]) < thres) { r1 = i; break; }
  }
  for (let i = 1; i < SIZE / 2; i++) {
    if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }
  }
  const trimmed = buf.slice(r1, r2);
  const newSize = trimmed.length;
  if (newSize < 2) return -1;

  const c = new Array(newSize).fill(0);
  for (let i = 0; i < newSize; i++) {
    for (let j = 0; j < newSize - i; j++) {
      c[i] += trimmed[j] * trimmed[j + i];
    }
  }

  let d = 0;
  while (d < newSize - 1 && c[d] > c[d + 1]) d++;

  let maxval = -1;
  let maxpos = -1;
  for (let i = d; i < newSize; i++) {
    if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
  }
  if (maxpos <= 0) return -1;

  // Parabolic interpolation around the peak for a sub-sample-accurate period.
  let T0 = maxpos;
  const x1 = c[T0 - 1] ?? c[T0];
  const x2 = c[T0];
  const x3 = c[T0 + 1] ?? c[T0];
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  if (a) T0 = T0 - b / (2 * a);

  if (T0 <= 0) return -1;
  return sampleRate / T0;
}

// MIDI-style note number, using a4 (Hz) as the reference for A4 instead of
// always assuming 440 — lets the tuner support A440/A432.
export function noteFromPitch(frequency, a4 = 440) {
  return Math.round(12 * (Math.log(frequency / a4) / Math.log(2))) + 69;
}

export function frequencyFromNote(note, a4 = 440) {
  return a4 * Math.pow(2, (note - 69) / 12);
}

export function centsOffFromPitch(frequency, targetFrequency) {
  return Math.floor((1200 * Math.log(frequency / targetFrequency)) / Math.log(2));
}

export function noteName(midiNote) {
  const name = NOTE_STRINGS[((midiNote % 12) + 12) % 12];
  const octave = Math.floor(midiNote / 12) - 1;
  return `${name}${octave}`;
}
