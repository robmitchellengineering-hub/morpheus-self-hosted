#!/usr/bin/env node
// audio-measure — the measurement instrument, on the command line.
//
// This is the first of the developer paths from the audio plan, and the engine the others stand on: the plugin
// test bench, the capture rig, and the quantization playground all ask the same four questions — generate a
// known signal, put it through the thing, look at what came out, compare it with what went in.
//
//   node scripts/audio-measure.mjs signals  <dir>                 write the standard test signals
//   node scripts/audio-measure.mjs analyse  <file.wav>            level, spectrum, THD, THD+N, aliases
//   node scripts/audio-measure.mjs compare  <a.wav> <b.wav>       null depth, latency, gain, correlation
//   node scripts/audio-measure.mjs ir       <ref.wav> <rec.wav>   the system's impulse + frequency response
//   node scripts/audio-measure.mjs quantize <file.wav> --bits 8   what a bit depth costs (SQNR, and a file)
//
// ⚠️ WHAT IT DOES NOT DO, said out loud because a meter that overclaims is worse than no meter: there is no
// LUFS here (ITU-R BS.1770 needs its K-weighting filter right, and a plausible-looking loudness number is the
// most dangerous kind), and nothing is perceptually weighted. These are physical measurements.
//
// No dependencies. Reads only what it is given; writes only where told.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { biquadCoefficients, biquadProcess, linearToDb, peak, quantize, rms, rmsDb, sqnrDb } from '../server/src/lib/audio/dsp.js';
import { impulse, logSweep, sine, twoTone, whiteNoise } from '../server/src/lib/audio/signals.js';
import {
  aliasCheck, estimateLatency, magnitudeResponseDb, nullDepth, peakFrequency, systemResponse, thd, thdPlusNoise,
} from '../server/src/lib/audio/analysis.js';
import { decodeWav, encodeWav } from '../server/src/lib/audio/wav.js';

const fmt = (v, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : String(v));
const sign = (v, digits = 2) => `${v >= 0 ? '' : '-'}${Math.abs(v).toFixed(digits)}`;

const USAGE = `audio-measure — physical audio measurement, no dependencies.

  node scripts/audio-measure.mjs signals  <dir>                 write the standard test signals
  node scripts/audio-measure.mjs analyse  <file.wav>            level, spectrum, THD, THD+N, aliases
  node scripts/audio-measure.mjs compare  <a.wav> <b.wav>       null depth, latency, gain, correlation
  node scripts/audio-measure.mjs ir       <ref.wav> <rec.wav>   the system's impulse + frequency response
  node scripts/audio-measure.mjs quantize <file.wav> --bits 8   what a bit depth costs (SQNR, and a file)
  node scripts/audio-measure.mjs check                          the tool's own numbers, printed

Options: --sample-rate N  --seconds N  --fundamental Hz  --bits N  --out FILE  --ir-length N  --f1/--f2 Hz

It does NOT measure loudness: LUFS needs its K-weighting filter right and a plausible-looking
number is the most dangerous kind. Nothing here is perceptually weighted.`;

function usage(code = 0) {
  console.log(USAGE);
  process.exit(code);
}

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) {
    const next = rest[i + 1];
    // ⚠️ A TRAILING BOOLEAN FLAG IS `true`, NOT `undefined`. The first version read `rest[i+1]` and, when there
    // was nothing after it, assigned `undefined` — so `--json` at the end of a command line was falsy and the
    // tool printed prose. It went unnoticed until a workflow parsed the output as JSON and got a syntax error.
    if (next === undefined || next.startsWith('--')) flags[rest[i].slice(2)] = true;
    else { flags[rest[i].slice(2)] = next; i++; }
  } else positional.push(rest[i]);
}
if (!cmd || flags.help) usage(cmd ? 0 : 2);

const loadMono = (path) => {
  const wav = decodeWav(readFileSync(path));
  return { ...wav, mono: wav.data[0] };
};

