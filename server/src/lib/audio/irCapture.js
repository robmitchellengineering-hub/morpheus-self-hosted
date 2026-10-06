// Impulse-response capture: the sweep you play, the take you record, and the cabinet that comes out.
//
// ── WHY THIS BELONGS IN THE SYSTEM RATHER THAN IN A README ───────────────────────────────────────────────
// The plugin bakes a cabinet in as float coefficients, and every real cabinet IR in the wild belongs to
// somebody — the repo already says so, which is why the demo's cabinet is a synthetic fixture and why the
// free download ships without one. **The way out of that is not a licence negotiation, it is a measurement you
// own.** This is that measurement: play a sweep through the rig, record it, deconvolve.
//
// ── ⚠️ AN AMP MODEL AND A CABINET IR ARE NOT THE SAME CAPTURE, AND THE DIFFERENCE DECIDES THE METHOD ─────
// A `.nam` is a *nonlinear* system (an amp), so capturing one needs a long, varied re-amp signal and a
// training run — that half is `namCapture.js` + `audio-capture.mjs`, and it is already built. A cabinet is
// *linear* (a speaker cone, a mic, a room), and a linear system is completely described by its impulse
// response. Which means a cabinet can be captured by this file in one take, with no training, no GPU and no
// model — and the number that says how good the capture is can be computed exactly.
//
// ⚠️ SO CAPTURE THE CABINET ALONE. The amp's coloration belongs to the `.nam`; if the rig is
// amp → cab → mic then the IR carries the amp twice and the plugin applies it twice. Take the IR from a
// **clean power amp or the amp's effects return** into the cabinet, or accept that it is "my rig" rather than
// "my cabinet" — see the guide for what to do, and note it in the IR's name either way.
//
// ── THE METHOD, AND THE ONE THING THAT MAKES IT WORK ────────────────────────────────────────────────────
// An exponential sine sweep, deconvolved against itself. `logSweep` in `signals.js` is exponential, and that
// is not a detail: an exponential sweep's HARMONIC DISTORTION products arrive BEFORE the linear response in
// the deconvolved output, so a window can throw them away. A linear sweep puts them on top of the IR, where
// nothing can separate them.
import { fftInPlace, nextPow2 } from './dsp.js';
import { logSweep } from './signals.js';

/** The sweep the capture guide tells the user to play, and the window the IR is taken from. */
export const IR_SWEEP = Object.freeze({
  sampleRate: 48000,
  seconds: 3,
  f1: 20,
  f2: 20000,
  amplitude: 0.25,
  // ⚠️ SILENCE AT BOTH ENDS, AND IT IS NOT PADDING. The lead lets the rig settle before the sweep starts (an
  // amp's power supply and a reverb tank are still moving); the tail is what the cabinet's own decay happens
  // in, and without it the recording ends mid-ring and the IR is truncated by the RECORDING rather than by us.
  leadSeconds: 0.5,
  tailSeconds: 1.5,
});

/** How many taps a capture keeps by default — the same cap `cabIr.js` convolves, so nothing is silently cut. */
export const DEFAULT_TAPS = 4096;

/**
 * The signal to play: lead silence, the sweep, tail silence.
 *
 * Returned with its fades applied, because a sweep that starts at full amplitude is a click, and a click is
 * broadband energy that lands in the IR as a spike nobody can tell from the cabinet's own first reflection.
 */
export function sweepSignal(spec = IR_SWEEP) {
  const s = { ...IR_SWEEP, ...spec };
  const lead = Math.round(s.leadSeconds * s.sampleRate);
  const tail = Math.round(s.tailSeconds * s.sampleRate);
  const body = logSweep({ f1: s.f1, f2: s.f2, sampleRate: s.sampleRate, seconds: s.seconds, amplitude: s.amplitude });
  const out = new Float64Array(lead + body.length + tail);
  out.set(body, lead);
  // 32 ms fades: long enough to be inaudible as a click, short enough to leave the sweep itself intact.
  const f = Math.round(0.032 * s.sampleRate);
  for (let i = 0; i < f; i++) {
    const g = 0.5 * (1 - Math.cos((Math.PI * i) / f));
    out[lead + i] *= g;
    out[lead + body.length - 1 - i] *= g;
  }
  return out;
}

