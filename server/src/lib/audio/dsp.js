// DSP primitives for audio measurement: FFT, windows, convolution, correlation, biquads.
//
// WHY THIS EXISTS, AND WHY IT IS OURS. Every audio path in the plan — the plugin test bench, the capture rig,
// the room/PA measurement, and the quantization playground that compares bit depths — needs the same four
// things: generate a known signal, push it through something, look at what came out, and compare it with what
// went in. That is a measuring instrument, and a measuring instrument you cannot audit is a number you have to
// take on trust. It is also the only part of this plan that can be built and *proved* today: a pure sine has a
// known THD, a known biquad has an analytic frequency response, a known delay has a known latency — so every
// function here has an answer it can be checked against, with no hardware and no model.
//
// CONVENTIONS, because these are what silently make a measurement wrong:
//   * `fftInPlace` is the forward transform with a NEGATIVE exponent and NO scaling. The inverse divides by N.
//     So a forward/inverse round trip is identity, and a spectrum's magnitude is |X[k]|, not |X[k]|/N.
//   * A real sine of amplitude A and integer bin count peaks at |X| = A*N/2 after a rectangular window, and
//     at A*N/2*coherentGain(window) otherwise. Amplitude helpers below correct for that explicitly.
//   * Everything is SI-free: amplitudes are full-scale ratios (1.0 = 0 dBFS), frequencies are Hz, and dB is
//     always 20*log10 of an amplitude ratio.
//
// No dependencies, no I/O, no globals — so it runs in the guards job and in a spreadsheet-free environment.

/** The smallest power of two that is >= n. */
export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * In-place iterative radix-2 FFT. `re` and `im` must be the same power-of-two length.
 * Forward transform: negative exponent, no scaling (see the header).
 */
export function fftInPlace(re, im) {
  const n = re.length;
  if (n !== im.length) throw new Error(`fft: re/im length mismatch (${n} vs ${im.length})`);
  if (n === 0 || (n & (n - 1)) !== 0) throw new Error(`fft: length must be a power of two, got ${n}`);

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const vr = re[b] * cr - im[b] * ci;
        const vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  return { re, im };
}

/** Inverse of `fftInPlace`: conjugated forward transform, then divide by N. */
export function ifftInPlace(re, im) {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fftInPlace(re, im);
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] = -im[i] / n;
  }
  return { re, im };
}

/** Convenience: forward FFT of a real signal, zero-padded to `size` (default: next power of two). */
export function fftReal(x, size = nextPow2(x.length)) {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(x.subarray ? x.subarray(0, Math.min(x.length, size)) : x.slice(0, Math.min(x.length, size)));
  return fftInPlace(re, im);
}

// ── windows ──────────────────────────────────────────────────────────────────────────────────────────────

/** Hann window. Endpoints are zero, so it is the safe default for spectrum analysis. */
export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

/** Blackman-Harris (4-term). ~92 dB sidelobes: use when a small harmonic must be visible next to a big one. */
export function blackmanHarris(n) {
  const a = [0.35875, 0.48829, 0.14128, 0.01168];
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / (n - 1);
    w[i] = a[0] - a[1] * Math.cos(t) + a[2] * Math.cos(2 * t) - a[3] * Math.cos(3 * t);
  }
  return w;
}

/**
 * Coherent gain (mean of the window). A windowed sine's spectral peak is this factor times the rectangular
 * peak, so every amplitude measurement has to divide it out or it reads low.
 */
export function coherentGain(w) {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i];
  return s / w.length;
}

/** Named windows, so callers do not have to remember the gain correction. */
export function windowByName(name, n) {
  if (name === 'hann') return hann(n);
  if (name === 'blackman-harris') return blackmanHarris(n);
  if (name === 'rect' || name === 'rectangular') return Float64Array.from({ length: n }, () => 1);
  throw new Error(`unknown window "${name}"`);
}

// ── levels ───────────────────────────────────────────────────────────────────────────────────────────────

export const linearToDb = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
export const dbToLinear = (db) => 10 ** (db / 20);

/** Root mean square. */
export function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

/** Largest absolute sample. */
export function peak(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

/** RMS expressed in dBFS (a full-scale sine reads -3.01 dBFS, which is correct and not a bug). */
export const rmsDb = (x) => linearToDb(rms(x));

// ── convolution and correlation ──────────────────────────────────────────────────────────────────────────

/** Direct linear convolution. O(n*m) — correct, slow, and the reference the FFT path is checked against. */
export function convolveDirect(a, b) {
  const out = new Float64Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    if (ai === 0) continue;
    for (let j = 0; j < b.length; j++) out[i + j] += ai * b[j];
  }
  return out;
}

