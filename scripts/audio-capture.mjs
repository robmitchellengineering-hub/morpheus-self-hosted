// Capture: get the re-amp signal NAM actually accepts, check the pair you recorded, and measure the model
// that came back.
//
// ── WHY THIS IS THE HALF OF PHASE 3 THIS REPO CAN OWN ────────────────────────────────────────────────────
// Training a NAM model is PyTorch on a GPU — hours, and a dependency this project does not carry. What the
// plan says instead is that the measurement library is the capture rig. So this does the three things around
// the training, and does them with numbers:
//
//   input    fetch the re-amp signal the trainer will accept, and verify it byte for byte
//   check    whether the pair you recorded will train, and what the trainer will make of it
//   verify   how well the model that came back reproduces your recording
//
// THE RULES AND THE ALGORITHMS LIVE IN server/src/lib/audio/namCapture.js, transcribed from NAM's own
// trainer, with the reasoning for each one; this file is the command line and the fetch. It lives in the
// server because the app's capture panel runs the same code — one copy, not two. Read its header first:
// it explains why generating our own re-amp signal was the obvious design and is not possible.
//
// Run:  node scripts/audio-capture.mjs input
//       node scripts/audio-capture.mjs check --recorded my-amp-output.wav
//       node scripts/audio-capture.mjs verify --model my-amp.nam --recorded my-amp-output.wav
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INPUT_FILENAME, INPUT_URL, V3, blipLatency, checkCapture, identifyInput,
} from '../server/src/lib/audio/namCapture.js';
import { decodeWavMono, encodeWav } from '../server/src/lib/audio/wav.js';
import { IR_SWEEP, DEFAULT_TAPS, sweepSignal, deconvolve, normaliseIr, checkIr, formatIrCapture, responseDelay } from '../server/src/lib/audio/irCapture.js';
import { nullDepth } from '../server/src/lib/audio/analysis.js';
import { ensureEngine, renderThroughFile, NAMCORE_REF, ROOT } from './lib/referenceEngine.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const positional = args.filter((a, i) => !a.startsWith('--')
  && !(i > 0 && args[i - 1].startsWith('--') && !args[i - 1].includes('=')));
/** What the sweep file is, and the three things a person has to do with it. */
function formatIrSweep(f) {
  return [
    `${f.totalSeconds.toFixed(2)} s: ${f.leadSeconds} s of silence, the sweep, ${f.tailSeconds} s of silence`,
    `swept ${f.from} Hz to ${f.to} Hz at ${f.sampleRate} Hz`,
    '',
    '  1. play it through the CABINET — a clean power amp or the amp\'s effects return, not the amp\'s input,',
    '     so the IR does not carry the amp (the .nam already has that)',
    '  2. record the cabinet with a mic, at a level that does not clip, keeping the whole tail',
    '  3. node scripts/audio-capture.mjs ir make --recorded <take.wav> --sweep ' + f.out,
    '',
  ].join('\n');
}

const [cmd] = positional;
const num = (n, d) => (value(n) == null ? d : Number(value(n)));

const CACHE = join(ROOT, '.cache', 'nam');
const TMP = join(ROOT, '.cache', 'capture-tmp');
const INPUT_PATH = join(CACHE, INPUT_FILENAME);

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : String(v));

