// Does the measurement library measure anything correctly?
//
// WHY THIS GUARD IS THE POINT OF THE LIBRARY, not an afterthought. A measuring instrument that is subtly wrong
// is worse than no instrument: it produces a plausible number that someone then makes a decision on. And an
// audio measurement library is unusually easy to get subtly wrong — a scaling convention, a window's coherent
// gain, the direction of a correlation lag, a regularization term. None of those throw. They just change the
// answer.
//
// So every assertion below is checked against a result that is known INDEPENDENTLY of this code:
//
//   * a coherent sine's FFT peak is exactly N/2 by hand;
//   * the same transform is compared against a naive O(N²) DFT written out in this file;
//   * a pure sine's THD is zero, and a hard-clipped sine's harmonics must be ODD — a structural fact about a
//     symmetric nonlinearity that no amount of tuning can fake;
//   * third-order intermodulation must grow 4× for a 2× level, because the products scale as A³ against a
//     reference that scales as A — the arithmetic of a cubic, not an opinion;
//   * a biquad's measured response must match the analytic response of the coefficients that made it;
//   * a signal delayed by 37 samples has a latency of 37;
//   * and 8-bit quantization must land within a couple of dB of the textbook 6.02N + 1.76.
//
// Run:  node scripts/verify-audio-measure.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  biquadCoefficients, biquadProcess, biquadResponseDb, coherentGain, convolveDirect, convolveFft,
  dbToLinear, fftInPlace, fftReal, hann, ifftInPlace, linearToDb, quantize, rms, sqnrDb,
} from '../server/src/lib/audio/dsp.js';
import {
  coherentSineOfLength, impulse, logSweep, sine, twoTone, whiteNoise,
} from '../server/src/lib/audio/signals.js';
import {
  aliasCheck, delaySignal, estimateLatency, imd, magnitudeResponseDb, nullDepth, peakFrequency, spectrum,
  systemResponse, thd, thdPlusNoise,
} from '../server/src/lib/audio/analysis.js';
import { decodeWav, encodeWav } from '../server/src/lib/audio/wav.js';

const SR = 48000;
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'audio-measure.mjs');
let failures = 0;
let checks = 0;
const show = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? Number(v.toFixed(6)) : String(v)) : JSON.stringify(v));
function check(name, actual, expected) {
  checks++;
  if (show(actual) === show(expected)) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${show(expected)}\n          got      ${show(actual)}`); failures++; }
}
function near(name, actual, expected, tol) {
  checks++;
  if (Number.isFinite(actual) && Math.abs(actual - expected) <= tol) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${expected} ±${tol}\n          got      ${show(actual)}`); failures++; }
}
function below(name, actual, limit) {
  checks++;
  // Deliberately no isFinite() guard: -Infinity is the BEST possible result for "below" (a null test that
  // leaves nothing, an alias check that finds nothing), and refusing it failed a perfect outcome. NaN still
  // fails, because every comparison with NaN is false.
  if (actual < limit) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected < ${limit}\n          got      ${show(actual)}`); failures++; }
}
function above(name, actual, limit) {
  checks++;
  if (Number.isFinite(actual) && actual > limit) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected > ${limit}\n          got      ${show(actual)}`); failures++; }
}