/** Linear convolution via FFT. Same result as `convolveDirect`, rounding aside. */
export function convolveFft(a, b) {
  const n = nextPow2(a.length + b.length - 1);
  const ar = new Float64Array(n); ar.set(a);
  const ai = new Float64Array(n);
  const br = new Float64Array(n); br.set(b);
  const bi = new Float64Array(n);
  fftInPlace(ar, ai);
  fftInPlace(br, bi);
  // (ar + i*ai) * (br + i*bi)
  for (let k = 0; k < n; k++) {
    const re = ar[k] * br[k] - ai[k] * bi[k];
    const im = ar[k] * bi[k] + ai[k] * br[k];
    ar[k] = re; ai[k] = im;
  }
  ifftInPlace(ar, ai);
  return ar.slice(0, a.length + b.length - 1);
}

/**
 * Linear cross-correlation via FFT: `corr[k] = Σ a[n]·b[n+k]`.
 *
 * So if `b` is `a` delayed by d samples, the peak sits at index d. Both inputs are zero-padded to twice their
 * combined length, which is what makes the correlation LINEAR — with the circular form a peak near the end of
 * the buffer wraps around and reads as a large negative lag.
 */
export function crossCorrelate(a, b) {
  const n = nextPow2(a.length + b.length - 1);
  const ar = new Float64Array(n); ar.set(a);
  const ai = new Float64Array(n);
  const br = new Float64Array(n); br.set(b);
  const bi = new Float64Array(n);
  fftInPlace(ar, ai);
  fftInPlace(br, bi);
  // conj(A) * B
  for (let k = 0; k < n; k++) {
    const re = ar[k] * br[k] + ai[k] * bi[k];
    const im = ar[k] * bi[k] - ai[k] * br[k];
    ar[k] = re; ai[k] = im;
  }
  ifftInPlace(ar, ai);
  return ar;
}

/**
 * The lag that best aligns `b` with `a`, refined below one sample by fitting a parabola to the correlation
 * peak. Sub-sample accuracy matters: a 1 ms delay at 48 kHz is 48 samples, but a plugin's reported latency is
 * usually fractional after resampling, and rounding it to a whole sample puts a residual in every null test.
 *
 * ⚠️ THE OFFSET CONVENTION WAS WRONG ONCE, and it is the kind of wrong that looks like a working tool: the
 * first version subtracted `b.length - 1` from the peak index, so a 37-sample delay reported as -4058 — a
 * plausible-looking number with the right sign for a bug and the wrong magnitude for a fact. The peak index of
 * a linear correlation IS the lag; nothing needs subtracting.
 */
export function bestLag(a, b) {
  const corr = crossCorrelate(a, b);
  const n = corr.length;
  let peakIdx = 0;
  for (let i = 1; i < n; i++) if (Math.abs(corr[i]) > Math.abs(corr[peakIdx])) peakIdx = i;
  // A negative lag (b arrives EARLIER than a) appears wrapped near the end of the padded array.
  let lag = peakIdx;
  if (lag > n / 2) lag -= n;
  const at = (i) => Math.abs(corr[((i % n) + n) % n]);
  const y0 = at(peakIdx - 1);
  const y1 = at(peakIdx);
  const y2 = at(peakIdx + 1);
  const denom = y0 - 2 * y1 + y2;
  const delta = denom === 0 ? 0 : (0.5 * (y0 - y2)) / denom;
  return { lag, fractional: lag + delta, peak: corr[peakIdx] };
}

// ── biquads (RBJ cookbook), used as reference filters for measurement ────────────────────────────────────

/**
 * Biquad coefficients in the usual {b0,b1,b2,a1,a2} form, normalised so a0 = 1.
 * Types: lowpass, highpass, bandpass, peak, lowshelf, highshelf. `gainDb` only applies to peak/shelf.
 */
export function biquadCoefficients({ type, freq, q = Math.SQRT1_2, gainDb = 0, sampleRate }) {
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  const A = 10 ** (gainDb / 40);
  let b0; let b1; let b2; let a0; let a1; let a2;
  switch (type) {
    case 'lowpass':
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'bandpass':
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'peak':
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
      break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cw + s);
      b1 = 2 * A * ((A - 1) - (A + 1) * cw);
      b2 = A * ((A + 1) - (A - 1) * cw - s);
      a0 = (A + 1) + (A - 1) * cw + s;
      a1 = -2 * ((A - 1) + (A + 1) * cw);
      a2 = (A + 1) + (A - 1) * cw - s;
      break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cw + s);
      b1 = -2 * A * ((A - 1) + (A + 1) * cw);
      b2 = A * ((A + 1) + (A - 1) * cw - s);
      a0 = (A + 1) - (A - 1) * cw + s;
      a1 = 2 * ((A - 1) - (A + 1) * cw);
      a2 = (A + 1) - (A - 1) * cw - s;
      break;
    }
    default:
      throw new Error(`unknown biquad type "${type}"`);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Apply a biquad (direct form 1). Returns a new array; the input is not modified. */
export function biquadProcess(coeffs, x) {
  const { b0, b1, b2, a1, a2 } = coeffs;
  const y = new Float64Array(x.length);
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const out = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = out;
    y[i] = out;
  }
  return y;
}

/**
 * The analytic magnitude response of a biquad at a frequency. This is what makes a measured response
 * checkable: the filter is defined by its coefficients, so the measurement has a right answer.
 */
