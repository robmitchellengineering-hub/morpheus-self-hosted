// The trainer's contract, as a module — what NAM will accept, and what it will make of what you give it.
//
// ── WHY THIS IS A SEPARATE MODULE, AND WHY IT IS A FAITHFUL PORT RATHER THAN AN OPINION ──────────────────
// Training a NAM model is PyTorch on a GPU. What this repository can own is everything around it: the re-amp
// signal, the verdict on a recorded pair, and the measurement of the model that comes back. That verdict is
// only worth anything if it AGREES WITH THE TRAINER — a second opinion that disagrees is worse than none,
// because it either waves through a pair the trainer refuses or condemns a take that was fine.
//
// So every constant and every algorithm below is transcribed from NAM's own source, and the guard pins them
// as literals so a drift cannot be silent:
//
//   nam/train/core.py    _V3_DATA_INFO, _V1/_V2/_V4_DATA_INFO, _DELAY_CALIBRATION_*_THRESHOLD
//                        _detect_input_version (the strong-hash table)
//                        _check_audio_sample_rates, _check_audio_lengths
//                        _check_v3 (the replicate ESR), _esr
//                        _calibrate_latency_v_all
//
// ── THE FINDING THIS FILE EXISTS BECAUSE OF ──────────────────────────────────────────────────────────────
// The obvious design was to generate our own re-amp signal — deterministic, licence-free, a sweep plus plucked
// notes. **That file cannot be trained on.** `_detect_input_version` MD5s the whole input and looks it up in a
// table; no match and it falls back to hashing the first 17 s and the last 9 s; no match again and it raises
// "Input file at … cannot be recognized as any known version!" — and in the GUI the Train button never
// enables. It is not a warning, it is a wall.
//
// Worse, the version decides the STRUCTURE the trainer relies on. v3's `_DataInfo` is a contract:
//
//   (0:00–0:09)   validation 1        ← the same signal as validation 2, at the end
//   (0:09–0:10)   silence             ← the noise-floor reference for the impulse trigger
//   (0:10–0:12)   two impulses        ← how the trainer finds the round-trip delay
//   (0:12–0:15)   chirps
//   (0:15–0:17)   noise
//   (0:17–3:00.5) general training data
//   (3:00.5–3:01) silence
//   (3:01–3:10)   validation 2
//
// so the honest answer is to use the official `input.wav` and verify it byte for byte, which is what
// `audio-capture.mjs input` does. Note also that having the SAME validation signal at both ends is what makes
// the replicate ESR possible at all: v3 can check whether the amp held still for the whole take, and the other
// versions cannot.
//
// See the guard for what is proven about all of this: scripts/verify-audio-capture.mjs
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { peak, rms } from '../../server/src/lib/audio/dsp.js';

/** The official re-amp signal, from the link NAM's own GUI points at (docs/source/tutorials/gui.rst). */
export const INPUT_URL = 'https://drive.google.com/uc?export=download&id=1KbaS4oXXNEuh2aCPLwKrPdf5KFOjda8G';
export const INPUT_FILENAME = 'input.wav';

/**
 * The strong hashes from `_detect_input_version`, so a file the trainer WOULD accept is never reported as
 * unknown. `INPUT_MD5` is v3.0.0, the current one, and it is what the download is verified against — the value
 * in the trainer's source, not a checksum taken from whatever arrived.
 */
export const INPUT_MD5 = '36cd1af62985c2fac3e654333e36431e';
export const STRONG_HASHES = {
  '4d54a958861bf720ec4637f43d44a7ef': '1.0.0',
  '7c3b6119c74465f79d96c761a0e27370': '1.1.1',
  'ede3b9d82135ce10c7ace3bb27469422': '2.0.0',
  '36cd1af62985c2fac3e654333e36431e': '3.0.0',
  '80e224bd5622fd6153ff1fd9f34cb3bd': 'Proteus',
};

/**
 * v3's `_DataInfo` and the calibration constants, verbatim.
 *
 * Sample indices, not seconds, because that is how the trainer indexes — and rounding a second boundary would
 * move the impulse window, which is the difference between finding the delay and inventing one.
 */
export const V3 = {
  rate: 48000,
  tBlips: 96_000,
  firstBlipsStart: 480_000,
  tValidate: 432_000,
  noiseInterval: [492_000, 498_000],
  blipLocations: [[504_000, 552_000]],
  lookahead: 1_000,
  lookback: 10_000,
  absThreshold: 0.0003,
  relThreshold: 0.001,
  safetyFactor: 1,
  // `_check_audio_lengths`' defaults: not shorter at all, and no more than a second longer.
  maxUnderSeconds: 0,
  maxOverSeconds: 1,
};

/** The trainer's `_esr`: mean squared error over mean squared target, i.e. an inverse SNR. 0 is perfect. */
export function esr(pred, target) {
  let err = 0;
  let sig = 0;
  for (let i = 0; i < target.length; i++) {
    const d = pred[i] - target[i];
    err += d * d;
    sig += target[i] * target[i];
  }
  // A silent target has no reference to divide by. 0/0 reported as a number would read as a pass.
  if (!(sig > 0)) return Infinity;
  return err / target.length / (sig / target.length);
}

