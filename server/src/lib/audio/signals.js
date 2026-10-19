// Test signals — the known input every measurement is a comparison against.
//
// The rule that shapes this file: a measurement is only as good as the input's known answer. A sine has an
// exact THD of zero, a two-tone has computable intermodulation products, a sweep has energy at every
// frequency at once, and an impulse *is* the impulse response. So these are boring on purpose, and each one
// carries the property that makes it checkable.
//
// Everything here returns Float64Array in full-scale units (1.0 = 0 dBFS) and is deterministic — the noise
// generator is seeded, so a report is reproducible months later.

/** A single sine. `freq` in Hz, amplitude as a full-scale ratio. */
export function sine({ freq, sampleRate, seconds, amplitude = 1, phase = 0, length = null }) {
  const n = length ?? Math.round(seconds * sampleRate);
  const out = new Float64Array(n);
  const w = (2 * Math.PI * freq) / sampleRate;
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin(w * i + phase);
  return out;
}

/**
 * A sine whose frequency is exactly `bin * sampleRate / fftSize`, so it fills an integer number of cycles in
 * that window and has no spectral leakage with a rectangular window. `bin` may be fractional, which is how a
 * caller deliberately creates a *known* leakage case.
 */
export function coherentSineOfLength({ bin, fftSize, sampleRate, amplitude = 1, phase = 0 }) {
  const freq = (bin * sampleRate) / fftSize;
  return { freq, samples: sine({ freq, sampleRate, length: fftSize, amplitude, phase }) };
}

/** Two sines for intermodulation tests, in the SMPTE 4:1 amplitude ratio by default. */
export function twoTone({ f1 = 60, f2 = 7000, sampleRate, seconds, amplitude = 1, ratio = 4, length = null }) {
  const n = length ?? Math.round(seconds * sampleRate);
  const out = new Float64Array(n);
  const w1 = (2 * Math.PI * f1) / sampleRate;
  const w2 = (2 * Math.PI * f2) / sampleRate;
  // Normalised so the SUM peaks at `amplitude`, not each partial: 1/(1 + 1/ratio) for the big one.
  const a2 = amplitude * (ratio / (ratio + 1));
  const a1 = amplitude * (1 / (ratio + 1));
  for (let i = 0; i < n; i++) out[i] = a1 * Math.sin(w1 * i) + a2 * Math.sin(w2 * i);
  return out;
}

/**
 * Exponential (Farina) sweep from f1 to f2. Its virtue for measuring rooms, speakers and pedals is that it
 * puts energy at every frequency for the whole duration — so the measurement has a high signal-to-noise ratio
 * even when the room is noisy — and its harmonic distortion products arrive *before* the linear response, so
 * they can be separated out.
 */
export function logSweep({ f1 = 20, f2 = 20000, sampleRate, seconds, amplitude = 1 }) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float64Array(n);
  const k = Math.log(f2 / f1);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const phase = ((2 * Math.PI * f1 * seconds) / k) * (Math.exp((t * k) / seconds) - 1);
    out[i] = amplitude * Math.sin(phase);
  }
  return out;
}

/** A perfect impulse: the input whose response IS the system's impulse response. */
export function impulse({ length, index = 0, amplitude = 1 }) {
  const out = new Float64Array(length);
  out[index] = amplitude;
  return out;
}

/** Deterministic white noise (mulberry32), so the same seed gives the same report forever. */
export function whiteNoise({ length, seed = 1, amplitude = 1 }) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = new Float64Array(length);
  for (let i = 0; i < length; i++) out[i] = amplitude * (next() * 2 - 1);
  return out;
}

/** Digital silence — for measuring noise floors. */
export const silence = (length) => new Float64Array(length);

/** A DC offset. */
export function dc({ length, value = 1 }) {
  const out = new Float64Array(length);
  out.fill(value);
  return out;
}

/** A step — useful for checking a filter's transient behaviour and for click/pop tests. */
export function step({ length, index = 0, amplitude = 1 }) {
  const out = new Float64Array(length);
  for (let i = index; i < length; i++) out[i] = amplitude;
  return out;
}

/**
 * A click train at a known rate, for testing declick/restoration tools (and for deliberately provoking them).
 */
export function clicks({ length, period, amplitude = 1, width = 1 }) {
  const out = new Float64Array(length);
  for (let i = 0; i + width <= length; i += period) {
    for (let k = 0; k < width; k++) out[i + k] = amplitude;
  }
  return out;
}

/** Multiply a signal by a raised-cosine fade at both ends, to avoid clicks when a buffer loops. */
export function withFades(x, { samples = 64 }) {
  const out = Float64Array.from(x);
  const n = out.length;
  const f = Math.min(samples, Math.floor(n / 2));
  for (let i = 0; i < f; i++) {
    const g = 0.5 * (1 - Math.cos((Math.PI * i) / f));
    out[i] *= g;
    out[n - 1 - i] *= g;
  }
  return out;
}