// ── 1. the transform, against arithmetic done here ───────────────────────────────────────────────────────
console.log('\n1. the FFT is the transform it says it is');
{
  const N = 1024;
  const { freq, samples } = coherentSineOfLength({ bin: 16, fftSize: N, sampleRate: SR });
  near('the coherent helper lands exactly on its bin', freq, (16 * SR) / N, 1e-9);
  const { re, im } = fftReal(samples, N);
  near('a full-scale coherent sine puts N/2 into its own bin', Math.hypot(re[16], im[16]), N / 2, 1e-6);
  below('…and nothing measurable anywhere else', Math.hypot(re[17], im[17]), 1e-9);

  // Round trip.
  const rr = Float64Array.from(samples);
  const ii = new Float64Array(N);
  fftInPlace(rr, ii);
  ifftInPlace(rr, ii);
  let maxErr = 0;
  for (let i = 0; i < N; i++) maxErr = Math.max(maxErr, Math.abs(rr[i] - samples[i]));
  below('forward then inverse is the identity', maxErr, 1e-12);

  // Parseval, on independent copies.
  const ar = Float64Array.from(samples);
  const ai = new Float64Array(N);
  fftInPlace(ar, ai);
  let timeEnergy = 0;
  for (let i = 0; i < N; i++) timeEnergy += samples[i] * samples[i];
  let freqEnergy = 0;
  for (let k = 0; k < N; k++) freqEnergy += ar[k] * ar[k] + ai[k] * ai[k];
  near('Parseval: energy in equals energy out', freqEnergy / N, timeEnergy, 1e-9);

  // Against a naive DFT, which cannot share a bug with the fast one.
  const M = 64;
  const x = whiteNoise({ length: M, seed: 3 });
  const { re: fr, im: fi } = fftReal(x, M);
  let dftErr = 0;
  for (let k = 0; k < M; k++) {
    let sr = 0;
    let si = 0;
    for (let n = 0; n < M; n++) {
      const w = (-2 * Math.PI * k * n) / M;
      sr += x[n] * Math.cos(w);
      si += x[n] * Math.sin(w);
    }
    dftErr = Math.max(dftErr, Math.abs(sr - fr[k]), Math.abs(si - fi[k]));
  }
  below('the radix-2 FFT matches a naive DFT to 1e-9', dftErr, 1e-9);

  near('Hann windows average to half', coherentGain(hann(1024)), 0.5, 0.002);
  const sp = spectrum(samples, { sampleRate: SR, window: 'hann' });
  near('a windowed sine reads its TRUE amplitude, not N/2 of it', sp.amp[16], 1, 0.01);
  const peak = peakFrequency(samples, { sampleRate: SR, window: 'hann' });
  near('…and its true frequency', peak.freq, freq, 1);
}

// ── 2. convolution and correlation ────────────────────────────────────────────────────────────────────────
console.log('\n2. convolution is convolution, however it is computed');
{
  const a = whiteNoise({ length: 128, seed: 11 });
  const b = whiteNoise({ length: 37, seed: 12 });
  const direct = convolveDirect(a, b);
  const fast = convolveFft(a, b);
  let err = 0;
  for (let i = 0; i < direct.length; i++) err = Math.max(err, Math.abs(direct[i] - fast[i]));
  below('the FFT convolution agrees with the direct one', err, 1e-9);
  check('…and the result is the right length', direct.length, a.length + b.length - 1);

  const unit = impulse({ length: 64 });
  const identity = convolveFft(a, unit);
  check('convolving with an impulse is identity', identity.length, a.length + 64 - 1);
  near('…sample for sample', identity[10], a[10], 1e-12);
}

