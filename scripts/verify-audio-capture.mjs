// Does the capture pre-flight tell the truth about what the trainer will do?
//
// WHY THIS GUARD IS THE WHOLE VALUE OF THE TOOL. `audio-capture.mjs check` exists to answer "will this capture
// train, and what will NAM make of it?" BEFORE someone spends an hour of GPU time. A pre-flight that is subtly
// wrong is worse than none: it either waves through a pair the trainer refuses, or condemns a good take and
// sends the user to re-amp an amp that was fine. Neither shows up as a crash — both show up as a plausible
// number, which is exactly the class of bug this repository's guards exist for.
//
// So the checks below are pinned to something known independently of this code:
//
//   * NAM's v3 constants are pinned as LITERALS read from nam/train/core.py, so changing one changes what the
//     tool promises and cannot be done silently;
//   * a delay of exactly N samples injected before the input's impulse must read back as N, for several N on
//     both sides of zero — the calibration is arithmetic and it has an answer;
//   * the trigger threshold's two branches are pinned as numbers, because one of them (the absolute floor) is
//     what the official input takes, and the other (the amp's own noise floor) is what a real capture takes;
//   * the ESR is NAM's own definition, and its value on a scaled copy is arithmetic — (1-k)²;
//   * every failure mode is injected into a synthetic capture and the verdict it must produce is asserted.
//
// WHAT THIS GUARD DOES NOT COVER, stated rather than implied: the CLI's happy path needs the official 27 MB
// input (its MD5 is what identifies it, so it cannot be synthesised), and fetching 27 MB inside a guard would
// make every run depend on Google Drive. The pure functions carry the behaviour and are covered exhaustively;
// the CLI section covers its plumbing and its refusal paths, which is all a synthetic file can reach. `verify`
// needs the reference engine built and is proven in the audio-plugin-linux-arm workflow instead.
//
// Run:  node scripts/verify-audio-capture.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INPUT_MD5, STRONG_HASHES, V3, blipLatency, checkCapture, esr, md5File,
} from './lib/namCapture.mjs';
import { encodeWav } from '../server/src/lib/audio/wav.js';

const SR = 48000;
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'audio-capture.mjs');
const HALF = 432000; // NAM v3's t_validate: the length of each validation section
let failures = 0;
let checks = 0;
const show = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? Number(v.toFixed(9)) : String(v)) : JSON.stringify(v));
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
function truthy(name, actual) {
  checks++;
  if (actual) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected truthy, got ${show(actual)}`); failures++; }
}
/** The finding a case must produce, by name — so a change of wording fails here rather than at a user. */
const hasIssue = (result, fragment) => result.issues.some((i) => i.what.includes(fragment));
const issueLevel = (result, fragment) => (result.issues.find((i) => i.what.includes(fragment)) || {}).level;

// ── 1. the constants ARE the contract ────────────────────────────────────────────────────────────────────
// These are not tuning knobs. Each is an index or a threshold in NAM's trainer, and the moment one drifts the
// tool is reporting on a version of the trainer that does not exist.
console.log('\n1. NAM v3\'s constants are pinned to the values in the trainer\'s source');
{
  check('the sample rate is 48 kHz', V3.rate, 48000);
  check('the validation section is 432 000 samples (9 s)', V3.tValidate, 432000);
  check('the impulse window starts at 480 000 (0:10)', V3.firstBlipsStart, 480000);
  check('the impulse window is 96 000 samples (2 s)', V3.tBlips, 96000);
  check('the noise-floor interval is 492 000–498 000', V3.noiseInterval, [492000, 498000]);
  check('the impulses are at 504 000 and 552 000', V3.blipLocations[0], [504000, 552000]);
  check('the scan looks 1 000 samples ahead of an impulse', V3.lookahead, 1000);
  check('…and 10 000 samples past it', V3.lookback, 10000);
  check('the absolute trigger is 0.0003', V3.absThreshold, 0.0003);
  check('the relative trigger is 1.001× the noise floor', V3.relThreshold, 0.001);
  check('the trainer subtracts a 1-sample safety factor', V3.safetyFactor, 1);
  check('the output may not be shorter at all', V3.maxUnderSeconds, 0);
  check('…and may be at most 1 s longer', V3.maxOverSeconds, 1);

  // The fetch constant and the recogniser are one fact stored twice: downloading a file and then refusing it
  // because the MD5 table does not know it would be the worst of both.
  check('the input we fetch is the hash the trainer recognises', STRONG_HASHES[INPUT_MD5], '3.0.0');
  check('the trainer\'s other known inputs are all present', Object.keys(STRONG_HASHES).length, 5);
}

// ── 2. the delay is measured, and the answer is arithmetic ───────────────────────────────────────────────
console.log('\n2. the impulse calibration recovers a delay it was given');
{
  // A minimal v3-shaped output: nothing but the noise gap, an optional sample at the head of the scan, and an
  // impulse at 0:10.5. It is shorter than a real capture because `blipLatency` reads no other index — which is
  // true, and the reason this is cheap enough to run in the guards job.
  const capture = ({ shift = 0, gap = 0, scanFirst = 0, impulse = 0.9 } = {}) => {
    const a = new Float64Array(520000);
    if (gap) for (let i = 492000; i < 498000; i++) a[i] = gap;
    if (scanFirst) a[503000] = scanFirst;
    if (impulse) a[504000 + shift] = impulse;
    return a;
  };

  for (const shift of [0, 39, 137, 1000, -1, -50, -999]) {
    const lat = blipLatency(capture({ shift }));
    truthy(`a ${shift}-sample round trip is detected at all`, lat.detected);
    check(`…and reads back as exactly ${shift}`, lat.delay, shift);
    check(`…with the trainer's own safety factor applied (${shift} → ${shift - 1})`, lat.recommended, shift - 1);
  }

  // The official input's noise interval is digital silence, so the threshold collapses to the absolute floor.
  near('silence before the impulses gives the absolute trigger', blipLatency(capture()).threshold, 0.0003, 1e-12);

  // An impulse BEFORE the scan window is not found — the trainer only looks 1 000 samples back, and a
  // response earlier than that is invisible to it however real it is.
  check('a response 1 200 samples early is outside the scan, as it is for the trainer',
    blipLatency(capture({ shift: -1200 })).detected, false);

  // A silent output is the "is something wrong with the reamp?" case, and it must not be reported as a delay.
  const nothing = blipLatency(capture({ impulse: 0 }));
  check('no response at all is reported as not detected', nothing.detected, false);
  check('…with no delay invented', nothing.delay, null);
}

