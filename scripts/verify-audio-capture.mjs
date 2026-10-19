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
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INPUT_MD5, STRONG_HASHES, V3, blipLatency, checkCapture, esr, md5File,
} from '../server/src/lib/audio/namCapture.js';
import { encodeWav } from '../server/src/lib/audio/wav.js';

const SR = 48000;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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
function above(name, actual, limit) {
  checks++;
  if (Number.isFinite(actual) && actual > limit) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected > ${limit}\n          got      ${show(actual)}`); failures++; }
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

// ── 8. the app's side: the endpoint, and the panel that calls it ──────────────────────────────────────────
// The pre-flight shipped as a command line first and the panel came second, so what can go wrong here is a
// SECOND implementation — a route that re-derives the length rule or the impulse calibration, or a panel that
// hardcodes the re-amp signal's hash — and a split like that is invisible until the two disagree about the
// same upload. Everything below is either a real call with real WAV bytes or an assertion that there is only
// one copy of a rule.
console.log('\n8. the endpoint and the panel run the same code, and store nothing');
{
  const { runCaptureCheck } = await import('../server/src/lib/audio/captureCheck.js');
  const { MAX_CAPTURE_BYTES } = await import('../server/src/lib/audio/namCapture.js');
  const wav = (seconds, freq, rate = SR) => {
    const n = Math.round(seconds * rate);
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * freq * i) / rate);
    return encodeWav({ sampleRate: rate, data: x, format: 'float32' });
  };
  const asFile = (name, buffer) => ({ filename: name, buffer });

  // ⭐ THE BOUND MUST BE ABOVE THE FILE EVERYONE HAS TO UPLOAD. A size limit below the official re-amp signal
  // would reject the one input the trainer accepts, and it would do it as "too large" — which reads as the
  // user's fault. 27,360,080 bytes is the file, measured.
  above('the upload limit is above the official re-amp signal (27,360,080 bytes)', MAX_CAPTURE_BYTES, 27360080);

  // A real call, with real bytes: a WAV that is not a known input is judged and reported honestly rather than
  // crashing or being accepted.
  const dryBytes = wav(3, 220);
  const md5OfDry = createHash('md5').update(dryBytes).digest('hex');
  const unknown = runCaptureCheck({ input: asFile('dry.wav', dryBytes), recorded: asFile('amp.wav', wav(3, 440)) });
  check('an acceptable WAV the trainer would not recognise comes back as a verdict, not an error',
    unknown.status, 200);
  check('…and the verdict is that the trainer will not take it', unknown.body.ok, false);
  check('…naming the reason', hasIssue(unknown.body, 'will not recognise'), true);
  check('…and carrying the hash of the bytes it was given, so the user can compare it with the one they downloaded',
    unknown.body.inputMd5, md5OfDry);
  check('…with both file names echoed back', unknown.body.inputName === 'dry.wav' && unknown.body.recordedName === 'amp.wav', true);

  check('one file alone is refused', runCaptureCheck({ input: asFile('a.wav', wav(1, 220)), recorded: null }).status, 400);
  check('nothing at all is refused', runCaptureCheck({ input: null, recorded: null }).status, 400);
  const notWav = runCaptureCheck({ input: asFile('notes.txt', Buffer.from('this is not audio at all, not even close')), recorded: asFile('b.wav', wav(1, 220)) });
  check('a non-WAV is refused before anything is decoded', notWav.status, 400);
  check('…and it says WHICH file', String(notWav.body.error).includes('notes.txt'), true);
  const tiny = runCaptureCheck({ input: asFile('a.wav', Buffer.alloc(8)), recorded: asFile('b.wav', wav(1, 220)) });
  check('a file too small to hold a header is refused', tiny.status, 400);

  // ⚠️ THE MEMORY CLAIM, ASSERTED RATHER THAN COMMENTED. The official input is 9.12 M frames and becomes a
  // 73 MB Float64Array on decode; the endpoint only ever wants its frame count, so it must pass `inputFrames`
  // and drop the buffer. A later edit that passes `input` instead would still pass every behavioural check
  // above while holding 73 MB for the rest of the request.
  const checkSrc = readFileSync(join(ROOT, 'server/src/lib/audio/captureCheck.js'), 'utf8');
  check('the endpoint passes the input\'s frame count, not its samples', /inputFrames,/.test(checkSrc), true);
  check('…and releases the decode before the second file is read', /wav = null;/.test(checkSrc), true);

  // THE ROUTE IS WIRING ONLY. If it ever imports the rules itself, there are two implementations again.
  const routeSrc = readFileSync(join(ROOT, 'server/src/routes/capture.routes.js'), 'utf8');
  const indexSrc = readFileSync(join(ROOT, 'server/src/index.js'), 'utf8');
  check('the capture route is mounted', /app\.use\('\/api\/capture', captureRoutes\)/.test(indexSrc), true);
  check('…and imported', /import captureRoutes from '\.\/routes\/capture\.routes\.js'/.test(indexSrc), true);
  // The route may import the CONSTANTS — the download URL, the hash, the size bound are all it needs for
  // multipart — but if it ever imports a rule, there are two implementations of the length check or the
  // impulse calibration and they will disagree about the same upload eventually. (Not a substring test on
  // `checkCapture`, which `runCaptureCheck` contains.)
  const RULES = ['checkCapture', 'blipLatency', 'esr', 'validateCaptureWav', 'identifyBytes'];
  truthy('the route is wiring: it takes the constants and none of the rules',
    /runCaptureCheck/.test(routeSrc)
    && !RULES.some((n) => new RegExp(`\\b${n}\\b`).test(routeSrc)));
  check('the route imports no database, because there is nothing to store',
    !/prisma/.test(routeSrc) && !/uploadFile/.test(routeSrc), true);
  check('…and neither does the code it calls', !/prisma|writeFileSync|uploadFile/.test(checkSrc), true);

  // THE PANEL. A button that opens a dialog nobody can reach, or a client method that names an endpoint that
  // does not exist, are both green-build failures, so the three files are checked against each other.
  const panelSrc = readFileSync(join(ROOT, 'src/components/matrix/CaptureDialog.jsx'), 'utf8');
  const clientSrc = readFileSync(join(ROOT, 'src/api/base44Client.js'), 'utf8');
  const compileSrc = readFileSync(join(ROOT, 'src/components/matrix/CompilePanel.jsx'), 'utf8');
  check('the client exposes both capture calls to the documented endpoints',
    /captureAbout: \(\) => apiFetch\('\/capture\/about'\)/.test(clientSrc)
    && /checkCapture: \(form\) => apiFetch\('\/capture\/check'/.test(clientSrc), true);
  check('the panel calls them', /base44\.functions\.checkCapture\(/.test(panelSrc) && /base44\.functions\.captureAbout\(/.test(panelSrc), true);
  check('…and is reachable, on the audio targets only',
    /<CaptureDialog/.test(compileSrc) && /setShowCapture\(true\)/.test(compileSrc)
    && /startsWith\('audio-plugin-'\)/.test(compileSrc), true);
  check('the panel states what it does NOT do rather than leaving it to be discovered',
    /does not train/i.test(panelSrc), true);
  // The hash and the download link come from the server, so the panel cannot promise a file the module does
  // not recognise — which is the one mistake that wastes an afternoon.
  check('the panel does not hardcode the re-amp signal\'s hash', !/36cd1af62985c2fac3e654333e36431e/.test(panelSrc), true);
}

// ── the CABINET capture: a linear system, so a known answer exists ────────────────────────────────────────
// ⚠️ AN AMP CAPTURE CAN ONLY BE CHECKED AGAINST THE TRAINER'S RULES, because training is a fit and the answer
// depends on the GPU. A CABINET IS LINEAR, so the capture has an exact answer: convolve a known response with
// the sweep, deconvolve, and the response must come back. That is what makes this half provable without any
// hardware at all — and it is the check that would catch a deconvolution that is subtly wrong, which otherwise
// produces a perfectly plausible-looking cabinet that is not the one anybody recorded.
console.log('\n14. the cabinet capture recovers the cabinet it was given');
const { sweepSignal, deconvolve, normaliseIr, checkIr, IR_SWEEP, DEFAULT_TAPS } = await import('../server/src/lib/audio/irCapture.js');
const { fftInPlace, nextPow2, biquadCoefficients, biquadProcess } = await import('../server/src/lib/audio/dsp.js');
const { whiteNoise } = await import('../server/src/lib/audio/signals.js');

const IR_RATE = 48000;
const irSweep = sweepSignal({ sampleRate: IR_RATE });

/** A speaker-like response: band-limited, decaying, and nothing above what the sweep covers. */
function speakerLike({ taps = 2048, seed = 3, cutoff = 6000, decay = 400 } = {}) {
  const raw = whiteNoise({ length: taps, seed, amplitude: 1 });
  const lp = biquadProcess(biquadCoefficients({ type: 'lowpass', freq: cutoff, q: 0.707, sampleRate: IR_RATE }), raw);
  const out = new Float64Array(taps);
  for (let i = 0; i < taps; i++) out[i] = lp[i] * Math.exp(-i / decay);
  return out;
}

/** Linear convolution by FFT — the operation the capture undoes. */
function convolve(a, b) {
  const size = nextPow2(a.length + b.length - 1);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(a);
  fftInPlace(re, im);
  const hr = new Float64Array(size);
  const hi = new Float64Array(size);
  hr.set(b);
  fftInPlace(hr, hi);
  for (let i = 0; i < size; i++) {
    const r = re[i] * hr[i] - im[i] * hi[i];
    const m = re[i] * hi[i] + im[i] * hr[i];
    re[i] = r; im[i] = m;
  }
  for (let i = 0; i < size; i++) im[i] = -im[i];
  fftInPlace(re, im);
  for (let i = 0; i < size; i++) re[i] /= size;
  return re;
}

/** Relative error between a recovered IR and the truth, aligned as the window aligns them. */
function recoveryError(got, want, start) {
  let err = 0;
  let scale = 0;
  for (let i = 0; i < want.length; i++) {
    const t = want[start + i] ?? 0;
    err += (t - got[i]) ** 2;
    scale += t * t;
  }
  return Math.sqrt(err / scale);
}

const cabinet = speakerLike();
const take = convolve(irSweep, cabinet);
// ⚠️ THE PRODUCT'S LEVEL RULE IS NOT A SHAPE RULE, SO THE COMPARISON PEAK-ALIGNS — IN THE TEST.
// `normaliseIr` now scales to the gain pink noise sees (the bake's rule, see cabIr.js's `cabTapGain`), and two
// DIFFERENT signals normalised that way do not land on the same number: one here is the cabinet, the other is
// a slightly imperfect recovery of it, and their spectra differ enough to move the scale. `recoveryError`
// compares amplitudes absolutely, so the two have to be brought to a common scale before it is asked anything.
// That belongs HERE rather than in the product: a test bends its comparison to fit the rule, not the rule to
// fit a comparison.
const peakAlign = (a) => {
  let p = 0;
  for (const v of a) p = Math.max(p, Math.abs(v));
  return p > 0 ? Float64Array.from(a, (v) => v / p) : a;
};
const recovered = peakAlign(normaliseIr(deconvolve(take, irSweep, { taps: 2048 }).ir).ir);
// ⚠️ ALIGNED AS THE WINDOW ALIGNS IT. The window keeps a few samples before the peak, which is why the
// comparison starts a few samples early.
let cabinetPeak = 0;
for (let i = 0; i < cabinet.length; i++) if (Math.abs(cabinet[i]) > Math.abs(cabinet[cabinetPeak])) cabinetPeak = i;
const cabinetNorm = peakAlign(normaliseIr(cabinet).ir);
check('⭐ a known cabinet comes back out of a take of it, to within a few percent',
  recoveryError(recovered, cabinetNorm, Math.max(0, cabinetPeak - 8)) < 0.05, true);
check('…and the sweep has been REMOVED, not passed through — recovering the sweep is not recovering the cabinet',
  recoveryError(recovered, peakAlign(normaliseIr(Float64Array.from({ length: 2048 }, (_, i) => irSweep[i + 24000] ?? 0)).ir), 0) > 0.5, true);

const offset = deconvolve(convolve(irSweep, cabinet), irSweep, { taps: 2048, preDelay: 0 });
check('…and the response is located in the take rather than assumed to start at zero',
  Number.isFinite(offset.latencySamples) && offset.windowStart >= 0, true);

// ⚠️ THE REGULARISATION IS NOT DECORATION. Without it the division blows up wherever the sweep has no energy,
// and the "cabinet" is a full-scale noise filter — which is what makes this a claim worth a mutation.
const blurry = normaliseIr(deconvolve(take, irSweep, { taps: 2048, eps: 1e-1 }).ir).ir;
const sharp = recoveryError(recovered, cabinetNorm, Math.max(0, cabinetPeak - 8));
check('over-regularising measurably blurs the response, so the default is a decision and not a no-op',
  recoveryError(blurry, cabinetNorm, Math.max(0, cabinetPeak - 8)) > sharp * 2, true);

check('the taps kept are the taps asked for, so the window is not decided by the take',
  deconvolve(take, irSweep, { taps: 512 }).ir.length, 512);
check('…and the default is the cap the plugin convolves, so nothing is silently cut',
  [DEFAULT_TAPS, DEFAULT_TAPS <= 4096], [4096, true]);

// A silent take is the common real failure (muted mic, wrong input), and it must not produce a cabinet.
const silent = checkIr(new Float64Array(1024), { sampleRate: IR_RATE });
check('a silent take is refused rather than turned into a cabinet',
  [silent.ok, silent.issues.some((i) => /silent/.test(i.what))], [false, true]);
check('…and a response that is all room is warned about, because it is real and not fatal',
  checkIr(Float64Array.from({ length: 8192 }, (_, i) => Math.sin(i / 7) * Math.exp(-i / 7000)), { sampleRate: IR_RATE })
    .issues.some((i) => i.level === 'warn'), true);

// The sweep itself: silence at both ends, or the cabinet's tail is cut off by the recording.
const lead = irSweep.findIndex((v) => v !== 0);
const tailAt = irSweep.length - 1 - [...irSweep].reverse().findIndex((v) => v !== 0);
// ⚠️ THE TAIL SILENCE IS WHAT THE CABINET'S DECAY HAPPENS IN, so the assertion is that the file ENDS silent
// and that the silence is as long as documented. Asserting that the last NONZERO sample is at the end of the
// file would be asserting the opposite of the property.
const tailSilence = irSweep.length - 1 - tailAt;
check('the sweep has silence at BOTH ends, so the cabinet tail is recorded rather than truncated',
  [lead > 0.4 * IR_RATE, irSweep[irSweep.length - 1] === 0 && tailSilence > 1.4 * IR_RATE], [true, true]);
check('…and it is 500 ms of lead, 3 s of sweep and 1.5 s of tail at the default rate',
  [IR_SWEEP.leadSeconds, IR_SWEEP.seconds, IR_SWEEP.tailSeconds, Math.round(irSweep.length / IR_RATE)],
  [0.5, 3, 1.5, 5]);
check('…as an exponential sweep from 20 Hz to 20 kHz, which is what separates distortion from the response',
  [IR_SWEEP.f1, IR_SWEEP.f2], [20, 20000]);

// ── and the three ways a real take is NOT a capture, each of which produces a confident cabinet ─────────────
console.log('\n15. a take that is not a capture is refused, by name');
const { responseDelay } = await import('../server/src/lib/audio/irCapture.js');

// ⚠️ THE FOLD. Both positions live in a circular FFT buffer, so a response 33 samples BEFORE the correlation peak
// is `(145 - 178) mod 524288 = 524255` — which reads as ten seconds late and refused a perfect capture. This is
// the arithmetic that had to be got right, and it is one line.
check('a response a few samples before the correlation peak reads as a few samples, not as a whole buffer',
  responseDelay({ latencySamples: 145, sweepAt: 178, size: 524288 }), -33);
check('…and one after it reads as a positive delay', responseDelay({ latencySamples: 400, sweepAt: 178, size: 524288 }), 222);

// ⚠️ THE UNIT ABOVE IS NOT ENOUGH, AND THE MUTATION RUN SAID SO. `responseDelay` is only part of the claim; the
// claim is that a TAKE is judged correctly, and a version that never located the sweep at all (sweepAt = 0) got
// the same answer on the unit's numbers. These three use the deconvolve → responseDelay path end to end.
const locate = (take) => responseDelay(deconvolve(take, irSweep, { taps: 2048 }));

check('a real capture locates its response within a few milliseconds of the sweep',
  Math.abs(locate(take)) < 0.01 * IR_RATE, true);
// ⚠️ AND WITH A COUPLE OF SECONDS OF SILENCE IN FRONT OF IT, which is what an untrimmed export looks like. The
// delay must not move: both estimators travel together, and this is the case that catches a version which
// assumes the take starts where the sweep does.
const paddedTake = new Float64Array(take.length + 2 * IR_RATE);
paddedTake.set(take, 2 * IR_RATE);
check('…even when the take begins seconds before the sweep does',
  Math.abs(locate(paddedTake)) < 0.01 * IR_RATE, true);
// And a take of something else entirely is seconds away — which is what refuses it rather than making a cabinet
// out of it.
const notACapture = Float64Array.from({ length: irSweep.length }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / IR_RATE));
check('…and a take that is not a capture at all is seconds away, not milliseconds',
  Math.abs(locate(notACapture)) > 0.1 * IR_RATE, true);

// ⚠️ AND THE FLAGS. This CLI spells its flags WITH their dashes (`value('--out')`), and the capture commands were
// first written with bare names — so `--f1 60 --f2 12000 --taps 512` were all accepted, printed in the usage, and
// SILENTLY IGNORED, because `args.indexOf('f1')` finds nothing and the default is used. A flag that does nothing
// is worse than a missing one: the tool reports the sweep it did not make.
const captureCli = readFileSync(new URL('../scripts/audio-capture.mjs', import.meta.url), 'utf8');
const bareFlags = [...captureCli.matchAll(/\b(?:value|num)\('([^'-][^']*)'/g)].map((m) => m[1]);
check('every flag this CLI reads is spelled with the dashes its usage documents',
  bareFlags, []);

// The sweep's band is the user's, and for a cabinet it should be: a guitar speaker does not reproduce 20 Hz, and
// three seconds of it is cone excursion for energy that will not be in the cabinet.
check('the sweep can be banded to what a guitar cabinet actually does',
  [sweepSignal({ seconds: 0.2, sampleRate: IR_RATE, f1: 60, f2: 12000 }).length,
    sweepSignal({ seconds: 0.2, sampleRate: IR_RATE, f1: 60, f2: 12000 }).some((v, i, a) => v !== a[0])],
  [Math.round((0.5 + 0.2 + 1.5) * IR_RATE), true]);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ the capture pre-flight does not agree with the trainer it claims to reproduce\n');
  process.exit(1);
}
console.log('the pre-flight measures what the trainer measures\n');