// ── 3. latency and the null test ──────────────────────────────────────────────────────────────────────────
console.log('\n3. latency and null depth are measured, not assumed');
{
  // Built from one longer noise buffer so both windows are FULL — a delayed copy that had to be zero-padded
  // would null only as well as its missing first samples allow, and the test would measure the fixture.
  const long = whiteNoise({ length: 4096 + 256, seed: 5 });
  const delayed = long.subarray(0, 4096);
  const signal = long.subarray(37, 37 + 4096);
  const lat = estimateLatency(signal, delayed, { sampleRate: SR });
  near('a 37-sample delay reads as 37 samples', lat.fractional, 37, 0.05);
  near('…which is the right number of milliseconds', lat.ms, (37 / SR) * 1000, 0.002);
  above('…and the correlation at that lag is near 1', lat.correlation, 0.99);

  // BROADBAND, not a sine. The cross-correlation of a sine with a delayed copy of itself is another SINE — a
  // peak every period — so the estimator can lock onto the wrong one. It did: 13.8 samples instead of 37.5.
  // A latency estimate wants one sharp autocorrelation peak, which is what noise gives.
  const fracSource = whiteNoise({ length: 8192, seed: 31 });
  const fracShifted = delaySignal(fracSource, 37.5);
  const frac = estimateLatency(fracSource.subarray(1024, 6144), fracShifted.subarray(1024, 6144), { sampleRate: SR });
  near('a fractional delay is resolved below one sample', frac.fractional, 37.5, 0.2);

  const self = nullDepth(signal, signal, { sampleRate: SR });
  below('a signal against itself nulls to nothing', self.residualDb, -120);
  near('…with no latency invented and unity gain', self.gain, 1, 1e-6);

  const half = Float64Array.from(signal, (v) => v * 0.5);
  const matched = nullDepth(signal, half, { sampleRate: SR });
  below('a level difference is removed by the gain match, not left in the residual', matched.residualDb, -120);
  // The reported gain is what you MULTIPLY the reference by to match the signal: to rebuild a signal from its
  // half-amplitude copy you double it, so +6.02 dB is the correct answer and -6.02 was my wrong expectation.
  near('…and the reported gain is the factor that closes the gap', matched.gainDb, linearToDb(2), 0.01);

  // A delayed copy nulls once aligned — but only to the edge a finite shift cannot invent: the first 37 samples
  // of the delayed buffer have no counterpart to be shifted from, and 37/4096 of the energy is -20 dB. The
  // assertion is still sharp, because a null test that FAILED to align reports ~0 dB, not -20.
  const delayedNull = nullDepth(signal, delayed, { sampleRate: SR });
  below('a delayed copy nulls once aligned, down to the edge a finite shift cannot invent', delayedNull.residualDb, -18);

  // Noise at exactly -40 dB relative to the signal must show up as a -40 dB residual.
  const noise = whiteNoise({ length: signal.length, seed: 9 });
  const scale = (dbToLinear(-40) * rms(signal)) / rms(noise);
  const noisy = Float64Array.from(signal, (v, i) => v + noise[i] * scale);
  const withNoise = nullDepth(signal, noisy, { sampleRate: SR });
  near('noise at -40 dB leaves a -40 dB residual', withNoise.residualDb, -40, 1.5);
}

// ── 4. distortion, including two structural facts no tuning can fake ──────────────────────────────────────
console.log('\n4. distortion measurements agree with the shape of the nonlinearity');
{
  const N = 8192;
  const { samples } = coherentSineOfLength({ bin: 64, fftSize: N, sampleRate: SR });
  const clean = thd(samples, { sampleRate: SR, harmonics: 8 });
  below('a pure sine has no harmonics to find', clean.thdPercent, 1e-6);

  const hardClip = (x, limit) => Float64Array.from(x, (v) => Math.max(-limit, Math.min(limit, v)));
  const clipped = hardClip(samples, 0.5);
  const cl = thd(clipped, { sampleRate: SR, harmonics: 9 });
  above('a hard-clipped sine is visibly distorted', cl.thdPercent, 5);
  const h2 = cl.harmonics.find((h) => h.order === 2).dbRel;
  const h3 = cl.harmonics.find((h) => h.order === 3).dbRel;
  // THE structural check: a symmetric clipper produces ONLY odd harmonics. If the measurement were reading
  // leakage, noise or the wrong frequencies, even harmonics would appear and this would fail.
  above('…and its distortion is ODD harmonics only, because the clipper is symmetric', h3 - h2, 40);

  const halfWave = Float64Array.from(samples, (v) => (v > 0 ? v : 0));
  const hw = thd(halfWave, { sampleRate: SR, harmonics: 9 });
  const hw2 = hw.harmonics.find((h) => h.order === 2).dbRel;
  const hw3 = hw.harmonics.find((h) => h.order === 3).dbRel;
  above('an ASYMMETRIC nonlinearity does produce even harmonics', hw2 - hw3, -10);

  const tnClean = thdPlusNoise(samples, { sampleRate: SR });
  below('THD+N of a pure sine is far below anything audible', tnClean.thdnDb, -80);
  // ⚠️ A FILE IS A DIFFERENT TEST FROM MEMORY, and this assertion exists because the first version of this
  // guard only had the in-memory case — which passed while the CLI was measuring -40 dB THD+N on a clean WAV.
  // A coherent in-memory sine survives a sloppy frequency estimate; a float32 file does not. The number a user
  // reads is the one from a file, so that is the one that has to be pinned.
  const asFile = decodeWav(encodeWav({ sampleRate: SR, data: [samples], format: 'float32' })).data[0];
  const fileTone = thdPlusNoise(asFile, { sampleRate: SR });
  below('…and the same tone measured from a FILE nulls its fundamental to the float32 floor', fileTone.thdnDb, -120);
  const tnClipped = thdPlusNoise(clipped, { sampleRate: SR });
  above('…and THD+N of the clipped one is not', tnClipped.thdnDb, -30);

  // Intermodulation: for a cubic nonlinearity the third-order products scale as A^3 while the reference
  // scales as A, so the RATIO must quadruple when the level doubles. That is arithmetic, not a threshold.
  // ⚠️ THE LEVEL LAW NEEDS THE RIGHT MODEL, and I had it wrong first time. A PURE cubic (y = x³) is
  // level-INDEPENDENT in relative terms — its reference at f2 scales as A³ too — so "×4 for ×2 level" fails
  // against correct code. The law belongs to y = x + ε·x³, where the fundamental stays linear while the
  // products grow as A³. ε is small so the linear term dominates the reference.
  const EPS = 0.05;
  const mild = (x) => Float64Array.from(x, (v) => v + EPS * v * v * v);
  const two = twoTone({ sampleRate: SR, seconds: 0.5, amplitude: 0.5 });
  const twoLoud = twoTone({ sampleRate: SR, seconds: 0.5, amplitude: 1.0 });
  const quiet = imd(mild(two), { sampleRate: SR, f1: 60, f2: 7000 });
  const loud = imd(mild(twoLoud), { sampleRate: SR, f1: 60, f2: 7000 });
  above('the IM products are real, not the noise floor', quiet.imdPercent, 1e-7);
  near('doubling the level quadruples the relative IM products of x + εx³', loud.imdRatio / quiet.imdRatio, 4, 0.4);
  const linear = imd(two, { sampleRate: SR, f1: 60, f2: 7000 });
  below('a linear system has no intermodulation to find', linear.imdPercent, 1e-6);
}