export function md5File(path) {
  return createHash('md5').update(readFileSync(path)).digest('hex');
}

/** Which known input this file is, by the trainer's own strong hash of the whole file. */
export function identifyInput(path) {
  const md5 = md5File(path);
  const version = STRONG_HASHES[md5] ?? null;
  return { md5, version, major: version ? Number.parseInt(version, 10) || 4 : null };
}

function maxAbs(x) {
  let m = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > m) m = Math.abs(x[i]);
  return m;
}

/**
 * The round-trip delay, by the trainer's own impulse calibration (`_calibrate_latency_v_all` for v3).
 *
 * The output is scanned from `lookahead` before the first impulse to `lookback` after it, and the delay is the
 * first sample whose magnitude beats a threshold set from the amp's own noise floor in the silence just
 * before. Two things about that are worth knowing rather than discovering in a plot:
 *
 *   • The threshold is ADAPTIVE, and it has two branches. On the official input the noise interval is digital
 *     silence, so it collapses to `absThreshold` = 0.0003; on a real capture the amp's own hiss sets it. The
 *     crossover is a noise floor of 0.3, above which `1.001 × floor` wins and the relative branch takes over.
 *   • A delay of exactly `-lookahead` means the scan tripped on its FIRST sample — the tell for a noise floor
 *     that beat the response rather than a response that arrived early. The trainer warns about it; so does
 *     this, because a delay of -1000 looks like an answer and is not one.
 */
export function blipLatency(output, info = V3) {
  const background = maxAbs(output.subarray(info.noiseInterval[0], info.noiseInterval[1]));
  const threshold = Math.max(background + info.absThreshold, (1 + info.relThreshold) * background);
  const iRel = info.blipLocations[0][0] - info.firstBlipsStart;
  const startLooking = iRel - info.lookahead;
  const scan = output.subarray(info.firstBlipsStart + startLooking, info.firstBlipsStart + iRel + info.lookback);
  let first = -1;
  for (let i = 0; i < scan.length; i++) if (Math.abs(scan[i]) > threshold) { first = i; break; }
  if (first < 0) return { detected: false, background, threshold, delay: null, recommended: null };
  const delay = first + startLooking - iRel;
  return {
    detected: true,
    background,
    threshold,
    delay,
    recommended: delay - info.safetyFactor,
    hitLookahead: delay === -info.lookahead,
  };
}

/**
 * Whether a recorded pair will train, and what the trainer will make of it — PURE, so it can be tested.
 *
 * The checks are the trainer's own, in the order it raises them, plus the three it does NOT look at and that
 * ruin a capture silently: clipping, DC, and a take so quiet the amp never woke up. Every finding carries the
 * number that found it, because "the capture is bad" is not actionable and "the recording is 2.000 s shorter
 * than the input, and the trainer refuses past 0 s" is.
 */
