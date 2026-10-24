// A `morpheus-model/1` CLASSIFIER container, built the way the training project's export.py builds one.
//
// ── WHY THIS IS A MODULE AND NOT JUST A FIXTURE ───────────────────────────────────────────────────────────
// Two callers need to construct a classifier container and they must agree: `export.py` (Python, generated) and
// this repo's own guards (JavaScript, run on every push). The Python one cannot be executed here — there is no
// torch and no numpy on the machine this is developed on — so the shape is written down ONCE in JavaScript and
// the guard asserts the generated Python produces it. The alternative, two hand-written constructors in two
// languages and a comment asking them to stay in step, is the failure this repo has already paid for.
//
// ── WHAT THE CONTAINER CARRIES, AND WHY EACH FIELD IS THERE ───────────────────────────────────────────────
//  * `layers[].kind` and the attributes beside it ARE THE GRAPH. The order of the list is the order of the
//    arithmetic, so the runtime is data-driven and a second tower is a second emitter rather than a second
//    runtime. `export.py` emits this list from the model it just trained, with each BatchNorm layer folded into
//    the convolution before it.
//  * ⚠️ THE WEIGHTS ARE CODES AND SCALES EVEN AT "FLOAT". A 32-bit container is the top rung of the same ladder
//    PACK measures, not a different format: it is the same reader, the same arithmetic and the same code path,
//    which is what makes "what does 8 bits cost?" a comparison rather than a rewrite. Writing raw floats would
//    need a second reader and would make the float model the only one nobody measured.
//  * `card.split.clips` is the EVIDENCE. VERIFY re-scores exactly those clips and refuses to embed a model whose
//    claim cannot be reproduced; without the clip list it could only re-score "the dataset", which is not the
//    same question and would pass a model whose test set was chosen after the fact.
import { quantizedModel, MODEL_FORMAT } from '../audio/modelFormat.js';
import { FRONT_END, CLASSIFIER_ARCH, featureFrames, frontEndProbe } from './classifierModel.js';

/** The float end of the ladder: wide enough that the quantization step is far below the weights' own noise. */
export const FLOAT_BITS = 32;

/**
 * Quantise one tensor, the same way `dsp.js`'s `quantizeTensor` does — codes, and a scale per channel.
 *
 * ⚠️ A CONV'S SCALE IS PER OUTPUT CHANNEL, WHICH IS NOT A DETAIL. One scale for a whole conv weight tensor
 * means the loudest filter sets the grid for all of them, and a filter whose weights are an order of magnitude
 * smaller is then represented by a handful of codes — which is exactly what makes low bit widths look expensive
 * when the real problem is the scale. `perChannel` is the number of output channels for a conv (the first
 * dimension) and of outputs for a linear layer, and 0 for a bias, which is one small vector with one range.
 */
export function quantizeValues(values, { bits, perChannel = 0 }) {
  // ⚠️ A NON-FINITE WEIGHT IS CHECKED HERE RATHER THAN ALLOWED THROUGH, AND THAT IS NOT PARANOIA. It is the one
  // input that produces a container which validates, loads, emits and compiles — and then answers NaN to every
  // clip, with no error in any stage. Naming the tensor at the point of writing is the difference between a
  // five-minute diagnosis and an afternoon.
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) throw new Error(`refusing to quantize a non-finite weight (index ${i} is ${values[i]})`);
  }
  const maxCode = 2 ** bits / 2 - 1;
  const channels = perChannel > 0 ? perChannel : 1;
  if (values.length % channels !== 0) throw new Error(`${values.length} values do not divide into ${channels} channels`);
  const per = values.length / channels;
  const codes = new Array(values.length);
  const scales = new Array(channels);
  for (let c = 0; c < channels; c++) {
    let maxAbs = 0;
    for (let i = c * per; i < (c + 1) * per; i++) maxAbs = Math.max(maxAbs, Math.abs(values[i]));
    const scale = maxAbs > 0 ? maxAbs / maxCode : 1;
    scales[c] = scale;
    for (let i = c * per; i < (c + 1) * per; i++) {
      codes[i] = Math.max(-maxCode, Math.min(maxCode, Math.round(values[i] / scale)));
    }
  }
  return { codes, scales };
}