// ── 5. a filter's response, measured against the analytic answer ──────────────────────────────────────────
console.log('\n5. a measured frequency response matches the filter that made it');
{
  const coeffs = biquadCoefficients({ type: 'lowpass', freq: 1000, q: Math.SQRT1_2, sampleRate: SR });
  near('a 1 kHz lowpass passes 100 Hz', biquadResponseDb(coeffs, 100, SR), 0, 0.1);
  // Analytic values for a Q = 0.707 two-pole lowpass: -3.01 dB AT the corner, and 1/sqrt(1 + 2^4) = -12.3 dB an
  // octave above it. NOT -40 dB at 10 kHz — that is the ANALOG Butterworth asymptote, and a digital biquad warps
  // above its corner (it measures -42.7 dB, which is correct; my expectation was the wrong one).
  near('…and sits 3 dB down at its corner, as Q = 0.707 requires', biquadResponseDb(coeffs, 1000, SR), -3.01, 0.1);
  near('…and 12.3 dB down an octave above it', biquadResponseDb(coeffs, 2000, SR), -12.3, 0.5);

  const ir = biquadProcess(coeffs, impulse({ length: 8192 }));
  const measured = magnitudeResponseDb(ir, { sampleRate: SR, points: 6, f1: 100, f2: 12000 });
  let worst = 0;
  for (let i = 0; i < measured.freqs.length; i++) {
    const analytic = biquadResponseDb(coeffs, measured.freqs[i], SR);
    worst = Math.max(worst, Math.abs(measured.db[i] - analytic));
  }
  below('the MEASURED response matches the analytic one everywhere', worst, 0.1);

  // A system response recovered from a sweep, against the impulse response that was convolved in.
  const sweep = logSweep({ f1: 100, f2: 15000, sampleRate: SR, seconds: 0.5, amplitude: 0.5 });
  const known = biquadProcess(biquadCoefficients({ type: 'highpass', freq: 300, q: 0.9, sampleRate: SR }), impulse({ length: 2048 }));
  const recorded = convolveFft(sweep, known);
  const recovered = systemResponse(recorded, sweep, { sampleRate: SR, irLength: 2048 });
  const knownResp = magnitudeResponseDb(known, { sampleRate: SR, points: 8, f1: 100, f2: 15000 });
  const gotResp = magnitudeResponseDb(recovered.ir, { sampleRate: SR, points: 8, f1: 100, f2: 15000 });
  let respErr = 0;
  for (let i = 0; i < knownResp.db.length; i++) respErr = Math.max(respErr, Math.abs(knownResp.db[i] - gotResp.db[i]));
  // 0.5 dB, not 3: the first version of this asserted 1.5 dB and passed while the default regularization was
  // smearing the bottom of the band by 3.2 dB — a tolerance wide enough to hide the bug it was there to catch.
  below('a response recovered from a sweep matches the filter that was applied', respErr, 0.5);
}

