// The measurements: spectrum, harmonic distortion, intermodulation, latency, null depth, frequency response,
// aliasing — plus the two primitives they share (a fractional delay and an exact DTFT evaluation).
//
// WHAT MAKES THESE TRUSTWORTHY, and it is the whole reason this module exists before any hardware does: every
// function here has an answer it can be checked against. A pure sine's THD is zero. A clipped sine's THD is
// computable. A known biquad's response is analytic. A signal delayed by 37 samples has a latency of 37. A
// signal minus itself is -infinity dB. The guard asserts exactly those, so a change that breaks the maths
// fails the build rather than quietly changing a number a user is about to make a decision on.
//
// ⚠️ TWO THINGS THIS DELIBERATELY DOES NOT DO YET, because a meter that lies is worse than no meter:
//   * LUFS (ITU-R BS.1770). It needs the K-weighting filter redesigned per sample rate, and getting it subtly
//     wrong produces a plausible number. It is not here until it can be asserted against the standard's own
//     test vectors.
//   * Perceptual weighting of any kind. These are physical measurements, and they say so.
import {
  bestLag, coherentGain, dbToLinear, fftInPlace, ifftInPlace, linearToDb, nextPow2, rms, windowByName,
} from './dsp.js';

const AMP_FLOOR = 1e-12; // -240 dBFS: below this, report silence rather than -Infinity arithmetic

/** Amplitude spectrum of a real signal: `{ freqs, amp, db, binHz }`, one-sided, amplitude-corrected. */
export function spectrum(x, { sampleRate, window = 'hann', size = null } = {}) {
  const n = size ?? nextPow2(x.length);
  const w = windowByName(window, Math.min(x.length, n));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const gain = coherentGain(w);
  for (let i = 0; i < Math.min(x.length, n); i++) re[i] = x[i] * w[i];
  fftInPlace(re, im);
  const half = n / 2;
  const freqs = new Float64Array(half + 1);
  const amp = new Float64Array(half + 1);
  const db = new Float64Array(half + 1);
  const binHz = sampleRate / n;
  for (let k = 0; k <= half; k++) {
    freqs[k] = k * binHz;
    // One-sided amplitude: double everything except DC and Nyquist, and undo the window's coherent gain.
    const scale = (k === 0 || k === half ? 1 : 2) / (n * gain);
    amp[k] = Math.hypot(re[k], im[k]) * scale;
    db[k] = linearToDb(Math.max(amp[k], AMP_FLOOR));
  }
  return { freqs, amp, db, binHz, size: n, window, coherentGain: gain };
}

/** Peak bin of a signal, refined by parabolic interpolation on the log magnitudes. */
export function peakFrequency(x, { sampleRate, window = 'hann', size = null } = {}) {
  const s = spectrum(x, { sampleRate, window, size });
  let k = 0;
  for (let i = 1; i < s.db.length - 1; i++) if (s.db[i] > s.db[k]) k = i;
  const y0 = s.db[k - 1] ?? s.db[k];
  const y1 = s.db[k];
  const y2 = s.db[k + 1] ?? s.db[k];
  const denom = y0 - 2 * y1 + y2;
  const delta = denom === 0 ? 0 : (0.5 * (y0 - y2)) / denom;
  return { freq: (k + delta) * s.binHz, db: y1, bin: k, spectrum: s };
}

/** Amplitude at a frequency, by exact DTFT evaluation (no bin quantization: 20 Hz is not a bin at 48 kHz). */
export function dtftAmplitudeDb(x, freq, sampleRate) {
  const w = (2 * Math.PI * freq) / sampleRate;
  let re = 0;
  let im = 0;
  for (let i = 0; i < x.length; i++) {
    re += x[i] * Math.cos(w * i);
    im -= x[i] * Math.sin(w * i);
  }
  return linearToDb(Math.max((2 * Math.hypot(re, im)) / x.length, AMP_FLOOR));
}

/**
 * Magnitude of the TRANSFER FUNCTION at a frequency — `|Σ x[n]·e^{-jwn}|`, with NO amplitude normalisation.
 *
 * ⚠️ THIS IS NOT `dtftAmplitudeDb` AND THE DIFFERENCE IS 20·log10(N/2) dB. That routine normalises by the
 * transform length because it is reading the amplitude of a tone inside the signal; this one does not, because
 * an impulse response is not a tone and `Σ x[n]e^{-jwn}` IS the transfer function. Using the tone version here
 * made every measured response exactly 72.2 dB low on an 8192-tap IR — which the guard caught as a
 * measured-versus-analytic mismatch, and which would otherwise have read as "this filter is broken".
 */