/**
 * One tensor, in the container's shape.
 *
 * ⚠️ SEVERAL SCALES NEED A `block_size`, AND THE FORMAT IS STRICT ABOUT IT. `validateModel` reads a tensor with
 * no block size as having a scale PER CODE — so two scales on a sixteen-code weight is an invalid container, and
 * writing sixteen copies of two scales would count 4 bytes each in `modelBytes` and make an 8-bit model look
 * larger than it is. The block size is the per-channel stride, which is what the format's "one scale covers a
 * block of codes" exists for.
 */
function tensor(name, shape, values, { bits, perChannel = 0 }) {
  const { codes, scales } = quantizeValues(values, { bits, perChannel });
  const t = { name, shape, codes };
  if (scales.length > 1) {
    t.scales = scales;
    t.block_size = values.length / scales.length;
  } else {
    t.scale = scales[0];
  }
  return t;
}

/**
 * A classifier container from a tower description.
 *
 * `tower` is `[{ name, kind, pad, act, pool, weight, weightShape, bias }]` — the same shape `readTower` returns,
 * so a container can be packed, unpacked and packed again without a translation layer in between.
 */
export function classifierModel({
  tower,
  labels,
  frontEnd = {},
  bits = FLOAT_BITS,
  accumulatorBits = 32,
  source = {},
  card = null,
  sampleRate = FRONT_END.sampleRate,
  probe = true,
}) {
  const fe = { ...FRONT_END, ...frontEnd };
  const layers = tower.map((layer) => {
    const shape = layer.weightShape;
    // Per OUTPUT channel: `shape[0]` is the output count for both kinds, which is the axis whose range differs.
    const perChannel = shape[0];
    const tensors = [tensor('weight', shape, layer.weight, { bits, perChannel })];
    if (layer.bias) tensors.push(tensor('bias', [shape[0]], layer.bias, { bits, perChannel: 0 }));
    const out = { name: layer.name, kind: layer.kind, bits, tensors };
    if (layer.pad) out.pad = layer.pad;
    if (layer.act && layer.act !== 'none') out.act = layer.act;
    if (layer.pool) out.pool = layer.pool;
    return out;
  });
  return quantizedModel({
    architecture: CLASSIFIER_ARCH,
    sampleRate,
    layers,
    accumulatorBits,
    family: 'audio.classify',
    io: {
      // ⭐ THE PROBE TRAVELS WITH THE CONTAINER. It is the only thing that can catch a front end which drifted
      // from training WITHOUT the drift costing accuracy — see `frontEndProbe`. `probe: false` writes a container
      // without one, which VERIFY then warns about rather than failing: useful for a caller comparing readers.
      front_end: { ...fe, ...(probe ? { probe: frontEndProbe(fe) } : {}) },
      input: `a mono clip, ${fe.clipSeconds} s at ${fe.sampleRate} Hz, mixed down and normalised per clip`,
      output: 'one probability per label; the largest wins',
      frames: featureFrames(fe),
    },
    task: {
      labels,
      input: `a mono clip, ${fe.clipSeconds} s at ${fe.sampleRate} Hz`,
      output: 'one score per label; the highest wins',
    },
    source,
    card,
  });
}

/** The format string, re-exported so a caller writing a container does not import two modules. */
export { MODEL_FORMAT };

/**
 * ⚠️ THE PYTHON THE TRAINING PROJECT MUST EMIT, asserted rather than hoped for.
 *
 * `export.py` writes the same container in Python, and the one thing that cannot be checked by running it here is
 * the numbers. What CAN be checked is that both sides agree about the front end — the sample rate, the clip
 * length, the mel count, the FFT and the hop — because a disagreement there degrades a model silently, with no
 * error, and shows up as "the embedded version is not as good" months later. This returns the constants the
 * generated file must contain, and the guard reads the generated text for them.
 */
export function pythonFrontEndConstants(fe = FRONT_END) {
  return {
    SAMPLE_RATE: fe.sampleRate,
    CLIP_SECONDS: fe.clipSeconds,
    N_MELS: fe.nMels,
    N_FFT: fe.nFft,
    HOP: fe.hop,
  };
}