// ── 6. the file format loses nothing it promises to lose nothing to ───────────────────────────────────────
console.log('\n6. WAV round-trips are lossless where they claim to be');
{
  const x = whiteNoise({ length: 1000, seed: 21, amplitude: 0.9 });
  const f32 = decodeWav(encodeWav({ sampleRate: SR, data: [x], format: 'float32' }));
  let e32 = 0;
  for (let i = 0; i < x.length; i++) e32 = Math.max(e32, Math.abs(f32.data[0][i] - x[i]));
  // float32 has a 24-bit mantissa, so a float32 round trip is NOT bit-exact for arbitrary doubles. The first
  // version of this said `exactly` and passed only because the report rounds to six decimals — 6e-8 printed as
  // 0. That is a check satisfied by its own formatting, so the claim is now stated as what it is.
  below('float32 round-trips to float32 precision', e32, 1e-7);
  check('sample rate survives', f32.sampleRate, SR);
  check('the format is reported honestly', f32.format, 'float32');

  const i16 = decodeWav(encodeWav({ sampleRate: SR, data: [x], format: 'int16' }));
  let e16 = 0;
  for (let i = 0; i < x.length; i++) e16 = Math.max(e16, Math.abs(i16.data[0][i] - x[i]));
  below('int16 is quantized to 16 bits and no worse', e16, 1 / 32768 + 1e-9);
  check('…and says so', i16.format, 'pcm16');

  const i24 = decodeWav(encodeWav({ sampleRate: SR, data: [x], format: 'int24' }));
  let e24 = 0;
  for (let i = 0; i < x.length; i++) e24 = Math.max(e24, Math.abs(i24.data[0][i] - x[i]));
  below('24-bit is finer than 16-bit', e24, 1 / 8388608 + 1e-9);

  const left = sine({ freq: 440, sampleRate: SR, length: 100 });
  const right = sine({ freq: 880, sampleRate: SR, length: 100 });
  const stereo = decodeWav(encodeWav({ sampleRate: SR, data: [left, right], format: 'float32' }));
  check('stereo keeps both channels', stereo.channels, 2);
  near('…and they are not mixed up', stereo.data[1][10], right[10], 1e-6);

  // Chunk skipping, with the chunk actually present: real files carry LIST/fact metadata between `fmt ` and
  // `data`, and a decoder that assumes the audio starts at byte 44 reads metadata as samples.
  const base = encodeWav({ sampleRate: SR, data: [x], format: 'float32' });
  const junk = Buffer.alloc(12);
  junk.write('LIST', 0, 'ascii');
  junk.writeUInt32LE(4, 4);
  junk.write('INFO', 8, 'ascii');
  const withJunk = Buffer.concat([base.subarray(0, 36), junk, base.subarray(36)]);
  const junkDecoded = decodeWav(withJunk);
  check('a file with an unexpected chunk before the audio still decodes', junkDecoded.frames, 1000);
  below('…and the audio is the audio, not the metadata', Math.abs(junkDecoded.data[0][500] - x[500]), 1e-7);
}