export function dtftMagnitudeDb(x, freq, sampleRate) {
  const w = (2 * Math.PI * freq) / sampleRate;
  let re = 0;
  let im = 0;
  for (let i = 0; i < x.length; i++) {
    re += x[i] * Math.cos(w * i);
    im -= x[i] * Math.sin(w * i);
  }
  return linearToDb(Math.max(Math.hypot(re, im), AMP_FLOOR));
}

/**
 * Refine a tone's frequency to well under a bin, by iterating a parabolic fit on the DTFT magnitude.
 *
 * ⚠️ WHY THIS IS NOT PEDANTRY: removing a fundamental to measure what is LEFT of it requires the exact
 * frequency. An estimate that is 0.02 Hz out drifts 0.04 cycles over two seconds, and a least-squares removal at
 * the wrong frequency leaves a residue of a few percent — which reads as THD+N ≈ -40 dB on a signal whose real
 * distortion is -106 dB. (It did exactly that, on a file the guard's in-memory case could not catch, because a
 * coherent in-memory sine happens to interpolate perfectly.) The whole signal is evaluated, so a shorter or
 * noisier one simply converges to the best fit rather than failing.
 */
export function refineFrequency(x, guess, sampleRate, { maxCorrection = null } = {}) {
  const half = Math.floor(x.length / 2);
  if (half < 16) return guess;
  const project = (freq, from, to) => {
    const w = (2 * Math.PI * freq) / sampleRate;
    let re = 0;
    let im = 0;
    for (let i = from; i < to; i++) {
      re += x[i] * Math.cos(w * i);
      im -= x[i] * Math.sin(w * i);
    }
    return { re, im };
  };
  // THE PHASE SLOPE, NOT THE PEAK. Maximising the magnitude cannot locate a tone's frequency to better than the
  // width of its own spectral lobe — and that lobe is `sampleRate/length` wide (0.5 Hz for two seconds at
  // 48 kHz), flat to fifteen digits across the middle. It converged to a fixed point 3.8e-5 Hz off, which left
  // -77 dB of the tone behind after "removing" it. Phase is the opposite: measure the tone's phase over the
  // first half and the second half and the difference IS the frequency error — δ = Δφ / (2π·T_half). On a tone
  // that is exactly 1000 Hz it returns 1000 Hz to 1e-16 and the residual falls to the arithmetic floor.
  const first = project(guess, 0, half);
  const second = project(guess, half, x.length);
  let dphi = Math.atan2(second.im, second.re) - Math.atan2(first.im, first.re);
  while (dphi > Math.PI) dphi -= 2 * Math.PI;
  while (dphi < -Math.PI) dphi += 2 * Math.PI;
  const delta = dphi / (2 * Math.PI * (half / sampleRate));
  // Clamped to half a bin: past that the phase has wrapped and the estimate is no longer trustworthy, and a
  // caller's guess was too far out for this method to be the right one.
  const limit = maxCorrection ?? sampleRate / x.length / 2;
  return guess + Math.max(-limit, Math.min(limit, delta));
}

/** RMS of the largest harmonic-free residual: what is left of `x` after removing `fundamental`. */
function residualAfter(x, sampleRate, fundamental, { notches = 4 } = {}) {
  let re = 0;
  let im = 0;
  const w = (2 * Math.PI * fundamental) / sampleRate;
  for (let i = 0; i < x.length; i++) {
    re += x[i] * Math.cos(w * i);
    im -= x[i] * Math.sin(w * i);
  }
  const a = (2 * re) / x.length;
  const b = (-2 * im) / x.length;
  const out = new Float64Array(x.length);
  // x = a·cos(wn) + b·sin(wn): the SIGN of the sine term is the whole reconstruction. Getting it wrong does not
  // look like a bug — it doubles the signal, so THD+N reads +6.02 dB for a perfect sine, which is the value the
  // guard caught.
  for (let i = 0; i < x.length; i++) out[i] = x[i] - (a * Math.cos(w * i) + b * Math.sin(w * i));
  void notches;
  return out;
}