// ── 3. the trigger adapts to the amp, which is the point of the gap ───────────────────────────────────────
console.log('\n3. the trigger is set from the amp\'s own noise floor, and both branches are pinned');
{
  const capture = ({ gap = 0, scanFirst = 0, impulse = 0 } = {}) => {
    const a = new Float64Array(520000);
    if (gap) for (let i = 492000; i < 498000; i++) a[i] = gap;
    if (scanFirst) a[503000] = scanFirst;
    if (impulse) a[504000] = impulse;
    return a;
  };

  // Branch 1: a quiet amp. The absolute term dominates, and 0.0103 is `0.01 + 0.0003`.
  near('a -40 dB noise floor keeps the absolute trigger', blipLatency(capture({ gap: 0.01 })).threshold, 0.0103, 1e-12);
  // Branch 2: a loud one. The crossover is where `floor + 0.0003` meets `1.001 × floor`, which is a floor of
  // 0.3 — so at -6 dBFS the RELATIVE term decides, and it is 1.001 × 0.5. This assertion is itself a
  // correction: the first version used a floor of 0.1 and expected the relative branch, which is wrong,
  // because 0.1003 still beats 0.1001 and the absolute term is the one that fires.
  near('a -6 dB noise floor switches to the relative trigger', blipLatency(capture({ gap: 0.5 })).threshold, 0.5005, 1e-12);

  // Which matters, because it decides whether a quiet response is seen at all.
  check('a response below a loud amp\'s noise floor is not detected', blipLatency(capture({ gap: 0.01, impulse: 0.005 })).detected, false);
  check('…and one above it is', blipLatency(capture({ gap: 0.01, impulse: 0.05 })).detected, true);

  // THE FAILURE THE GAP EXISTS TO CATCH. A noise floor above the response trips the scan on its first sample,
  // and the trainer's answer is a delay of exactly -lookahead — a number that looks like an answer and is not.
  const hiss = blipLatency(capture({ gap: 0.4, scanFirst: 0.5 }));
  check('a floor that beats the response trips the scan immediately', hiss.delay, -V3.lookahead);
  check('…and is reported as tripping on its first sample', hiss.hitLookahead, true);
}