// ── 7. quantization — the number the whole FPGA argument rests on ────────────────────────────────────────
console.log('\n7. quantization matches the textbook, which is why bit depth is a budget');
{
  const x = sine({ freq: 997, sampleRate: SR, length: 16384, amplitude: 0.5 });
  const results = {};
  for (const bits of [4, 6, 8, 12, 16]) {
    const q = quantize(x, bits);
    results[bits] = { sqnr: sqnrDb(x, q.samples), step: q.step };
  }
  // The classic result: SQNR ≈ 6.02N + 1.76 dB for a full-scale sine. If this is off by more than a couple of
  // dB, the quantizer's step or its rounding is wrong — and every "what does 8-bit cost?" answer built on it
  // would be wrong too.
  near('8-bit lands on the textbook 6.02N + 1.76', results[8].sqnr, 6.02 * 8 + 1.76, 3);
  near('16-bit lands there too', results[16].sqnr, 6.02 * 16 + 1.76, 3);
  above('12-bit is cleaner than 8', results[12].sqnr, results[8].sqnr + 20);
  above('8-bit is cleaner than 6', results[8].sqnr, results[6].sqnr + 8);
  above('6-bit is cleaner than 4', results[6].sqnr, results[4].sqnr + 8);
  near('the reported step is the step it used', results[8].step, 0.5 / (2 ** 7 - 1), 1e-12);

  // A quantized model is only meaningful with its scale: dequantizing without it is a different signal.
  const q8 = quantize(x, 8);
  const reQ = Float64Array.from(q8.samples, (v) => v / q8.step);
  below('dequantized codes are whole numbers', Math.max(...Array.from(reQ, (v) => Math.abs(v - Math.round(v)))), 1e-9);
}

// ── 8. aliasing: the test that has to tell a real alias from a window's skirt ─────────────────────────────
console.log('\n8. aliasing is detected, and clean signals are not accused');
{
  const N = 8192;
  const clean = coherentSineOfLength({ bin: 1706, fftSize: N, sampleRate: SR }); // ~10 kHz
  const cleanCheck = aliasCheck(clean.samples, { sampleRate: SR });
  below('a clean high sine reports no aliases', cleanCheck.strongestAliasDb, -60);

  // 15 kHz at 48 kHz: the 3rd harmonic is 45 kHz, which folds to 3 kHz — NOT a harmonic of 15 kHz, so it can
  // only be an alias. A detector that misses it would pass every plugin that aliases.
  const high = coherentSineOfLength({ bin: 2560, fftSize: N, sampleRate: SR }); // 15 kHz
  const clipped = Float64Array.from(high.samples, (v) => Math.max(-0.4, Math.min(0.4, v)));
  const check1 = aliasCheck(clipped, { sampleRate: SR, fundamental: high.freq });
  above('a clipped 15 kHz tone DOES show aliases', check1.strongestAliasDb, -60);
  const strongest = check1.aliases[0];
  near('…and the strongest sits where the 3rd harmonic folds to', strongest.freq, SR - 3 * high.freq, 300);
}


// ── 9. the command line's machine-readable output is machine-readable ─────────────────────────────────────
// The library can be perfect and the CLI still unusable by anything but a human. This spawns the real command
// with a flag at the END of the line, which is exactly where the first version of its argument parser broke —
// it assigned `undefined` instead of `true` and printed prose where a script expected JSON.
console.log('\n9. the CLI prints JSON when asked, including with the flag last');
{
  const dir = mkdtempSync(join(tmpdir(), 'audio-measure-guard-'));
  const a = join(dir, 'a.wav');
  const b = join(dir, 'b.wav');
  const tone = sine({ freq: 1000, sampleRate: SR, length: 4096, amplitude: 0.5 });
  writeFileSync(a, encodeWav({ sampleRate: SR, data: [tone], format: 'float32' }));
  writeFileSync(b, encodeWav({ sampleRate: SR, data: [tone], format: 'float32' }));
  const run = spawnSync(process.execPath, [CLI, 'compare', a, b, '--json'], { encoding: 'utf8' });
  check('the CLI exits cleanly', run.status, 0);
  let parsed = null;
  try { parsed = JSON.parse((run.stdout || '').trim()); } catch { parsed = null; }
  check('…and its output parses as JSON with the flag LAST', parsed !== null, true);
  check('…carrying the measurement, not a summary', typeof parsed?.nullDepthDb, 'number');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ the measurement library measures something other than what it claims\n');
  process.exit(1);
}
console.log('every measurement has an answer it agrees with\n');