/**
 * Total harmonic distortion of a sine, as a ratio and in dB, with each harmonic's level.
 *
 * The harmonic levels are read from an exact DTFT at k*f0 rather than from FFT bins, because a fundamental
 * that does not land on a bin leaks energy into its neighbours — which would be counted as distortion, and is
 * precisely the input that makes a plugin look bad when it is fine.
 */
export function thd(x, { sampleRate, fundamental, harmonics = 10, window = 'rect' } = {}) {
  const s = spectrum(x, { sampleRate, window });
  const peak = peakFrequency(x, { sampleRate, window });
  const f0 = refineFrequency(x, fundamental ?? peak.freq, sampleRate);
  const f0Db = dtftAmplitudeDb(x, f0, sampleRate);
  const f0Amp = dbToLinear(f0Db);
  const list = [];
  let sumSq = 0;
  for (let k = 2; k <= harmonics; k++) {
    const freq = k * f0;
    if (freq >= sampleRate / 2) break;
    const db = dtftAmplitudeDb(x, freq, sampleRate);
    const amp = dbToLinear(db);
    sumSq += amp * amp;
    list.push({ order: k, freq, db, dbRel: db - f0Db });
  }
  const thdRatio = f0Amp > 0 ? Math.sqrt(sumSq) / f0Amp : 0;
  void s;
  return {
    fundamental: f0,
    fundamentalDb: f0Db,
    thdRatio,
    thdPercent: thdRatio * 100,
    thdDb: linearToDb(thdRatio),
    harmonics: list,
  };
}

/**
 * THD+N: everything that is not the fundamental, relative to it. This is the number a plugin's "cleanliness"
 * is usually judged on, and it includes noise — which is why it is reported separately from THD.
 */
export function thdPlusNoise(x, { sampleRate, fundamental, window = 'hann' } = {}) {
  const peak = peakFrequency(x, { sampleRate, window });
  // The refined frequency is what makes the removal actually remove; see `refineFrequency`.
  const f0 = refineFrequency(x, fundamental ?? peak.freq, sampleRate);
  const residual = residualAfter(x, sampleRate, f0);
  const num = rms(residual);
  const total = rms(x);
  const ratio = total > 0 ? num / total : 0;
  return {
    fundamental: f0,
    residualRms: num,
    totalRms: total,
    thdnRatio: ratio,
    thdnPercent: ratio * 100,
    thdnDb: linearToDb(ratio),
  };
}

/**
 * Intermodulation distortion for a two-tone input: the SMPTE products at f2 ± n*f1, relative to the high tone.
 * This is the measurement that catches a nonlinearity a single-tone THD test misses.
 */
export function imd(x, { sampleRate, f1, f2, order = 3, window = 'rect' } = {}) {
  const refDb = dtftAmplitudeDb(x, f2, sampleRate);
  const products = [];
  let sumSq = 0;
  for (let n = 1; n <= order; n++) {
    for (const freq of [f2 - n * f1, f2 + n * f1]) {
      if (freq <= 0 || freq >= sampleRate / 2) continue;
      const db = dtftAmplitudeDb(x, freq, sampleRate);
      sumSq += dbToLinear(db) ** 2;
      products.push({ order: n, freq, db, dbRel: db - refDb });
    }
  }
  const refAmp = dbToLinear(refDb);
  const ratio = refAmp > 0 ? Math.sqrt(sumSq) / refAmp : 0;
  void window;
  return { reference: f2, referenceDb: refDb, imdRatio: ratio, imdPercent: ratio * 100, imdDb: linearToDb(ratio), products };
}

/**
 * A fractional delay by phase rotation, so a null test is not limited by whole-sample alignment.
 * `d` samples, positive meaning "b (as measured) arrived later than a" — the correction shifts it back.
 */