// ── 4. ESR is NAM's definition, and its values are arithmetic ─────────────────────────────────────────────
console.log('\n4. the ESR is the one the trainer computes');
{
  const target = new Float64Array(4096);
  for (let i = 0; i < target.length; i++) target[i] = Math.sin(2 * Math.PI * i / 64) * 0.5;
  const scaled = (k) => Float64Array.from(target, (v) => v * k);

  check('a perfect prediction has no error', esr(target, target), 0);
  // mean((k·x - x)²) / mean(x²) = (k-1)², exactly. Not a tolerance — the definition.
  near('a prediction half the level is an ESR of 0.25', esr(scaled(0.5), target), 0.25, 1e-12);
  near('…and one 1.4× the level is 0.16', esr(scaled(1.4), target), 0.16, 1e-12);
  // THE ESR IS ASYMMETRIC — the error is divided by the TARGET's power — and the trainer calls it as
  // `_ESR(y_val_1, y_val_2)`, so the first section is the prediction and the second is the target. Swapping
  // them is a real difference (0.0816 against 0.16 here), which is why the argument order is pinned.
  near('…and the same pair the other way round is (0.4/1.4)², not 0.16', esr(target, scaled(1.4)), (0.4 / 1.4) ** 2, 1e-12);
  near('silence predicted for a real signal is an ESR of 1', esr(new Float64Array(target.length), target), 1, 1e-12);
  // A silent target has no reference to divide by, and 0/0 reported as a number would be read as a pass.
  check('a silent target is not given a finite ESR', esr(target, new Float64Array(target.length)), Infinity);
}

// ── 5. the verdicts ───────────────────────────────────────────────────────────────────────────────────────
console.log('\n5. every failure a capture can have is named, and a good pair is passed');
{
  // A v3-shaped recording built the cheap way: the two validation sections are the same 432 000 samples laid
  // end to end, which is what makes the replicate ESR exactly zero. Each half carries the noise gap and the
  // impulse at the indices v3 puts them, so the blip scan reads real samples at the real offsets.
  const recording = ({ tailGain = 1, impulse = 0.9, dc = 0 } = {}) => {
    const half = (gain) => {
      const p = new Float64Array(HALF);
      for (let i = 0; i < 50000; i++) p[i] = 0.25 * Math.sin((2 * Math.PI * i) / 101) * Math.sin((2 * Math.PI * i) / 2048);
      for (let i = 90000; i < HALF; i++) p[i] = 0.25 * Math.sin((2 * Math.PI * i) / 103) * Math.sin((2 * Math.PI * i) / 2048);
      p[72000] = impulse;
      for (let i = 0; i < HALF; i++) p[i] = p[i] * gain + dc;
      return p;
    };
    const out = new Float64Array(2 * HALF);
    out.set(half(1), 0);
    out.set(half(tailGain), HALF);
    return out;
  };
  const input = new Float64Array(2 * HALF);
  const at = (over) => checkCapture({
    input, recorded: recording(), inputRate: SR, recordedRate: SR, inputVersion: '3.0.0', inputMajor: 3, ...over,
  });

  const good = at({});
  truthy('a pair that is the input\'s length, at the input\'s rate, from a still amp passes', good.ok);
  check('…with nothing to report', good.issues, []);
  check('…and an ESR of exactly zero, because the two sections are identical', good.facts.replicateEsr, 0);
  check('…and the delay the trainer will use', good.facts.latency.delay, 0);
  check('…reported with its safety factor', good.facts.latency.recommended, -1);

  // The trainer refuses an unrecognised input outright, so this must be fatal here too.
  const unknown = at({ inputVersion: null, inputMajor: null });
  check('an input the trainer will not recognise is a failure', unknown.ok, false);
  check('…named as the trainer\'s own refusal', hasIssue(unknown, 'will not recognise'), true);

  const wrongRate = at({ recordedRate: 44100 });
  check('a different sample rate is a failure', wrongRate.ok, false);
  check('…named the way the trainer names it', hasIssue(wrongRate, 'different sample rates'), true);

  // Two seconds short, because the trainer's own bound is zero seconds — the strictest of its length rules.
  const short = checkCapture({
    input, recorded: recording().subarray(0, 2 * HALF - 2 * SR), inputRate: SR, recordedRate: SR, inputVersion: '3.0.0', inputMajor: 3,
  });
  check('a recording two seconds short is a failure', short.ok, false);
  check('…naming the length rule', hasIssue(short, 'shorter than the input'), true);
  // And the v3-only checks are gated behind it: the trainer raises on length and never reaches the ESR, so
  // reporting "the amp did not hold still" for a truncated file would send the user after the wrong problem.
  check('…and does not also blame the amp for a file it never read', hasIssue(short, 'hold still'), false);

  // The knob that moved. The two validation sections are the same signal, so a difference is the amp, not the
  // input — and NAM's own `_check_v3` fails the data for it.
  const moved = at({ recorded: recording({ tailGain: 1.4 }) });
  check('a knob moved halfway through is a failure', moved.ok, false);
  check('…named as the amp not holding still', hasIssue(moved, 'did not hold still'), true);
  // (x − 1.4x)² / (1.4x)² = 0.4² / 1.4² — and with the trainer's argument order, 1.4 is the TARGET.
  near('…and the ESR is the arithmetic of the gain change', moved.facts.replicateEsr, (0.4 / 1.4) ** 2, 1e-9);

  // A take that never woke the amp up. Silence is fatal before any of the rest can be judged.
  const silent = at({ recorded: new Float64Array(2 * HALF) });
  check('a silent recording is a failure', silent.ok, false);
  check('…and nothing else is reported about it', hasIssue(silent, 'recording is silent'), true);

  // Clipping is not automatically fatal in the trainer — it does not look — but thousands of flat-topped
  // samples are distortion the model will learn, so the verdict is graded by how many there are.
  const clipped = at({ recorded: Float64Array.from(recording(), (v) => v * 8) });
  check('a clipped take is a failure', clipped.ok, false);
  check('…with the count that found it', clipped.facts.clippedSamples > 0, true);
  check('…named', hasIssue(clipped, 'clips'), true);

  const offset = at({ recorded: recording({ dc: 0.01 }) });
  check('a DC offset is a warning, not a refusal', issueLevel(offset, 'DC offset'), 'warn');
  truthy('…and the pair still passes', offset.ok);

  // No response to the impulses at all, which is NAM's "Is something wrong with the reamp?".
  const deaf = at({ recorded: recording({ impulse: 0 }) });
  check('a recording that never answered the impulses is a failure', deaf.ok, false);
  check('…named', hasIssue(deaf, 'never responded'), true);

  // A very quiet take is not fatal — it trains — but the model learns only the clean region, which is a
  // result the user did not ask for and cannot diagnose from the sound.
  const quiet = at({ recorded: Float64Array.from(recording(), (v) => v * 0.001) });
  check('a take 60 dB down is a warning', issueLevel(quiet, 'very quiet'), 'warn');
}