switch (cmd) {
  case 'input': {
    // `--verify <path>` checks a file the user already has (the NAM GUI's own "Download input file" button
    // saves one) instead of fetching. Both paths end at the same MD5 test.
    const verify = value('--verify');
    const out = value('--out', verify ?? INPUT_PATH);
    if (verify) {
      if (!existsSync(verify)) { console.error(`--verify ${verify} does not exist`); process.exit(2); }
    } else {
      mkdirSync(CACHE, { recursive: true });
      if (existsSync(out) && identifyInput(out).version !== null && !flag('--force')) {
        console.log(`${out} is already the official input — not downloading again (--force to re-fetch).`);
      } else {
        console.log('fetching the official re-amp signal from NAM\'s own download link …');
        console.log(`  ${INPUT_URL}`);
        // Fetched whole and then hashed rather than trusted on arrival: a Drive quota page or an interstitial
        // is an HTTP 200 whose body is HTML, so a status check would accept it and only the MD5 catches it.
        const res = spawnSync('curl', ['-sSL', '--max-time', '600', '-o', out, INPUT_URL], { stdio: 'inherit' });
        if (res.status !== 0) {
          console.error(`curl failed (${res.status}). Download it from NAM's GUI instead:\n`
            + '  open the trainer, press "Download input file", then:\n'
            + '  node scripts/audio-capture.mjs input --verify <wherever it saved>');
          process.exit(2);
        }
      }
    }
    const id = identifyInput(out);
    const bytes = statSync(out).size;
    const wav = decodeWavMono(readFileSync(out));
    console.log(`\n${out}  (${bytes.toLocaleString()} bytes)`);
    console.log(`  MD5 ${id.md5}`);
    console.log(`  ${wav.sampleRate} Hz · ${wav.samples.length.toLocaleString()} frames · ${fmt(wav.samples.length / wav.sampleRate, 3)} s`);
    if (id.version === null) {
      console.error('\n  ✗ not a known NAM input. The trainer will refuse it ("cannot be recognized as any '
        + 'known version").');
      process.exit(1);
    }
    console.log(`  ✓ recognised as NAM input ${id.version}${id.major === 3 ? ' — the current one' : ' (older than 3.0.0)'}`);
    if (id.major === 3) {
      const lat = blipLatency(wav.samples);
      console.log(`  impulses at ${V3.blipLocations[0].map((i) => (i / wav.sampleRate).toFixed(2)).join(' s and ')} s; `
        + `the gap before them peaks at ${lat.background.toExponential(2)}`);
    }
    console.log(`\nRe-amp that through your amp at ${wav.sampleRate} Hz, matching its length, then:`);
    console.log('  node scripts/audio-capture.mjs check --recorded <your recording>.wav');
    break;
  }

  case 'check':
  case 'verify': {
    const inputPath = value('--input', INPUT_PATH);
    const recPath = value('--recorded');
    if (!recPath) {
      console.error(`usage: audio-capture ${cmd} --recorded <amp-output.wav> [--input ${INPUT_PATH}]`);
      process.exit(2);
    }
    if (!existsSync(inputPath)) {
      console.error(`no input file at ${inputPath} — run \`audio-capture.mjs input\` first, or pass --input.`);
      process.exit(2);
    }
    if (!existsSync(recPath)) { console.error(`--recorded ${recPath} does not exist`); process.exit(2); }

    const inputW = decodeWavMono(readFileSync(inputPath));
    const recW = decodeWavMono(readFileSync(recPath));
    const id = identifyInput(inputPath);
    const result = checkCapture({
      // The frame count, not the samples: `checkCapture` never reads the input's audio, and the server passes
      // the same field so the 27 MB decode is never held in memory. See the module's header.
      inputFrames: inputW.samples.length,
      recorded: recW.samples,
      inputRate: inputW.sampleRate,
      recordedRate: recW.sampleRate,
      inputVersion: id.version,
      inputMajor: id.major,
    });

    if (flag('--json')) { console.log(JSON.stringify({ cmd, ...result })); if (!result.ok) process.exit(1); break; }

    const f = result.facts;
    console.log(`${inputPath}\n  → ${recPath}\n`);
    console.log(`  input    ${f.inputVersion ? `NAM v${f.inputVersion}` : 'UNRECOGNISED'} · ${f.inputRate} Hz · `
      + `${f.inputFrames.toLocaleString()} frames · ${fmt(f.inputSeconds, 3)} s`);
    // The delta is meaningless across sample rates — it subtracts two different clocks — so it is only shown
    // when the two files share a rate and the number means something.
    const delta = f.recordedRate === f.inputRate
      ? ` · ${f.deltaSeconds >= 0 ? '+' : ''}${fmt(f.deltaSeconds, 3)} s vs input` : '';
    console.log(`  recorded ${f.recordedRate} Hz · ${f.recordedFrames.toLocaleString()} frames · `
      + `${fmt(f.recordedSeconds, 3)} s${delta}`);
    if (f.recordedPeakDb !== undefined) {
      console.log(`  recorded peak ${fmt(f.recordedPeakDb, 2)} dBFS · rms ${fmt(f.recordedRmsDb, 1)} dBFS · `
        + `${f.clippedSamples} clipped samples · DC ${fmt(f.recordedDc ?? 0, 5)}`);
    }
    if (f.replicateEsr !== undefined) {
      console.log(`  the amp held still: replicate ESR ${f.replicateEsr.toExponential(3)} (limit 0.01)`);
      const lat = f.latency;
      console.log(lat.detected
        ? `  the trainer will align this pair at ${lat.delay} samples (${fmt((lat.delay / f.inputRate) * 1000, 3)} ms)`
        : `  the trainer cannot align this pair: no sample beat the trigger of ${lat.threshold.toExponential(2)}`);
    }
    console.log('');
    if (result.issues.length) {
      for (const i of result.issues) console.log(`  ${i.level === 'fail' ? '✗' : '!'} ${i.what}: ${i.detail}`);
    } else {
      console.log('  ✓ this pair will train.');
    }

    if (cmd === 'verify') {
      const model = value('--model');
      if (!model || !existsSync(model)) { console.error('verify needs --model <model.nam>'); process.exit(2); }
      const engine = ensureEngine({ explicit: value('--render') });
      mkdirSync(TMP, { recursive: true });
      // A SLICE, not the whole file, and not only for speed: `nullDepth` cross-correlates, which pads to
      // nextPow2(2n) — 190 s of 48 kHz is a 33-million-point FFT and about a gigabyte of Float64Array. Twenty
      // seconds from 0:30 sits inside v3's general training data, so it is representative and it costs 64 MB.
      const from = Math.max(0, num('--from-seconds', 30));
      const take = num('--max-seconds', 20);
      const a = Math.floor(from * inputW.sampleRate);
      const len = Math.min(Math.floor(take * inputW.sampleRate), inputW.samples.length - a, recW.samples.length - a);
      if (len <= 0) { console.error('the slice is empty — check --from-seconds against the file lengths'); process.exit(2); }
      const sliceIn = join(TMP, 'input-slice.wav');
      writeFileSync(sliceIn, encodeWav({ sampleRate: inputW.sampleRate, data: inputW.samples.subarray(a, a + len), format: 'float32' }));
      console.log(`\nrendering ${model} over ${fmt(take, 1)} s from 0:${String(Math.floor(from)).padStart(2, '0')} `
        + `(NeuralAmpModelerCore ${NAMCORE_REF}) …`);
      const rendered = renderThroughFile(engine, model, sliceIn, join(TMP, 'rendered.wav'));
      const m = Math.min(rendered.length, len);
      const nulled = nullDepth(recW.samples.subarray(a, a + m), rendered.subarray(0, m), { sampleRate: inputW.sampleRate, align: true, matchGain: true });
      // ⭐ The answer to "does this capture sound right?", as a number — and the same number the plugin is
      // measured with, so a model that measures well here measures well as a plugin.
      console.log(`  the model reproduces the recording to ${fmt(nulled.residualDb, 1)} dB`);
      console.log(`  (alignment ${fmt(nulled.latencySamples, 1)} samples, gain matched at ${fmt(nulled.gainDb, 2)} dB)`);
      // NAM's ESR and this null depth are the SAME measurement: `nullDepth` divides residual energy by the
      // aligned target's and `_esr` divides mean squared error by mean squared target — so the ESR is the null
      // depth without the square root. Printing it makes this comparable with the only ESR a NAM user has seen.
      const modelEsr = 10 ** (nulled.residualDb / 10);
      console.log(`  NAM's ESR for this model: ${modelEsr.toExponential(3)} — the trainer prints this too`);
      if (flag('--json')) {
        console.log(JSON.stringify({
          cmd: 'verify', model, nullDb: nulled.residualDb, latencySamples: nulled.latencySamples, gainDb: nulled.gainDb, esr: modelEsr,
        }));
      }
    }
    if (!result.ok) process.exit(1);
    break;
  }

  // ── ir: the CABINET capture, which is a different measurement from the amplifier's ───────────────────────
  // An amp is nonlinear and needs NAM's long re-amp signal and a training run. A cabinet is linear, so its
  // impulse response describes it completely — one sweep, one take, one deconvolution, no GPU. See
  // lib/audio/irCapture.js for why that difference decides the method.
  case 'ir': {
    const sub = positional[1];
    if (sub === 'sweep') {
      const out = value('--out', 'ir-sweep.wav');
      const seconds = num('--seconds', IR_SWEEP.seconds);
      const rate = num('--sample-rate', IR_SWEEP.sampleRate);
      // ⚠️ THE BAND IS YOURS TO CHOOSE, AND FOR A GUITAR CABINET NARROWER IS BETTER. The default sweeps 20 Hz to
      // 20 kHz; a guitar speaker does not reproduce 20 Hz, and driving it there is 3 seconds of cone excursion
      // for energy that will not be in the cab anyway. `--f1 60 --f2 12000` is a sensible guitar-cabinet sweep.
      const f1 = num('--f1', IR_SWEEP.f1);
      const f2 = num('--f2', IR_SWEEP.f2);
      const signal = sweepSignal({ seconds, sampleRate: rate, f1, f2 });
      writeFileSync(out, Buffer.from(encodeWav({ sampleRate: rate, data: signal, format: 'float32' })));
      const facts = {
        cmd: 'ir-sweep', out, seconds, sampleRate: rate, samples: signal.length,
        totalSeconds: signal.length / rate,
        leadSeconds: IR_SWEEP.leadSeconds, tailSeconds: IR_SWEEP.tailSeconds,
        from: f1, to: f2,
      };
      if (flag('--json')) console.log(JSON.stringify(facts, null, 2));
      else {
        console.log(`\nwrote ${out}\n`);
        console.log(formatIrSweep(facts));
      }
      break;
    }
    if (sub === 'make') {
      const recorded = value('--recorded');
      const sweepPath = value('--sweep');
      const out = value('--out', 'cabinet.wav');
      if (!recorded || !sweepPath) {
        console.error('usage: audio-capture ir make --recorded <take.wav> --sweep <ir-sweep.wav> [--out cabinet.wav] [--taps 4096]');
        process.exit(2);
      }
      if (!existsSync(recorded)) { console.error(`--recorded ${recorded} does not exist`); process.exit(2); }
      if (!existsSync(sweepPath)) { console.error(`--sweep ${sweepPath} does not exist — run \`audio-capture ir sweep\` first`); process.exit(2); }
      const take = decodeWavMono(readFileSync(recorded));
      const decodedSweep = decodeWavMono(readFileSync(sweepPath));
      const sweep = decodedSweep.samples;

      // ── the three ways a real take goes wrong, refused BY NAME rather than turned into a cabinet ──────────
      // ⚠️ EACH OF THESE PRODUCES A PERFECTLY PLAUSIBLE IR FROM A TAKE THAT CANNOT HAVE ONE. The arithmetic
      // does not know it was given the wrong file, so every one of these is checked before the deconvolution
      // rather than after it.
      const problems = [];
      if (take.sampleRate !== decodedSweep.sampleRate) {
        problems.push(`your take is ${take.sampleRate} Hz and the sweep is ${decodedSweep.sampleRate} Hz — record (or export) at the sweep's rate, or generate a matching one with \`ir sweep --sample-rate ${take.sampleRate}\``);
      }
      if (take.samples.length < sweep.length * 0.9) {
        problems.push(`the take is ${(take.samples.length / take.sampleRate).toFixed(2)} s and the sweep alone is ${(sweep.length / decodedSweep.sampleRate).toFixed(2)} s — it cannot contain the whole sweep, so the cabinet's tail was cut off by the recording`);
      }
      const taps = num('--taps', DEFAULT_TAPS);
      const result = deconvolve(take.samples, sweep, { taps });
      const delay = responseDelay(result);
      const maxDelay = num('--max-response-ms', 100) / 1000 * take.sampleRate;
      // ⚠️ TWO WAYS OF LOCATING THE SAME RESPONSE, AND THEIR AGREEMENT IS THE TEST. The matched filter
      // (correlation) and the inverse filter (deconvolution) both find the cabinet, with slightly different
      // biases — a few milliseconds apart on a real capture, and SECONDS apart when the take is not a capture
      // at all. ⚠️ Neither is a measurement of the interface's round trip: the recording does not contain the
      // moment the sweep was SENT, so that number is not knowable from these two files, and the tool will not
      // pretend otherwise.
      if (Math.abs(delay) > maxDelay) {
        problems.push(`the two ways of locating the response disagree by ${(Math.abs(delay) / take.sampleRate * 1000).toFixed(0)} ms. A cabinet is a fraction of a millisecond of ambiguity, not seconds — this take almost certainly does not contain the sweep. Check that you recorded the right track, and that the sweep is in the session at all`);
      }
      if (problems.length) {
        console.error(`\nrefusing to make a cabinet out of this take:\n`);
        for (const p of problems) console.error(`  ✗ ${p}`);
        console.error('');
        process.exit(1);
      }
      const { ir, peak } = normaliseIr(result.ir);
      writeFileSync(out, Buffer.from(encodeWav({ sampleRate: take.sampleRate, data: ir, format: 'float32' })));
      const verdict = checkIr(ir, { sampleRate: take.sampleRate });
      const facts = { cmd: 'ir-make', out, taps, fromSeconds: take.frames ? take.samples.length / take.sampleRate : 0,
        sweepAt: result.sweepAt, responseDelaySamples: delay, windowStart: result.windowStart, outsideDb: result.outsideDb,
        originalPeak: peak, ...verdict.facts };
      if (flag('--json')) console.log(JSON.stringify({ ...facts, issues: verdict.issues }, null, 2));
      else {
        console.log(`\nwrote ${out}\n`);
        console.log(formatIrCapture(verdict));
        console.log(`\n  the sweep's own response sits ${(result.sweepAt / take.sampleRate * 1000).toFixed(1)} ms into your take`);
        console.log(`  the matched filter and the inverse filter locate the cabinet within `
          + `${(Math.abs(delay) / take.sampleRate * 1000).toFixed(1)} ms of each other — that agreement is what says this is a capture`);
        console.log(`  peak before normalising: ${peak.toExponential(3)}\n`);
      }
      if (!verdict.ok) process.exit(1);
      break;
    }
    if (sub === 'check') {
      const path = positional[2] || value('--ir');
      if (!path || !existsSync(path)) { console.error('usage: audio-capture ir check <cabinet.wav> [--json]'); process.exit(2); }
      const { samples, sampleRate } = decodeWavMono(readFileSync(path));
      const verdict = checkIr(samples, { sampleRate });
      if (flag('--json')) console.log(JSON.stringify({ cmd: 'ir-check', file: path, ...verdict }, null, 2));
      else { console.log(`\n${path}\n`); console.log(formatIrCapture(verdict)); console.log(''); }
      if (!verdict.ok) process.exit(1);
      break;
    }
    console.error('usage: audio-capture ir sweep|make|check …\n'
      + '  ir sweep [--out ir-sweep.wav] [--seconds 3] [--sample-rate 48000] [--f1 20 --f2 20000]\n'
      + '  ir make  --recorded <take.wav> --sweep <ir-sweep.wav> [--out cabinet.wav] [--taps 4096]\n'
      + '           [--max-response-ms 100]\n'
      + '  ir check <cabinet.wav>');
    process.exit(2);
  }

  default:
    console.error('usage: audio-capture input|check|verify|ir …\n'
      + '  input  [--out <input.wav>] [--verify <input.wav>] [--force]\n'
      + '  check  --recorded <amp-output.wav> [--input <input.wav>] [--json]\n'
      + '  verify --model <model.nam> --recorded <amp-output.wav> [--input <input.wav>]\n'
      + '         [--from-seconds 30] [--max-seconds 20] [--render <path-to-render>] [--json]\n'
      + '  ir     sweep | make | check   — the CABINET, which is a linear capture (no training)\n');
    process.exit(2);
}