export function delaySignal(x, d) {
  if (d === 0) return Float64Array.from(x);
  const n = nextPow2(x.length + Math.ceil(Math.abs(d)) + 1);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(x);
  fftInPlace(re, im);
  // ⚠️ THE RAMP IS APPLIED UP TO NYQUIST AND MIRRORED CONJUGATELY, and the difference is not cosmetic. A real
  // signal's spectrum is conjugate-symmetric, and a full-range ramp preserves that only when d is a WHOLE
  // number of samples: for a fractional d, H[n-k] is no longer conj(H[k]), the product stops being symmetric,
  // the inverse transform comes back complex, and the real part I was reading is almost nothing. Measured: a
  // 37-sample delay round-tripped correctly while a 37.5-sample delay came back at 0.3% of its original RMS —
  // which then made the latency estimator report -739 samples, because it was correlating two near-silent
  // buffers. Mirroring is what keeps a fractional delay real.
  const half = n >> 1;
  for (let k = 0; k <= half; k++) {
    const phase = (-2 * Math.PI * k * d) / n;
    const cr = Math.cos(phase);
    const ci = Math.sin(phase);
    const rr = re[k] * cr - im[k] * ci;
    const ii = re[k] * ci + im[k] * cr;
    re[k] = rr;
    im[k] = ii;
    if (k > 0 && k < half) {
      const mirror = n - k;
      re[mirror] = rr;
      im[mirror] = -ii;
    }
  }
  ifftInPlace(re, im);
  const out = new Float64Array(x.length);
  // Rotating by +d delays the signal; take the window that lines the result up with the input's frame.
  const start = d >= 0 ? 0 : Math.round(-d);
  for (let i = 0; i < x.length; i++) {
    const src = i + start;
    out[i] = src >= 0 && src < n ? re[src] : 0;
  }
  return out;
}

/** Latency between two signals, in samples and ms, with the correlation coefficient at that lag. */
export function estimateLatency(a, b, { sampleRate, maxLagSamples = null } = {}) {
  const { lag, fractional, peak } = bestLag(a, b);
  if (maxLagSamples !== null && Math.abs(fractional) > maxLagSamples) {
    return { samples: lag, fractional, ms: (fractional / sampleRate) * 1000, correlation: 0, outOfRange: true };
  }
  let energyA = 0;
  let energyB = 0;
  for (let i = 0; i < a.length; i++) energyA += a[i] * a[i];
  for (let i = 0; i < b.length; i++) energyB += b[i] * b[i];
  const norm = energyA > 0 && energyB > 0 ? peak / Math.sqrt(energyA * energyB) : 0;
  return { samples: lag, fractional, ms: (fractional / sampleRate) * 1000, correlation: norm, outOfRange: false };
}

/**
 * Null depth: how much of `a` survives after `b` is aligned to it and gain-matched, in dB relative to `a`.
 *
 * This is THE test for whether two things are the same — a plugin against its bypass, a capture against the
 * amp, a quantized model against its float reference. It reports the alignment and gain it used, because a
 * null that only looks deep because of a wrong gain match is worse than no null at all.
 */
export function nullDepth(a, b, { sampleRate, align = true, matchGain = true } = {}) {
  const n = Math.min(a.length, b.length);
  const sig0 = a.subarray ? a.subarray(0, n) : a.slice(0, n);
  const ref = b.subarray ? b.subarray(0, n) : b.slice(0, n);
  const lat = align ? estimateLatency(sig0, ref, { sampleRate }) : { fractional: 0, samples: 0, ms: 0, correlation: 1 };
  // `estimateLatency(a, b)` returns how much LATER b arrives than a, so aligning means delaying a by that
  // much. (Delaying b instead would double the error rather than remove it — and a null test that aligns the
  // wrong way still produces a number, which is the dangerous part.)
  const sig = align && lat.fractional ? delaySignal(sig0, lat.fractional) : sig0;
  let gain = 1;
  if (matchGain) {
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) { num += sig[i] * ref[i]; den += ref[i] * ref[i]; }
    gain = den > 0 ? num / den : 1;
  }
  let sigEnergy = 0;
  let errEnergy = 0;
  const residual = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = sig[i] - gain * ref[i];
    residual[i] = r;
    sigEnergy += sig[i] * sig[i];
    errEnergy += r * r;
  }
  const ratio = sigEnergy > 0 ? Math.sqrt(errEnergy / sigEnergy) : 0;
  return {
    residualDb: linearToDb(Math.max(ratio, AMP_FLOOR)),
    residual,
    latencySamples: lat.fractional,
    latencyMs: lat.ms,
    correlation: lat.correlation,
    gain,
    gainDb: linearToDb(Math.abs(gain)),
  };
}