/**
 * The sweep's spectrum, inverted, for a regularised deconvolution: `conj(X) / (|X|² + ε|X|²max)`.
 *
 * ⚠️ THE REGULARISATION IS THE DIFFERENCE BETWEEN A CABINET AND A HISS. Exact division by `X(f)` blows up
 * wherever the sweep has little energy — below `f1`, above `f2`, and at the very start and end of the band —
 * and the result is a full-scale noise filter that sounds like a broken speaker and measures like one. `eps`
 * is a fraction of the sweep's own peak power, so it scales with the level the capture was taken at.
 */
export function sweepSpectrumInverse(sweep, { size, eps = 1e-4 } = {}) {
  const n = size ?? nextPow2(sweep.length);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(sweep.subarray(0, Math.min(sweep.length, n)));
  fftInPlace(re, im);
  let peakPower = 0;
  for (let i = 0; i < n; i++) peakPower = Math.max(peakPower, re[i] * re[i] + im[i] * im[i]);
  const floor = eps * peakPower;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = re[i] * re[i] + im[i] * im[i] + floor;
    outRe[i] = re[i] / p;      // conj(X)/|X|² = X*/|X|², and Re is unchanged by conjugation
    outIm[i] = -im[i] / p;
  }
  return { re: outRe, im: outIm, size: n, peakPower };
}

/**
 * Deconvolve a recording against the sweep it was made with, and take the IR out of it.
 *
 * Returns the IR, where in the recording the response actually started (the interface's round-trip latency,
 * which is worth knowing rather than hiding), and the distortion products that were thrown away — reported
 * rather than discarded silently, because "my amp was clipping during the capture" is exactly the thing that
 * ruins an IR and is invisible in the result.
 */
export function deconvolve(recorded, sweep, { taps = DEFAULT_TAPS, eps = 1e-4, preDelay = 8 } = {}) {
  const needed = recorded.length + sweep.length - 1;
  const size = nextPow2(needed);
  const inv = sweepSpectrumInverse(sweep, { size, eps });

  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(recorded.subarray(0, Math.min(recorded.length, size)));
  fftInPlace(re, im);
  for (let i = 0; i < size; i++) {
    const ar = re[i];
    const ai = im[i];
    re[i] = ar * inv.re[i] - ai * inv.im[i];
    im[i] = ar * inv.im[i] + ai * inv.re[i];
  }
  // Inverse transform: conjugate, forward, scale — the same pair `dsp.js` uses.
  for (let i = 0; i < size; i++) im[i] = -im[i];
  fftInPlace(re, im);
  for (let i = 0; i < size; i++) re[i] /= size;

  // Where the response starts: the biggest sample. Everything before it is the interface's latency plus the
  // lead silence; everything after, up to `taps`, is the cabinet.
  let peak = 0;
  for (let i = 0; i < size; i++) if (Math.abs(re[i]) > Math.abs(re[peak])) peak = i;

  // ⚠️ A FEW SAMPLES OF RUN-UP ARE KEPT BEFORE THE PEAK. An IR whose first sample is its own maximum has had
  // its leading edge cut off, which is most of what a speaker's high end sounds like. `preDelay` is samples,
  // not a window: 8 is a sixth of a millisecond.
  const start = Math.max(0, peak - preDelay);
  const ir = new Float64Array(taps);
  for (let i = 0; i < taps; i++) ir[i] = re[(start + i) % size];

  // The part of the deconvolved output that is NOT the IR: before the start (the harmonic products an
  // exponential sweep pushes ahead of the linear response) and after the taps we keep.
  let distortion = 0;
  let energy = 0;
  let tapsEnergy = 0;
  for (let i = 0; i < size; i++) {
    const v = re[i] * re[i];
    energy += v;
    if (i >= start && i < start + taps) tapsEnergy += v;
    else distortion += v;
  }
  // ⚠️ THE PEAK'S ABSOLUTE POSITION IN THE BUFFER MEANS NOTHING ON ITS OWN: it moves with whatever silence
  // preceded the sweep in the take. What is physical is the distance from the SWEEP to the RESPONSE — a
  // cabinet cannot answer before it is asked, and it answers a few hundred samples later (the interface's round
  // trip plus the microphone's distance), not seconds.
  const sweepAt = locateSweep(recorded, sweep, size).at;
  return {
    ir,
    latencySamples: peak,
    sweepAt,
    windowStart: start,
    size,
    taps,
    // Everything outside the kept window, relative to what is inside it. A capture with a hot input, or a take
    // where something moved, shows up here as a number rather than as a cabinet that sounds slightly wrong.
    outsideDb: 10 * Math.log10((distortion + 1e-30) / (tapsEnergy + 1e-30)),
    energy,
  };
}

