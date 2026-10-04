// morpheus-model/1 — the deployment format for a QUANTIZED audio model.
//
// WHY THIS HAS TO EXIST BEFORE ANYTHING CAN BE MEASURED. `.nam` is float JSON: it says nothing about scale,
// nothing about accumulator width, nothing about how a weight becomes a fixed-point number. That is fine for a
// float CPU and useless for every other target — an FPGA, an MCU, a DSP. "What does 8-bit cost?" cannot even be
// asked of a file that has no 8-bit representation. So the quantized container is the missing asset the plan
// keeps pointing at, and it is needed by EVERY backend, not just the FPGA one.
//
// WHAT IT CARRIES, and each field is something a backend cannot do without:
//   * the weights, as integers, with the SCALE that turns them back into real numbers;
//   * optionally a scale PER CHANNEL, because one scale for a whole tensor is what makes low bit-widths
//     expensive — a single loud channel forces every other channel onto a coarse grid;
//   * the accumulator width, because a fixed-point datapath is designed around it and a model that assumes 32
//     bits will not fit a datapath built for 16;
//   * the sample rate and the input/output calibration, because a model trained at one level sounds wrong at
//     another and the `.nam` metadata already carries the dBu figures for exactly this reason;
//   * provenance back to the float model, so a quantized artifact can always be traced to what it came from.
//
// WEIGHTS ARE STORED AS INTEGERS, NOT FLOATS, and the byte accounting counts them at their real width. A format
// that stored "8-bit" weights as JSON numbers would report a size that has nothing to do with what a device
// needs — which is the whole question being asked.

export const MODEL_FORMAT = 'morpheus-model/1';

/** Bits actually consumed by one weight at this width, for the size budget. */
export const bytesForWeights = (count, bits) => (count * bits) / 8;

/**
 * Build a model container. `layers` is a list of `{ name, kind, bits, tensors }`, and each tensor is
 * `{ name, shape, codes, scale }` or `{ name, shape, codes, scales }` for per-channel. A LAYER HOLDS SEVERAL
 * TENSORS because an LSTM is three (input weights, recurrent weights, bias) and a format that assumed one array
 * per layer could not describe the recurrent models this whole exercise is about.
 */
export function quantizedModel({ architecture, sampleRate, layers, io = {}, source = {}, accumulatorBits = 32 }) {
  return {
    format: MODEL_FORMAT,
    architecture,
    sample_rate: sampleRate,
    accumulator_bits: accumulatorBits,
    io,
    source,
    layers,
  };
}

/** Everything wrong with a model, as a list a human can act on. Never throws on bad input. */
export function validateModel(model) {
  const errors = [];
  if (!model || typeof model !== 'object') return { valid: false, errors: ['not an object'] };
  if (model.format !== MODEL_FORMAT) errors.push(`format is "${model.format}", expected "${MODEL_FORMAT}"`);
  if (!(model.sample_rate > 0)) errors.push(`sample_rate must be positive, got ${model.sample_rate}`);
  if (!(model.accumulator_bits > 0)) errors.push(`accumulator_bits must be positive, got ${model.accumulator_bits}`);
  if (!Array.isArray(model.layers) || model.layers.length === 0) errors.push('a model needs at least one layer');
  for (const [i, layer] of (model.layers || []).entries()) {
    const where = `layer ${i} (${layer?.name ?? 'unnamed'})`;
    if (!layer?.name) errors.push(`${where}: no name`);
    if (!(layer?.bits > 0)) errors.push(`${where}: bits must be positive, got ${layer?.bits}`);
    if (!Array.isArray(layer?.tensors) || layer.tensors.length === 0) { errors.push(`${where}: no tensors`); continue; }
    for (const [j, t] of layer.tensors.entries()) {
      const tw = `${where} tensor ${j} (${t?.name ?? 'unnamed'})`;
      if (!Array.isArray(t?.codes) || t.codes.length === 0) errors.push(`${tw}: no codes`);
      if (!Array.isArray(t?.shape) || t.shape.length === 0) errors.push(`${tw}: no shape`);
      // THE SCALE IS THE THING WHOSE ABSENCE MAKES A WEIGHT MEANINGLESS. A quantized file without one is not a
      // model, it is a list of integers — and the failure surfaces as "the plugin sounds wrong", not as a parse
      // error, which is exactly why it is checked here.
      if (t?.scales) {
        // A scale can cover one code (per-channel) or a BLOCK of codes, which is what real fixed-point
        // deployments use and what a flat weight array like a `.nam` can actually be split into. Both are
        // checked against the count they imply, because "the right number of scales" is the difference between a
        // dequantizable model and a list of integers.
        const expected = t.block_size > 0 ? Math.ceil(t.codes.length / t.block_size) : t.codes.length;
        if (t.scales.length !== expected) {
          errors.push(`${tw}: ${t.scales.length} scales for ${t.codes.length} codes` +
            `${t.block_size > 0 ? ` in blocks of ${t.block_size} (expected ${expected})` : ''}`);
        }
      } else if (!(Math.abs(t?.scale) > 0)) {
        errors.push(`${tw}: no scale (and no per-channel scales) — the codes cannot be turned back into numbers`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

/** The size a device would have to store, in bytes — the number every embedded decision starts from. */
export function modelBytes(model) {
  let weights = 0;
  let scales = 0;
  let params = 0;
  for (const layer of model.layers || []) {
    for (const t of layer.tensors || []) {
      params += t.codes.length;
      weights += bytesForWeights(t.codes.length, layer.bits || 0);
      // Scales are real numbers and are counted at 4 bytes each: a rounding error next to the weights at any
      // width worth using, and pretending they are free would flatter the result.
      scales += (t.scales ? t.scales.length : 1) * 4;
    }
  }
  return { weights: Math.ceil(weights), scales, total: Math.ceil(weights) + scales, params };
}

/** A short human summary: architecture, bit widths, and what it costs to store. */
export function describeModel(model) {
  const bits = [...new Set((model.layers || []).map((l) => l.bits))].sort((a, b) => a - b);
  const bytes = modelBytes(model);
  return `${model.architecture} · ${bytes.params} weights at ${bits.join('/')}-bit · ${bytes.total} bytes ` +
    `(${bytes.weights} weights + ${bytes.scales} scales) · ${model.sample_rate} Hz`;
}

/**
 * Serialise to JSON text.
 *
 * ⚠️ The codes are written as plain integers and the byte count is COMPUTED from the bit width rather than
 * measured from the text. That is deliberate and it is the honest choice: JSON at 8 bits is far larger than the
 * packed binary a device would hold, so the number that matters (what it costs on the device) has to come from
 * the width, not from the file. A shipping build packs to base64 or binary; this stays readable so a human can
 * check what is in it.
 */
export function serializeModel(model) {
  const { valid, errors } = validateModel(model);
  if (!valid) throw new Error(`refusing to serialise an invalid model:\n  ${errors.join('\n  ')}`);
  return `${JSON.stringify(model, null, 1)}\n`;
}

export function parseModel(text) {
  const model = JSON.parse(text);
  const { valid, errors } = validateModel(model);
  if (!valid) throw new Error(`not a usable model:\n  ${errors.join('\n  ')}`);
  return model;
}