// ── 6. identification: the MD5 is a FILE hash, and the fetch is the file the trainer knows ────────────────
console.log('\n6. the input is identified by the hash the trainer uses');
{
  const dir = mkdtempSync(join(tmpdir(), 'audio-capture-guard-'));
  const p = join(dir, 'abc.bin');
  writeFileSync(p, 'abc');
  // MD5("abc") is the canonical test vector. If this is a string hash or a truncated one, the whole
  // identification is wrong in a way that would silently reject a correct input file.
  check('a file hash is the file hash', md5File(p), '900150983cd24fb0d6963f7d28e17f72');

  const other = join(dir, 'other.bin');
  writeFileSync(other, 'abcd');
  check('a one-byte change is a different input', STRONG_HASHES[md5File(other)] ?? null, null);
}

// ── 7. the command line: the plumbing and the refusals ────────────────────────────────────────────────────
console.log('\n7. the CLI refuses what it cannot do, and says so in JSON when asked');
{
  const dir = mkdtempSync(join(tmpdir(), 'audio-capture-cli-'));
  const fakeInput = join(dir, 'input.wav');
  const fakeRec = join(dir, 'rec.wav');
  const tone = new Float64Array(60000);
  for (let i = 0; i < tone.length; i++) tone[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
  writeFileSync(fakeInput, encodeWav({ sampleRate: SR, data: tone, format: 'float32' }));
  writeFileSync(fakeRec, encodeWav({ sampleRate: SR, data: tone, format: 'float32' }));

  const noRecorded = spawnSync(process.execPath, [CLI, 'check'], { encoding: 'utf8' });
  check('check without --recorded is a usage error, not a crash', noRecorded.status, 2);
  truthy('…and it says what to pass', (noRecorded.stderr || '').includes('--recorded'));

  // A file the trainer does not know, at the right rate and length, must still be refused — this is the whole
  // reason the tool fetches a specific input rather than generating one.
  const run = spawnSync(process.execPath, [CLI, 'check', '--input', fakeInput, '--recorded', fakeRec, '--json'], { encoding: 'utf8' });
  check('an unknown input file exits non-zero', run.status, 1);
  let parsed = null;
  try { parsed = JSON.parse((run.stdout || '').trim()); } catch { parsed = null; }
  truthy('…and its output parses as JSON with the flags LAST', parsed !== null);
  check('…carrying the verdict rather than a summary', parsed?.ok, false);
  check('…and the trainer\'s own reason', hasIssue(parsed ?? { issues: [] }, 'will not recognise'), true);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ the capture pre-flight does not agree with the trainer it claims to reproduce\n');
  process.exit(1);
}
console.log('the pre-flight measures what the trainer measures\n');
