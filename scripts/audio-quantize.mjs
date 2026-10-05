#!/usr/bin/env node
// audio-quantize — what a bit width costs, in bytes and in what comes out of a REAL model.
//
// THE FPGA ARGUMENT IN ONE COMMAND. "Neural networks on FPGAs are cheap because of quantization" is true and
// useless on its own: it does not say how many bits, what that costs to store, or what it does to the sound.
// This takes a real `.nam`, quantizes its weights, renders BOTH versions through the reference engine, and
// reports the difference plus the storage every width would need on a device.
//
//   node scripts/audio-quantize.mjs nam   <model.nam> [--bits 8] [--block 64] [--sweep] [--out-model m.json]
//   node scripts/audio-quantize.mjs ir    <impulse-response.wav> [--bits 8] [--sweep]
//   node scripts/audio-quantize.mjs model <morpheus-model.json>
//
// THE ENGINE IS NOT OURS. NeuralAmpModelerCore (MIT) is the reference implementation and its `tools/render`
// loads a `.nam` and renders a WAV; this finds or builds it and uses it. Writing our own WaveNet and LSTM
// forward passes would have been a second implementation of somebody else's format, wrong in ways nobody would
// notice. What is ours is the part they do not have: fixed-point weights with a scale, the byte budget, the
// deployment container, and the measurement.
//
// ⚠️ WHAT THIS MEASURES, precisely: WEIGHT quantization. The engine still computes in float, so this is not the
// fixed-point datapath (accumulator rounding, activation approximation). It is the dominant term and it is the
// part that decides the memory budget — but it is not the whole story, and the report says so rather than
// implying otherwise.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmsDb } from '../server/src/lib/audio/dsp.js';
import { nullDepth, thdPlusNoise } from '../server/src/lib/audio/analysis.js';
import { decodeWav, encodeWav } from '../server/src/lib/audio/wav.js';
import { namBytes, parseNam, quantizeBlocks, quantizedNam, toDeploymentModel } from '../server/src/lib/audio/namModel.js';
import { describeModel, modelBytes, parseModel } from '../server/src/lib/audio/modelFormat.js';
// The engine — clone, pin, one-time build, render — lives in one place now; the capture work needs the same
// thing and two copies would be two pins to keep in step.
import { ensureEngine, renderThroughFile } from './lib/referenceEngine.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SR = 48000;
const WIDTHS = [4, 6, 8, 12, 16];

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !args[i - 1].includes('=')));
const [cmd, arg] = positional;

const pad = (s, n) => String(s).padStart(n);
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : String(v));

/** A plucked-string test signal: harmonically rich and decaying, which is what an amp model is for. */
function pluck({ length, freq = 110, sampleRate = SR, amplitude = 0.5 }) {
  const out = new Float64Array(length);
  for (let h = 1; h <= 12; h++) {
    const w = (2 * Math.PI * freq * h) / sampleRate;
    for (let i = 0; i < length; i++) {
      out[i] += ((1 / h) * Math.sin(w * i) * Math.exp(-(i / sampleRate) * (2 + h * 0.7))) / 4;
    }
  }
  let max = 0;
  for (let i = 0; i < length; i++) max = Math.max(max, Math.abs(out[i]));
  for (let i = 0; i < length; i++) out[i] = (out[i] / max) * amplitude;
  return out;
}

const TMP = join(ROOT, '.cache', 'quantize-tmp');
mkdirSync(TMP, { recursive: true });
const writeWav = (name, samples) => {
  const path = join(TMP, name);
  writeFileSync(path, encodeWav({ sampleRate: SR, data: [samples], format: 'float32' }));
  return path;
};
const renderThrough = (engine, modelPath, inPath, outName) => renderThroughFile(engine, modelPath, inPath, join(TMP, outName));