export function checkCapture({
  input,
  recorded,
  inputRate,
  recordedRate,
  inputVersion = null,
  inputMajor = null,
}) {
  const facts = {};
  const issues = [];

  facts.inputFrames = input.length;
  facts.recordedFrames = recorded.length;
  facts.inputRate = inputRate;
  facts.recordedRate = recordedRate;
  facts.inputVersion = inputVersion;
  facts.inputSeconds = input.length / inputRate;
  facts.recordedSeconds = recorded.length / recordedRate;
  facts.deltaSeconds = facts.recordedSeconds - facts.inputSeconds;

  // ── 1. The input has to be one the trainer recognises, or nothing else matters ────────────────────────
  if (inputVersion === null) {
    issues.push({
      level: 'fail',
      what: 'the trainer will not recognise this input file',
      detail: 'NAM identifies its input by MD5 and refuses anything unknown — "cannot be recognized as any '
        + 'known version". Run `audio-capture.mjs input` to fetch the official one, or point --input at it.',
    });
  }

  // ── 2. Sample rates, then lengths: the two the trainer raises on ───────────────────────────────────────
  if (inputRate !== recordedRate) {
    issues.push({
      level: 'fail',
      what: 'the two files are at different sample rates',
      detail: `${inputRate} Hz in, ${recordedRate} Hz out — the trainer raises "Different sample rates detected" `
        + 'and stops. Record at the input file\'s rate; a resampled capture measures the resampler anyway.',
    });
    // Everything below compares the two files to each other, so it would produce a second, misleading finding
    // for one cause. Clipping and DC are still worth reporting, so they are computed before returning.
    const nn = Math.min(input.length, recorded.length);
    facts.recordedRmsDb = 20 * Math.log10(rms(recorded.subarray(0, nn)) || 1e-30);
    facts.recordedPeakDb = 20 * Math.log10(peak(recorded.subarray(0, nn)) || 1e-30);
    let c = 0;
    for (let i = 0; i < nn; i++) if (Math.abs(recorded[i]) >= 0.999) c++;
    facts.clippedSamples = c;
    return { ok: false, facts, issues };
  }

  if (facts.deltaSeconds < -V3.maxUnderSeconds) {
    issues.push({
      level: 'fail',
      what: 'the recording is shorter than the input file',
      detail: `${facts.deltaSeconds.toFixed(3)} s — the trainer allows ${V3.maxUnderSeconds} s shorter and `
        + `${V3.maxOverSeconds} s longer, then refuses with "Check your reamp in your DAW". The tail it never `
        + 'saw is the tail the model will not reproduce.',
    });
  } else if (facts.deltaSeconds > V3.maxOverSeconds) {
    issues.push({
      level: 'fail',
      what: 'the recording is more than a second longer than the input file',
      detail: `${facts.deltaSeconds.toFixed(3)} s (max ${V3.maxOverSeconds} s) — trim the tail to match.`,
    });
  }

  // ── 3. Silence, clipping, DC — what the trainer does not check and a capture still dies of ────────────
  const n = Math.min(input.length, recorded.length);
  // Every fact is computed before any of them is judged, so a report is complete even when one finding is
  // fatal — a fail that also blanks the numbers leaves the user with nothing to act on.
  const recRms = rms(recorded.subarray(0, n));
  facts.recordedRmsDb = 20 * Math.log10(recRms || 1e-30);
  facts.recordedPeakDb = 20 * Math.log10(peak(recorded.subarray(0, n)) || 1e-30);
  let clipped = 0;
  for (let i = 0; i < n; i++) if (Math.abs(recorded[i]) >= 0.999) clipped++;
  facts.clippedSamples = clipped;
  const mean = (x) => { let s = 0; for (let i = 0; i < n; i++) s += x[i]; return s / n; };
  facts.recordedDc = mean(recorded.subarray(0, n));

  if (recRms < 1e-6) {
    issues.push({ level: 'fail', what: 'the recording is silent', detail: `rms ${facts.recordedRmsDb.toFixed(1)} dBFS` });
    return { ok: false, facts, issues };
  }

  if (clipped > 0) {
    issues.push({
      level: clipped > n * 0.0005 ? 'fail' : 'warn',
      what: 'the recording clips',
      detail: `${clipped} sample${clipped === 1 ? '' : 's'} at or above full scale (peak ${facts.recordedPeakDb.toFixed(2)} dBFS) `
        + '— that distortion is in the file, so the model will learn it as part of the amp',
    });
  }

  if (Math.abs(facts.recordedDc) > 0.001) {
    issues.push({ level: 'warn', what: 'the recording has a DC offset', detail: facts.recordedDc.toFixed(5) });
  }
  if (facts.recordedRmsDb < -40) {
    issues.push({
      level: 'warn',
      what: 'the recording is very quiet',
      detail: `rms ${facts.recordedRmsDb.toFixed(1)} dBFS — if the amp was never driven, the model learns its `
        + 'clean region and nothing else',
    });
  }

  // ── 4. The v3-specific two: did the amp hold still, and where will the trainer align it ───────────────
  // Gated on the length, because the trainer raises on length and never reaches these — reporting "the amp did
  // not hold still" for a file that is simply too short would send the user after the wrong problem.
  const lengthOk = facts.deltaSeconds >= -V3.maxUnderSeconds && facts.deltaSeconds <= V3.maxOverSeconds;
  if (inputMajor === 3 && lengthOk) {
    // REPLICATE ESR. v3's input carries the same validation signal at the start and at the end, so the amp's
    // two responses to it should be nearly identical. If they are not, something moved — a knob, a tube warming
    // up, a mic — and the trainer treats it as bad data (`_check_v3`, threshold 0.01).
    const t = V3.tValidate;
    facts.replicateEsr = esr(recorded.subarray(0, t), recorded.subarray(recorded.length - t, recorded.length));
    if (!(facts.replicateEsr <= 0.01)) {
      issues.push({
        level: 'fail',
        what: 'the amp did not hold still for the take',
        detail: `replicate ESR ${facts.replicateEsr.toFixed(6)} against a limit of 0.01 — the two validation `
          + 'sections are the same signal at the start and the end, so a difference means a knob moved, the amp '
          + 'drifted, or the room changed. NAM\'s own check fails this data.',
      });
    }
    const lat = blipLatency(recorded);
    facts.latency = lat;
    if (!lat.detected) {
      issues.push({
        level: 'fail',
        what: 'the recording never responded to the input\'s impulses',
        detail: `nothing in the window exceeded the trigger of ${lat.threshold.toExponential(2)} (the amp's own `
          + `noise floor in the gap before them is ${lat.background.toExponential(2)}). NAM prints "Is something `
          + 'wrong with the reamp?" and its alignment cannot run.',
      });
    } else if (lat.hitLookahead) {
      issues.push({
        level: 'warn',
        what: 'the alignment tripped on its first sample',
        detail: `delay ${lat.delay} equals -lookahead, which usually means the noise floor reached the trigger `
          + `(${lat.threshold.toExponential(2)}) before the impulse did. NAM warns about this too.`,
      });
    }
  }

  return { ok: !issues.some((i) => i.level === 'fail'), facts, issues };
}