switch (cmd) {
  case 'signals': {
    const dir = positional[0] || '.';
    mkdirSync(dir, { recursive: true });
    const SR = Number(flags['sample-rate'] ?? 48000);
    const seconds = Number(flags.seconds ?? 2);
    const length = Math.round(seconds * SR);
    const files = {
      'sine-1k.wav': sine({ freq: 1000, sampleRate: SR, length, amplitude: 0.5 }),
      'two-tone-imd.wav': twoTone({ sampleRate: SR, length, amplitude: 0.5 }),
      'sweep-20-20k.wav': logSweep({ f1: 20, f2: 20000, sampleRate: SR, seconds, amplitude: 0.5 }),
      'impulse.wav': impulse({ length, index: 0, amplitude: 1 }),
      'noise.wav': whiteNoise({ length, seed: 1, amplitude: 0.5 }),
    };
    for (const [name, data] of Object.entries(files)) {
      const path = join(dir, name);
      // float32 on purpose: a reference signal must not be quantized by the tool that generates it.
      writeFileSync(path, encodeWav({ sampleRate: SR, data: [data], format: 'float32' }));
      console.log(`wrote ${path}  ${length} frames @ ${SR} Hz`);
    }
    break;
  }

  case 'analyse': {
    const path = positional[0];
    if (!path) usage(2);
    const { mono, sampleRate, frames, format } = loadMono(path);
    const peakFreq = peakFrequency(mono, { sampleRate });
    const fundamental = flags.fundamental ? Number(flags.fundamental) : peakFreq.freq;
    const thdResult = thd(mono, { sampleRate, fundamental, harmonics: 10 });
    const thdn = thdPlusNoise(mono, { sampleRate, fundamental });
    const aliases = aliasCheck(mono, { sampleRate, fundamental });
    console.log(`${path}`);
    console.log(`  ${frames} frames @ ${sampleRate} Hz (${format}) · ${fmt(frames / sampleRate, 3)} s`);
    console.log(`  peak   ${sign(linearToDb(peak(mono)))} dBFS      rms ${sign(rmsDb(mono))} dBFS`);
    console.log(`  tone   ${fmt(fundamental, 1)} Hz at ${sign(thdResult.fundamentalDb)} dBFS`);
    console.log(`  THD    ${fmt(thdResult.thdPercent, 4)} %  (${sign(thdResult.thdDb)} dB)`);
    for (const h of thdResult.harmonics.slice(0, 6)) {
      if (h.dbRel > -140) console.log(`         H${h.order}  ${fmt(h.freq, 1)} Hz  ${sign(h.dbRel)} dB rel`);
    }
    console.log(`  THD+N  ${fmt(thdn.thdnPercent, 4)} %  (${sign(thdn.thdnDb)} dB)`);
    if (aliases.aliases.length) {
      console.log(`  ALIAS  strongest ${sign(aliases.strongestAliasDb)} dB rel at ${fmt(aliases.aliases[0].freq, 1)} Hz`);
      for (const a of aliases.aliases.slice(0, 5)) console.log(`         ${fmt(a.freq, 1)} Hz  ${sign(a.dbRel)} dB`);
    } else {
      console.log('  ALIAS  none above the measurement floor');
    }
    break;
  }

  case 'compare': {
    const [aPath, bPath] = positional;
    if (!aPath || !bPath) usage(2);
    const a = loadMono(aPath);
    const b = loadMono(bPath);
    if (a.sampleRate !== b.sampleRate) console.log(`  ⚠ different sample rates (${a.sampleRate} vs ${b.sampleRate}) — the numbers below assume they are the same signal`);
    const nulled = nullDepth(a.mono, b.mono, { sampleRate: a.sampleRate });
    const lat = estimateLatency(a.mono, b.mono, { sampleRate: a.sampleRate });
    // ⚠️ THE JSON GOES FIRST, before a single line of prose. Placing it after the pretty block produced a
    // document that was four lines of English followed by JSON — which is not JSON, and a caller parsing it gets
    // a syntax error that says nothing about the CLI. The guard now runs the real command with the flag LAST,
    // which is exactly where the first version of the argument parser also broke.
    if (flags.json) {
      console.log(JSON.stringify({
        fileA: aPath, fileB: bPath, nullDepthDb: nulled.residualDb, gainDb: nulled.gainDb,
        latencySamples: nulled.latencySamples, nullDepthMs: nulled.latencyMs, correlation: nulled.correlation,
      }));
      break;
    }
    console.log(`${aPath}  vs  ${bPath}`);
    console.log(`  latency      ${fmt(nulled.latencySamples, 2)} samples · ${fmt(nulled.latencyMs, 3)} ms`);
    console.log(`  correlation  ${fmt(nulled.correlation, 4)}`);
    console.log(`  gain match   ${sign(nulled.gainDb)} dB (applied to the second file)`);
    console.log(`  NULL DEPTH   ${sign(nulled.residualDb)} dB   ← how much of the first signal survives`);
    if (lat.correlation < 0.5) console.log('  ⚠ the two files are barely correlated: this null is meaningless, not impressive');
    break;
  }

  case 'ir': {
    const [refPath, recPath] = positional;
    if (!refPath || !recPath) usage(2);
    const ref = loadMono(refPath);
    const rec = loadMono(recPath);
    const { ir } = systemResponse(rec.mono, ref.mono, { sampleRate: ref.sampleRate, irLength: Number(flags['ir-length'] ?? 8192) });
    const resp = magnitudeResponseDb(ir, { sampleRate: ref.sampleRate, points: 10, f1: Number(flags.f1 ?? 20), f2: Number(flags.f2 ?? 20000) });
    console.log(`${refPath} → ${recPath}`);
    console.log('  frequency response:');
    for (let i = 0; i < resp.freqs.length; i++) {
      const bar = '#'.repeat(Math.max(0, Math.round((resp.db[i] + 48) / 2)));
      console.log(`    ${String(Math.round(resp.freqs[i])).padStart(6)} Hz  ${sign(resp.db[i], 1).padStart(6)} dB  ${bar}`);
    }
    if (flags.out) {
      writeFileSync(flags.out, encodeWav({ sampleRate: ref.sampleRate, data: [ir], format: 'float32' }));
      console.log(`  wrote ${flags.out}`);
    }
    break;
  }

  case 'quantize': {
    const path = positional[0];
    if (!path) usage(2);
    const bits = Number(flags.bits ?? 8);
    const { mono, sampleRate } = loadMono(path);
    const q = quantize(mono, bits);
    console.log(`${path}`);
    console.log(`  ${bits}-bit quantization: step ${q.step.toExponential(3)}, ${q.levels} levels`);
    console.log(`  SQNR  ${fmt(sqnrDb(mono, q.samples), 2)} dB   (textbook 6.02·${bits} + 1.76 = ${fmt(6.02 * bits + 1.76, 2)} dB)`);
    const nulled = nullDepth(mono, q.samples, { sampleRate, align: false, matchGain: false });
    console.log(`  error is ${sign(nulled.residualDb)} dB below the signal`);
    if (flags.out) {
      writeFileSync(flags.out, encodeWav({ sampleRate, data: [q.samples], format: 'float32' }));
      console.log(`  wrote ${flags.out}`);
    }
    console.log('  ⚠ this quantizes the SAMPLES. Quantizing a MODEL\'s weights is the FPGA question, and it needs');
    console.log('    the weights and their per-layer scales — which the .nam format does not carry. See the plan.');
    break;
  }

  case 'check': {
    // A self-check, so "the tool runs" is not mistaken for "the tool is right". These are quantities whose
    // values are known independently: a Butterworth corner is -3 dB, a full-scale sine's RMS is -3.01 dBFS,
    // and 8-bit quantization has a textbook SQNR.
    const SR = 48000;
    const x = sine({ freq: 1000, sampleRate: SR, length: 48000, amplitude: 1 });
    const coeffs = biquadCoefficients({ type: 'lowpass', freq: 1000, q: 0.707, sampleRate: SR });
    const out = biquadProcess(coeffs, x);
    // Compare the two over the same tail, after the filter's transient — an RMS taken from sample zero would
    // read the startup, not the steady state.
    const tail = (a) => a.subarray(24000);
    const cornerGain = linearToDb(rms(tail(out)) / rms(tail(x)));
    const q8 = quantize(x, 8);
    console.log(`audio-measure — self check at ${SR} Hz`);
    console.log(`  a Q=0.707 lowpass passes its corner at ${sign(cornerGain)} dB   (expect -3.01)`);
    console.log(`  rms of a full-scale sine         ${sign(rmsDb(x))} dBFS        (expect -3.01)`);
    console.log(`  8-bit SQNR of that sine          ${fmt(sqnrDb(x, q8.samples), 1)} dB          (textbook ${fmt(6.02 * 8 + 1.76, 1)})`);
    console.log(`  16-bit would be                  ${fmt(6.02 * 16 + 1.76, 1)} dB         by the same rule`);
    break;
  }

  default:
    usage(2);
}