switch (cmd) {
  case 'nam': {
    if (!arg) { console.error('usage: audio-quantize nam <model.nam> [--bits N] [--block 64] [--sweep]'); process.exit(2); }
    const nam = parseNam(readFileSync(arg, 'utf8'));
    const engine = ensureEngine({ explicit: value('--render') });
    const signal = pluck({ length: SR });
    const inPath = writeWav('input.wav', signal);
    console.log(`${arg}`);
    console.log(`  ${nam.architecture} · ${nam.weights.length} weights · ${nam.sampleRate ?? 'unknown'} Hz` +
      `${nam.metadata?.name ? ` · "${nam.metadata.name}"` : ''}`);
    console.log(`  input: a plucked string at ${fmt(rmsDb(signal), 1)} dBFS rms\n`);

    const floatOut = renderThrough(engine, arg, inPath, 'float.wav');

    const widths = flag('--sweep') ? WIDTHS : [Number(value('--bits', 8))];
    const blockSize = Number(value('--block', 64));
    const rows = [];
    for (const bits of widths) {
      const { text } = quantizedNam(nam, { bits, blockSize });
      const qPath = join(TMP, `quantized-${bits}.nam`);
      writeFileSync(qPath, text);
      const qOut = renderThrough(engine, qPath, inPath, `quantized-${bits}.wav`);
      const nulled = nullDepth(Float64Array.from(floatOut), Float64Array.from(qOut), { sampleRate: SR, matchGain: false });
      const thdn = thdPlusNoise(Float64Array.from(qOut), { sampleRate: SR, fundamental: 110 });
      const q = quantizeBlocks(nam.weights, { bits, blockSize });
      // THE SCALES ARE PART OF THE COST, and leaving them out flatters fine-grained quantization badly: at a
      // block of 4 they cost as much as the 8-bit weights they scale (3451 x 4 bytes), so the honest total is
      // what decides whether finer blocks are worth their 15 dB.
      rows.push({
        bits,
        bytes: namBytes(nam.weights.length, bits),
        scaleBytes: q.blocks * 4,
        blocks: q.blocks,
        sqnr: q.sqnrDb,
        difference: nulled.residualDb,
        thdn: thdn.thdnDb,
      });
    }
    console.log('  bits      weights    + scales      total    blocks   weight SQNR   output differs   THD+N');
    for (const r of rows) {
      console.log(`  ${pad(r.bits, 3)}  ${pad(r.bytes, 10)}  ${pad(r.scaleBytes, 9)}  ${pad(r.bytes + r.scaleBytes, 9)}  ${pad(r.blocks, 7)}  ${pad(fmt(r.sqnr, 1), 10)} dB  ${pad(fmt(r.difference, 1), 13)} dB  ${pad(fmt(r.thdn, 1), 7)} dB`);
    }
    console.log(`\n  the float model is ${nam.weights.length * 4} bytes of weights — the 8-bit total is what a device stores.`);
    console.log(`  ⚠ weight quantization only: the engine still computes in float, so this is not the whole fixed-point datapath.`);

    if (value('--out-model')) {
      const model = toDeploymentModel(nam, { bits: widths[0], blockSize });
      writeFileSync(value('--out-model'), `${JSON.stringify(model, null, 1)}\n`);
      console.log(`\n  wrote ${value('--out-model')} — ${describeModel(model)}`);
    }
    break;
  }

  case 'ir': {
    if (!arg) { console.error('usage: audio-quantize ir <impulse-response.wav> [--sweep]'); process.exit(2); }
    const { samples, sampleRate, frames } = (() => { const w = decodeWav(readFileSync(arg)); return { samples: w.data[0], sampleRate: w.sampleRate, frames: w.frames }; })();
    const signal = pluck({ length: SR, sampleRate });
    const convolve = (ir) => {
      const out = new Float64Array(signal.length);
      for (let i = 0; i < signal.length; i++) {
        let s = 0;
        for (let j = 0; j < ir.length && j <= i; j++) s += ir[j] * signal[i - j];
        out[i] = s;
      }
      return out;
    };
    const floatOut = convolve(samples);
    const widths = flag('--sweep') ? WIDTHS : [Number(value('--bits', 8))];
    console.log(`${arg} — ${frames} taps at ${sampleRate} Hz\n`);
    console.log('  bits      bytes        SQNR      output differs     max error');
    for (const bits of widths) {
      const q = quantizeBlocks(samples, { bits, blockSize: Number(value('--block', 64)) });
      const qOut = convolve(q.values);
      const nulled = nullDepth(Float64Array.from(floatOut), Float64Array.from(qOut), { sampleRate, matchGain: false });
      console.log(`  ${pad(bits, 3)}  ${pad(namBytes(frames, bits), 9)}  ${pad(fmt(q.sqnrDb, 1), 8)} dB  ${pad(fmt(nulled.residualDb, 1), 12)} dB  ${q.maxError.toExponential(2)}`);
    }
    console.log(`\n  float32 would be ${frames * 4} bytes.`);
    break;
  }

  case 'model': {
    if (!arg) { console.error('usage: audio-quantize model <morpheus-model.json>'); process.exit(2); }
    const model = parseModel(readFileSync(arg, 'utf8'));
    const bytes = modelBytes(model);
    console.log(describeModel(model));
    console.log(`  weights ${bytes.weights} bytes · scales ${bytes.scales} bytes · total ${bytes.total} bytes`);
    console.log(`  float32 would be ${bytes.params * 4} bytes`);
    break;
  }

  default:
    console.error(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(2, 15).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(cmd ? 2 : 0);
}