export function biquadResponseDb(coeffs, freq, sampleRate) {
  const { b0, b1, b2, a1, a2 } = coeffs;
  const w = (2 * Math.PI * freq) / sampleRate;
  const cos1 = Math.cos(-w); const sin1 = Math.sin(-w);
  const cos2 = Math.cos(-2 * w); const sin2 = Math.sin(-2 * w);
  const numRe = b0 + b1 * cos1 + b2 * cos2;
  const numIm = b1 * sin1 + b2 * sin2;
  const denRe = 1 + a1 * cos1 + a2 * cos2;
  const denIm = a1 * sin1 + a2 * sin2;
  const num = Math.hypot(numRe, numIm);
  const den = Math.hypot(denRe, denIm);
  return linearToDb(num / den);
}

/**
 * Uniform symmetric quantization of a signal or a weight set to `bits`, with an optional explicit scale.
 *
 * THIS IS THE FPGA THREAD'S CORE OPERATION, in its simplest honest form: round to a grid, clamp to the range,
 * and keep the scale so the result can be dequantized. `scale` is the step size (1 LSB in real units); when it
 * is omitted the range is taken from the data, which is what "quantize this model to 8 bits" means in practice.
 */
export function quantize(x, bits, { scale = null, symmetric = true } = {}) {
  const levels = 2 ** bits;
  const maxAbs = peak(x);
  // q = maxAbs / (2^(bits-1) - 1) for symmetric; the asymmetric form uses the full code range.
  const step = scale ?? (symmetric ? maxAbs / (levels / 2 - 1) : (2 * maxAbs) / (levels - 1));
  const lo = symmetric ? -(levels / 2 - 1) : -Math.round((levels - 1) / 2);
  const hi = symmetric ? levels / 2 - 1 : Math.round((levels - 1) / 2);
  const q = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const code = Math.max(lo, Math.min(hi, Math.round(x[i] / step)));
    q[i] = code * step;
  }
  return { samples: q, step, bits, levels };
}

/**
 * Quantize a TENSOR of weights, with one scale per channel (or one for the whole tensor when `perChannel` is 0).
 *
 * This is the operation the whole FPGA argument rests on, and the difference from `quantize` above is the
 * SCALE: a signal can share one scale because it is bounded by full scale, while a weight tensor cannot — its
 * loudest channel would force every other channel onto a coarse grid, which is exactly what makes low bit widths
 * expensive. `perChannel` is how a caller asks for the scales that avoid it (an output row, a block of weights,
 * a whole layer — the arithmetic is the same).
 *
 * Symmetric two's complement, so the code range is [-2^(b-1)+1, 2^(b-1)-1] and no zero-point has to be added
 * back on every multiply in a fixed-point datapath.
 */
export function quantizeTensor(values, { bits, perChannel = 0 }) {
  if (!(bits >= 2 && bits <= 32)) throw new Error(`quantizeTensor: bits must be 2..32, got ${bits}`);
  const maxCode = 2 ** bits / 2 - 1;
  const codes = new Int32Array(values.length);
  const out = new Float64Array(values.length);
  const channels = perChannel > 0 ? perChannel : 1;
  if (values.length % channels !== 0) {
    throw new Error(`quantizeTensor: ${values.length} values do not divide into ${channels} channels`);
  }
  const per = values.length / channels;
  const scales = new Float64Array(channels);
  let err = 0;
  let sig = 0;
  let maxError = 0;
  for (let c = 0; c < channels; c++) {
    let maxAbs = 0;
    for (let i = c * per; i < (c + 1) * per; i++) maxAbs = Math.max(maxAbs, Math.abs(values[i]));
    // An all-zero channel has no scale; 1.0 keeps its codes at zero instead of producing a NaN scale, which
    // would then spread into every downstream comparison as NaN rather than as a failure.
    const scale = maxAbs > 0 ? maxAbs / maxCode : 1;
    scales[c] = scale;
    for (let i = c * per; i < (c + 1) * per; i++) {
      const code = Math.max(-maxCode, Math.min(maxCode, Math.round(values[i] / scale)));
      codes[i] = code;
      const back = code * scale;
      out[i] = back;
      const d = values[i] - back;
      err += d * d;
      sig += values[i] * values[i];
      maxError = Math.max(maxError, Math.abs(d));
    }
  }
  return {
    codes,
    scales,
    perChannel: channels > 1,
    values: out,
    sqnrDb: err === 0 ? Infinity : 10 * Math.log10(sig / err),
    maxError,
    bits,
  };
}

/** Signal-to-quantization-noise ratio in dB, for a quantized copy of `x`. */
export function sqnrDb(original, quantized) {
  let sig = 0;
  let err = 0;
  for (let i = 0; i < original.length; i++) {
    sig += original[i] * original[i];
    const d = original[i] - quantized[i];
    err += d * d;
  }
  return err === 0 ? Infinity : 10 * Math.log10(sig / err);
}