/**
 * Where the SWEEP begins in the take, by cross-correlation — and this is the check that stops the tool
 * producing a confident cabinet out of the wrong file.
 *
 * ⚠️ THE OBVIOUS PROXY DOES NOT WORK, AND IT WAS TRIED FIRST. "Find the loudest part of the take" is useless
 * here because an exponential sweep has a FLAT envelope by design — it puts equal energy at every frequency for
 * its whole duration. Measured: on a take whose sweep began at sample 24000, the loudest 100 ms window was at
 * 85586, and the rule built on it refused a perfect capture. Loudness carries no position.
 *
 * Correlation does. The take contains the sweep, so correlating the two has a sharp maximum exactly where the
 * sweep starts, whatever the playback offset, the interface delay or how much silence was exported in front.
 */
export function locateSweep(recorded, sweep, size) {
  const n = size ?? nextPow2(recorded.length + sweep.length - 1);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(recorded.subarray(0, Math.min(recorded.length, n)));
  fftInPlace(re, im);
  const sr = new Float64Array(n);
  const si = new Float64Array(n);
  sr.set(sweep.subarray(0, Math.min(sweep.length, n)));
  fftInPlace(sr, si);
  // X · conj(S), then the inverse transform: the cross-correlation, whose peak is the sweep's position.
  for (let i = 0; i < n; i++) {
    const ar = re[i];
    const ai = im[i];
    re[i] = ar * sr[i] + ai * si[i];
    im[i] = ai * sr[i] - ar * si[i];
  }
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fftInPlace(re, im);
  let peak = 0;
  let best = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(re[i]);
    if (v > best) { best = v; peak = i; }
  }
  return { at: peak, peak: best };
}

/**
 * How long after the sweep the cabinet answered, SIGNED, and folded to the nearest zero.
 *
 * ⚠️ THE FOLD IS THE WHOLE POINT. Both positions live in a circular FFT buffer, so a response arriving 33
 * samples BEFORE the correlation peak is `(145 - 178) mod 524288 = 524255` — which reads as ten seconds late and
 * refused a perfectly good capture. Folding to the nearest half-buffer turns that back into −33: the answer is a
 * small number of samples in either direction, and a real cabinet's is a few hundred.
 */
export function responseDelay({ latencySamples, sweepAt, size }) {
  if (!size) return 0;
  return ((latencySamples - sweepAt + size / 2) % size) - size / 2;
}

/** Normalise to a peak of 1.0, as `cabIr.js` does at bake time — and say what the peak was. */
export function normaliseIr(ir) {
  let peak = 0;
  for (const v of ir) peak = Math.max(peak, Math.abs(v));
  if (!(peak > 0)) return { ir: Float64Array.from(ir), peak: 0, normalised: false };
  const out = new Float64Array(ir.length);
  for (let i = 0; i < ir.length; i++) out[i] = ir[i] / peak;
  return { ir: out, peak, normalised: true };
}