/**
 * Impulse response of the system that turned `reference` into `recorded`, by regularised spectral division:
 * H = Y·conj(X) / (|X|² + ε·max|X|²). Regularisation is what keeps it stable at frequencies the excitation
 * never reached (a sweep that starts at 20 Hz says nothing about 5 Hz, and dividing there would invent an
 * answer from noise).
 *
 * ⚠️ ε IS A REAL TRADE-OFF AND THE DEFAULT IS DELIBERATELY SMALL. Too small and the estimate amplifies noise
 * wherever the excitation was weak; too large and it drags the response toward zero — 1e-6 cost 3.2 dB at the
 * bottom of a clean sweep's band, which is the kind of error that reads as "this filter is wrong". At 1e-8 the
 * same measurement is within 0.06 dB. Pass a larger value for a noisy measurement; the parameter exists so that
 * choice is made knowingly rather than by a default nobody looked at.
 */
export function systemResponse(recorded, reference, { sampleRate, regularization = 1e-8, irLength = null } = {}) {
  const n = nextPow2(Math.max(recorded.length, reference.length));
  const xr = new Float64Array(n); xr.set(reference.subarray(0, Math.min(reference.length, n)));
  const xi = new Float64Array(n);
  const yr = new Float64Array(n); yr.set(recorded.subarray(0, Math.min(recorded.length, n)));
  const yi = new Float64Array(n);
  fftInPlace(xr, xi);
  fftInPlace(yr, yi);
  let maxPower = 0;
  for (let k = 0; k < n; k++) maxPower = Math.max(maxPower, xr[k] * xr[k] + xi[k] * xi[k]);
  const eps = regularization * maxPower;
  const hr = new Float64Array(n);
  const hi = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const power = xr[k] * xr[k] + xi[k] * xi[k] + eps;
    hr[k] = (yr[k] * xr[k] + yi[k] * xi[k]) / power;
    hi[k] = (yi[k] * xr[k] - yr[k] * xi[k]) / power;
  }
  ifftInPlace(hr, hi);
  const len = irLength ?? n;
  const ir = hr.slice(0, Math.min(len, n));
  return { ir, sampleRate, size: n };
}

/** Magnitude response in dB at arbitrary frequencies, evaluated exactly (see `dtftAmplitudeDb`). */
export function magnitudeResponseDb(ir, { sampleRate, points = 128, f1 = 20, f2 = 20000 } = {}) {
  const freqs = new Float64Array(points);
  const db = new Float64Array(points);
  const lo = Math.log10(f1);
  const hi = Math.log10(f2);
  for (let i = 0; i < points; i++) {
    const freq = 10 ** (lo + ((hi - lo) * i) / (points - 1));
    freqs[i] = freq;
    db[i] = dtftMagnitudeDb(ir, freq, sampleRate);
  }
  return { freqs, db };
}

/**
 * Aliasing check: drive the system with a sine above a quarter of the sample rate, then look for energy that is
 * NEITHER the fundamental nor one of its harmonics. Any such component was folded down from above Nyquist —
 * which is exactly what aliasing is, and what a naive nonlinearity does to a signal.
 */
export function aliasCheck(x, { sampleRate, fundamental, toleranceHz = 20, maxReport = 8 } = {}) {
  const s = spectrum(x, { sampleRate, window: 'blackman-harris' });
  const peak = peakFrequency(x, { sampleRate, window: 'blackman-harris' });
  const f0 = fundamental ?? peak.freq;
  // A window's sidelobes are local maxima too, so anything near a harmonic is excluded over a band wider than
  // the tolerance — otherwise the skirt of a clean tone reads as an alias and the check cries wolf on a
  // perfect signal. Real aliases land far from the harmonics, so the width costs nothing.
  const band = Math.max(toleranceHz, 4 * s.binHz);
  const harmonicOf = (freq) => {
    if (freq < band) return true; // DC and its skirts
    const k = Math.round(freq / f0);
    return k >= 1 && Math.abs(freq - k * f0) <= band;
  };
  // Local maxima only: a peak's skirts are not separate components.
  const found = [];
  for (let i = 2; i < s.db.length - 2; i++) {
    const isPeak = s.db[i] > s.db[i - 1] && s.db[i] >= s.db[i + 1];
    if (!isPeak) continue;
    const freq = s.freqs[i];
    if (harmonicOf(freq)) continue;
    if (s.db[i] - peak.db < -120) continue; // below anything audible or measurable
    found.push({ freq, db: s.db[i], dbRel: s.db[i] - peak.db });
  }
  found.sort((a, b) => b.db - a.db);
  const aliases = found.slice(0, maxReport);
  return {
    fundamental: f0,
    referenceDb: peak.db,
    strongestAliasDb: aliases.length ? aliases[0].dbRel : -Infinity,
    aliases,
  };
}
