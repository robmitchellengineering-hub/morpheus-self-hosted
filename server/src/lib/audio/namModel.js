// NAM models: read one, quantize its weights, write one back — and bridge it into our deployment format.
//
// WHY THIS FILE IS SMALL, AND WHY THAT IS THE RIGHT ANSWER. The obvious version of this work hand-ports the
// weight layout of every architecture — WaveNet's dilated stack, an LSTM's gate ordering — into our own
// inference code. That is a second implementation of a reference engine, it has to be right for every model
// ever exported, and nobody would ever know when it silently was not. NeuralAmpModelerCore is MIT, maintained,
// and IS the reference; `tools/render` loads a .nam and renders a WAV with it. So the engine is theirs and this
// file does the part they do not: turning the weights into fixed-point with a scale, and saying what that costs.
//
// THE WEIGHTS ARE A FLAT ARRAY, so the quantization is BLOCK-WISE: every `blockSize` weights get their own
// scale. That needs no architecture knowledge at all (which is what makes it work for any .nam), and it is what
// a real fixed-point deployment does anyway — one scale for a whole tensor is the thing that makes low bit
// widths expensive, because a single large weight forces every other weight onto a coarse grid.
//
// The `.nam` file stays FLOAT on the way out — because the reference engine loads floats — but the values are
// the DEQUANTIZED ones, so what the engine renders is exactly what an 8-bit device would produce from the same
// weights. What this does NOT model is the fixed-point datapath itself (accumulator rounding, activation
// approximations); it isolates the weight quantization, which is where most of the saving is, and the CLI says
// so rather than implying it measured the whole thing.

import { quantizeTensor } from './dsp.js';

/** Parse a `.nam`: JSON with `version`, `architecture`, `config`, a flat `weights` array, and metadata. */
export function parseNam(text) {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object') throw new Error('not a .nam object');
  if (!Array.isArray(raw.weights) || raw.weights.length === 0) throw new Error('.nam has no weights');
  if (!raw.architecture) throw new Error('.nam has no architecture');
  // ⚠️ CHECK THE RAW VALUES, NOT THE CONVERTED ONES. `Float64Array.from([1, null])` is `[1, 0]` — a null
  // silently becomes a plausible weight, so validating after the conversion accepts a corrupt file and then
  // quantizes an invented zero. The guard caught exactly that.
  for (let i = 0; i < raw.weights.length; i++) {
    if (typeof raw.weights[i] !== 'number' || !Number.isFinite(raw.weights[i])) {
      throw new Error(`.nam weight ${i} is not a finite number (got ${JSON.stringify(raw.weights[i])})`);
    }
  }
  const weights = Float64Array.from(raw.weights);
  return {
    version: raw.version ?? null,
    architecture: String(raw.architecture),
    sampleRate: raw.sample_rate ?? null,
    config: raw.config ?? {},
    metadata: raw.metadata ?? null,
    weights,
    raw,
  };
}

/** Quantize a flat weight array in blocks. Returns the codes, the scales, and the values to write back. */
export function quantizeBlocks(values, { bits, blockSize = 64 }) {
  if (!(blockSize >= 1)) throw new Error('blockSize must be >= 1');
  const codes = new Int32Array(values.length);
  const out = new Float64Array(values.length);
  const scales = [];
  let err = 0;
  let sig = 0;
  let maxError = 0;
  for (let start = 0; start < values.length; start += blockSize) {
    const end = Math.min(start + blockSize, values.length);
    const chunk = values.subarray ? values.subarray(start, end) : values.slice(start, end);
    const q = quantizeTensor(chunk, { bits });
    codes.set(q.codes, start);
    out.set(q.values, start);
    scales.push(q.scales[0]);
    for (let i = 0; i < chunk.length; i++) {
      const d = chunk[i] - q.values[i];
      err += d * d;
      sig += chunk[i] * chunk[i];
      maxError = Math.max(maxError, Math.abs(d));
    }
  }
  return {
    codes,
    scales,
    values: out,
    blocks: scales.length,
    sqnrDb: err === 0 ? Infinity : 10 * Math.log10(sig / err),
    maxError,
    bits,
    blockSize,
  };
}

/** A copy of the `.nam` with its weights quantized, and a note in the metadata saying what was done. */
export function quantizedNam(nam, { bits, blockSize = 64 }) {
  const q = quantizeBlocks(nam.weights, { bits, blockSize });
  const out = {
    ...nam.raw,
    weights: Array.from(q.values, (v) => Number(v.toFixed(9))),
    metadata: {
      ...(nam.metadata || {}),
      // The artifact says what it is. A quantized model that reads as an ordinary float model is how a
      // measurement gets taken on the wrong thing three months later.
      morpheus_quantization: {
        bits,
        block_size: blockSize,
        blocks: q.blocks,
        sqnr_db: Number.isFinite(q.sqnrDb) ? Number(q.sqnrDb.toFixed(3)) : null,
        note: 'weights rounded to a symmetric fixed-point grid, one scale per block; stored as floats so a float engine can render them',
      },
    },
  };
  return { text: `${JSON.stringify(out)}\n`, quantization: q };
}

/** What a device would store for this model at a bit width — the number every embedded decision starts from. */
export function namBytes(count, bits) {
  return Math.ceil((count * bits) / 8);
}

/**
 * Bridge a `.nam` into the deployment container (`morpheus-model/1`): the quantized weights with their scales,
 * the sample rate, and the provenance back to the float model. This is the artifact a non-float backend needs —
 * the file that cannot exist today because `.nam` carries no scales.
 */
export function toDeploymentModel(nam, { bits, blockSize = 64, accumulatorBits = 32 }) {
  const q = quantizeBlocks(nam.weights, { bits, blockSize });
  return {
    format: 'morpheus-model/1',
    architecture: nam.architecture,
    sample_rate: nam.sampleRate ?? 48000,
    accumulator_bits: accumulatorBits,
    io: {
      // Carried through because a model trained at one level sounds wrong at another: the `.nam` metadata
      // records the dBu figures for exactly this reason, and dropping them at deployment is how a good model
      // ends up sounding bad.
      input_level_dbu: nam.metadata?.input_level_dbu ?? null,
      output_level_dbu: nam.metadata?.output_level_dbu ?? null,
      loudness: nam.metadata?.loudness ?? null,
    },
    source: {
      nam_version: nam.version,
      nam_architecture: nam.architecture,
      nam_weights: nam.weights.length,
      metadata: nam.metadata ?? null,
    },
    layers: [{
      name: 'weights',
      kind: 'flat',
      bits,
      tensors: [{
        name: 'weights',
        shape: [nam.weights.length],
        codes: Array.from(q.codes),
        scales: Array.from(q.scales),
        block_size: blockSize,
      }],
    }],
  };
}