/**
 * What the IR is, as facts and refusals.
 *
 * ⚠️ WHAT THIS CAN AND CANNOT TELL YOU. It can tell you the capture is silent, clipped, or mostly room; that
 * the response is causal (a cabinet cannot answer before it is asked, so energy before the peak means the
 * sweep was not clean); and how long the tail runs. It **cannot** tell you that the cabinet sounds good —
 * that is a person listening — and it must not pretend otherwise.
 */
export function checkIr(ir, { sampleRate = IR_SWEEP.sampleRate, taps = ir.length } = {}) {
  const issues = [];
  const n = ir.length;
  let peak = 0;
  let peakAt = 0;
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(ir[i]);
    if (a > peak) { peak = a; peakAt = i; }
    energy += ir[i] * ir[i];
  }
  const facts = { taps: n, peak, peakAt, peakMs: (peakAt / sampleRate) * 1000, energy };
  if (!(peak > 0)) {
    issues.push({ level: 'fail', what: 'the impulse response is silent', detail: 'Nothing came back — check the mic, the level, and that the sweep actually played.' });
    return { ok: false, facts, issues };
  }
  // Clipping before the deconvolution shows up as a flat-topped IR; a capture that is mostly one sample is a
  // click, which is what a bad sweep or a dropped take produces.
  const rms = Math.sqrt(energy / n);
  facts.crestDb = 20 * Math.log10(peak / (rms + 1e-30));
  facts.rms = rms;

  // The tail: how much of the IR is still above -60 dB of its own peak, in samples. A cabinet that decays in
  // 2 ms is a filter; one that runs to the end of the window may be mostly room.
  let last = 0;
  const floorDb = -60;
  for (let i = 0; i < n; i++) if (Math.abs(ir[i]) > peak * 10 ** (floorDb / 20)) last = i;
  facts.decaySamples = last;
  facts.decayMs = (last / sampleRate) * 1000;

  if (facts.decayMs < 5) {
    issues.push({ level: 'warn', what: `the response decays in ${facts.decayMs.toFixed(1)} ms`, detail: 'That is shorter than a speaker cabinet — usually a mic that is too close to the cone edge, or a gate somewhere in the chain.' });
  }
  if (facts.decayMs > (n / sampleRate) * 1000 * 0.9) {
    issues.push({ level: 'warn', what: 'the response is still going at the end of the window', detail: 'Some of what is in here is the room rather than the cabinet. A shorter window, or a closer mic, makes a more portable IR.' });
  }
  if (facts.crestDb < 6) {
    issues.push({ level: 'warn', what: `the crest factor is only ${facts.crestDb.toFixed(1)} dB`, detail: 'A real cabinet IR has a sharp leading edge. A flat one usually means the input clipped somewhere, or the sweep was not the one that played.' });
  }
  if (peakAt === 0 && n > 1) {
    issues.push({ level: 'warn', what: 'the response starts at its own maximum', detail: 'The leading edge may have been cut off by the capture or by the window.' });
  }
  return { ok: !issues.some((i) => i.level === 'fail'), facts, issues };
}

/** The report as lines a human reads. */
export function formatIrCapture({ facts, issues }, latencySamples = null) {
  const lines = [];
  lines.push(`${facts.taps} taps · peak ${facts.peak.toFixed(4)} at ${facts.peakMs.toFixed(2)} ms · `
    + `decay ${facts.decayMs.toFixed(1)} ms · crest ${facts.crestDb.toFixed(1)} dB`);
  if (latencySamples != null) lines.push(`the take's round-trip latency: ${latencySamples} samples (${(latencySamples / 48).toFixed(2)} ms)`);
  for (const issue of issues) lines.push(`  ${issue.level === 'fail' ? '✗' : '!'} ${issue.what}\n      ${issue.detail}`);
  return lines.join('\n');
}
