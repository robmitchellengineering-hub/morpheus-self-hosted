// The `audio.classify` container, READ — the front end, the forward pass, and what is wrong with a file.
//
// ── WHY THIS FILE IS THE RISKY ONE, AND WHY IT IS WRITTEN THIS CAREFULLY ─────────────────────────────────
// A trained classifier is only worth anything if the numbers it sees at inference are the numbers it learned
// from. The training project computes a log-mel spectrogram in `dataset.py`; the embedded runtime has to compute
// the SAME thing — a different window convention, a different padding, a different normalisation and the model
// degrades quietly, with no error anywhere and an accuracy far from what the card claims.
//
// That is the failure this file is shaped around, and it is worse than a crash because it is invisible. So:
//
//   * every convention that `torch` would have chosen silently is written down here as an explicit constant —
//     the PERIODIC Hann window (torch's default, and NOT `dsp.js`'s symmetric one), reflect padding at both
//     ends, the UNBIASED standard deviation, the mono mixdown;
//   * the constants live in ONE object that the generated `dataset.py` is also written from, so the two
//     implementations cannot disagree about the numbers even though they are two implementations;
//   * and the disagreement that remains possible — the arithmetic — is caught at VERIFY, which re-scores the
//     clip list the card names and REFUSES to embed a model whose claim cannot be reproduced.
//
// ⚠️ THE HONEST LIMIT: the Python front end cannot be executed in this repo (no numpy, no torch — see the
// guard, which asserts the absence rather than pretending). So the arithmetic is checked where it CAN be:
// the JavaScript here and the generated C++ are run on the same audio and compared sample by sample, and the
// constants are checked against the generated Python text. Anything beyond that would be a claim I cannot run.
import { fftInPlace } from '../audio/dsp.js';
import { decodeWav } from '../audio/wav.js';

/** The architecture name that ties a container to this reader. */
export const CLASSIFIER_ARCH = 'AudioClassifier';

/**
 * The front end, as data.
 *
 * ⚠️ EVERY FIELD HERE IS A DECISION THAT WOULD OTHERWISE BE MADE INVISIBLY BY A LIBRARY DEFAULT.
 *
 *  * `window: 'hann-periodic'` — `torch.hann_window(N)` defaults to periodic=True, i.e. `0.5 - 0.5cos(2πn/N)`.
 *    `dsp.js`'s `hann(N)` is the SYMMETRIC form, `/(N-1)`, and it is the right one for filter design and the
 *    wrong one here. Using it would apply a slightly different window than training did, every frame, forever.
 *  * `center: true` + `padMode: 'reflect'` — `torch.stft`'s defaults. The signal is mirrored by `nFft/2` at each
 *    end before framing, which is why a 96000-sample clip gives 376 frames rather than 372.
 *  * `normalize: 'per-clip mean/std'`, `stdUnbiased: true` — `Tensor.std()` uses Bessel's correction, so the
 *    divisor is `N-1`, not `N`.
 *  * `mixdown: 'mean'` — `sf.read(..., always_2d=True).mean(axis=1)`.
 */
export const FRONT_END = Object.freeze({
  sampleRate: 48000,
  clipSeconds: 2.0,
  nMels: 64,
  nFft: 1024,
  hop: 256,
  fmin: 30,
  logEps: 1e-6,
  center: true,
  padMode: 'reflect',
  window: 'hann-periodic',
  mixdown: 'mean',
  normalize: 'per-clip mean/std',
  stdUnbiased: true,
});

/** The period fixed-point layer kinds this reader understands, and what each one's attributes mean. */
export const LAYER_KINDS = Object.freeze({
  conv2d: 'weight [outC, inC, kh, kw], bias [outC]; pad, act, pool',
  linear: 'weight [outC, inC], bias [outC]; act',
});

// ── the front end ────────────────────────────────────────────────────────────────────────────────────────

/**
 * A PERIODIC Hann window, which is what `torch.hann_window(n)` returns by default.
 *
 * ⚠️ Not `dsp.js`'s `hann(n)`. That one divides by `n-1` (symmetric, endpoints exactly zero) and is correct for
 * filter design; this one divides by `n`, which is what an STFT wants and what the training project used. The
 * two differ by a fraction of a percent per bin and there is no test that would notice — which is why the
 * convention is a named constant rather than a call.
 */
export function hannPeriodic(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  return w;
}

/** Hz → mel, the HTK formula. Paired with `melToHz`; both sides of the filterbank must use the same one. */
export const hzToMel = (f) => 2595.0 * Math.log10(1.0 + f / 700.0);
export const melToHz = (m) => 700.0 * (10.0 ** (m / 2595.0) - 1.0);

/** `numpy.linspace`, exactly: `steps` points from `start` to `stop`, endpoints included. */
export function linspace(start, stop, steps) {
  const out = new Float64Array(steps);
  if (steps === 1) { out[0] = start; return out; }
  const step = (stop - start) / (steps - 1);
  for (let i = 0; i < steps; i++) out[i] = start + i * step;
  out[steps - 1] = stop; // endpoints are exact in numpy, and a model that saw the exact value should see it again
  return out;
}

/**
 * The triangular mel filterbank, `nMels × (nFft/2 + 1)`, row-major.
 *
 * Regenerated from the parameters rather than stored, because it is 64 × 513 numbers that are pure function of
 * four of them — and a stored copy is a copy that can drift from the one the model was trained with.
 */
export function melFilterbank({ nMels, nFreqs, sampleRate, fmin = 30, fmax = null }) {
  const top = fmax ?? sampleRate / 2;
  const melPoints = linspace(hzToMel(fmin), hzToMel(top), nMels + 2);
  const hzPoints = Array.from(melPoints, melToHz);
  const freqs = linspace(0, sampleRate / 2, nFreqs);
  const fb = new Float64Array(nMels * nFreqs);
  for (let i = 0; i < nMels; i++) {
    const lo = hzPoints[i];
    const mid = hzPoints[i + 1];
    const hi = hzPoints[i + 2];
    for (let j = 0; j < nFreqs; j++) {
      const f = freqs[j];
      const rising = (f - lo) / Math.max(mid - lo, 1e-9);
      const falling = (hi - f) / Math.max(hi - mid, 1e-9);
      fb[i * nFreqs + j] = Math.max(Math.min(rising, falling), 0);
    }
  }
  return fb;
}

/**
 * Linear resample, matching `dataset.py`.
 *
 * ⚠️ `dataset.py` builds its index with `torch.linspace(0, len-1, int(len * 48000 / rate)).long()`, and
 * `.long()` TRUNCATES. So the length is the truncated product, not a rounded one, and the index is truncated
 * too. A model trained at 48 kHz never takes this path, which is exactly why getting it wrong here would go
 * unnoticed until somebody embedded a 44.1 kHz model.
 */
export function resampleTo(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const steps = Math.trunc((samples.length * toRate) / fromRate);
  const out = new Float64Array(steps);
  const step = steps > 1 ? (samples.length - 1) / (steps - 1) : 0;
  for (let i = 0; i < steps; i++) out[i] = samples[Math.trunc(i * step)] ?? 0;
  return out;
}

/** Reflect-pad both ends by `pad`, which is `torch.stft`'s `center=True, pad_mode='reflect'`. */
export function reflectPad(x, pad) {
  const n = x.length;
  if (n < 2) throw new Error('reflectPad: needs at least two samples');
  const out = new Float64Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) out[i] = x[pad - i];
  out.set(x, pad);
  for (let i = 0; i < pad; i++) out[pad + n + i] = x[n - 2 - i];
  return out;
}

/**
 * How many frames a clip produces, from the front end alone.
 *
 * One function, used by the spectrogram AND by the shape checks, so "does this kernel fit the feature map" is
 * answered with the same arithmetic that builds it. Two copies of this formula is how a container passes its
 * checks and then throws at inference.
 */
export function featureFrames(fe = FRONT_END) {
  const want = Math.trunc(fe.sampleRate * fe.clipSeconds);
  const pad = fe.center ? fe.nFft / 2 : 0;
  return 1 + Math.floor((want + 2 * pad - fe.nFft) / fe.hop);
}

/**
 * The log-mel spectrogram: `[nMels][frames]`, row-major, normalised over the whole clip.
 *
 * ⚠️ THE NORMALISATION IS PER CLIP, over every mel bin and every frame, which means this is a TWO-PASS
 * operation over the whole spectrogram — not a running normalisation a streaming implementation could
 * approximate. A clip's own loudness therefore cancels out; a model fed un-normalised features would see a
 * level the training data never had.
 */
export function logMel(samples, sampleRate, fe = FRONT_END) {
  let wave = resampleTo(samples, sampleRate, fe.sampleRate);
  const want = Math.trunc(fe.sampleRate * fe.clipSeconds);
  if (wave.length < want) {
    const padded = new Float64Array(want);
    padded.set(wave);
    wave = padded;
  } else if (wave.length > want) {
    wave = wave.slice(0, want);
  }

  // ⚠️ A FIELD THE READER CANNOT HONOUR IS AN ERROR, NOT A PREFERENCE TO IGNORE. The first version of this
  // function had `fe.window === 'hann-periodic' ? hannPeriodic(n) : hannPeriodic(n)` — both branches the same,
  // so a container claiming a symmetric window was read with a periodic one and said nothing. `classifierProblems`
  // refuses such a container before it gets here; this makes the silence impossible from either direction.
  if (fe.window !== 'hann-periodic') throw new Error(`this runtime computes the periodic Hann window, not "${fe.window}"`);
  if (fe.padMode !== 'reflect') throw new Error(`this runtime reflects at the edges, it does not "${fe.padMode}"`);

  const pad = fe.center ? fe.nFft / 2 : 0;
  const framed = reflectPad(wave, pad);
  const nFrames = featureFrames(fe);
  const nFreqs = fe.nFft / 2 + 1;
  const window = hannPeriodic(fe.nFft);
  const mel = melFilterbank({ nMels: fe.nMels, nFreqs, sampleRate: fe.sampleRate, fmin: fe.fmin });

  const spec = new Float64Array(nFreqs * nFrames);
  const re = new Float64Array(fe.nFft);
  const im = new Float64Array(fe.nFft);
  for (let f = 0; f < nFrames; f++) {
    const at = f * fe.hop;
    for (let i = 0; i < fe.nFft; i++) {
      re[i] = framed[at + i] * window[i];
      im[i] = 0;
    }
    const { re: R, im: I } = fftInPlace(re, im);
    for (let k = 0; k < nFreqs; k++) spec[k * nFrames + f] = Math.hypot(R[k], I[k]);
  }

  // mel @ spec, then log, then the clip's own mean and (unbiased) standard deviation.
  const out = new Float64Array(fe.nMels * nFrames);
  for (let m = 0; m < fe.nMels; m++) {
    for (let f = 0; f < nFrames; f++) {
      let sum = 0;
      for (let k = 0; k < nFreqs; k++) sum += mel[m * nFreqs + k] * spec[k * nFrames + f];
      out[m * nFrames + f] = Math.log(sum + fe.logEps);
    }
  }
  let mean = 0;
  for (let i = 0; i < out.length; i++) mean += out[i];
  mean /= out.length;
  let ss = 0;
  for (let i = 0; i < out.length; i++) { const d = out[i] - mean; ss += d * d; }
  const denom = fe.stdUnbiased ? Math.max(out.length - 1, 1) : out.length;
  const std = Math.sqrt(ss / denom);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - mean) / (std + 1e-5);
  return { features: out, nMels: fe.nMels, frames: nFrames };
}

// ── the front-end probe, which is how a drift is caught even when it costs nothing ───────────────────────
/**
 * ⚠️ THE ACCURACY CHECK CANNOT SEE EVERY DRIFT, AND THAT IS THE HOLE THIS CLOSES.
 *
 * If the runtime's front end has drifted from the training project's, the model usually gets worse — but not
 * always. A model with a wide margin still scores 100% with a different hop, and for a model like that the
 * accuracy check is silent: the drift is real, invisible, and it will bite on the first clip that is not as
 * easy as the test set.
 *
 * So the container carries a PROBE: the moments of the spectrogram of one canonical clip, computed by whoever
 * built the container. VERIFY recomputes them and compares. A drift moves them whether or not it moves the
 * accuracy, and it moves them by orders of magnitude more than the difference between a float32 training
 * pipeline and a float64 runtime (~1e-7).
 *
 * The moments are MIN, MAX, MEAN|X| and three quantiles rather than the mean and standard deviation, and that is
 * not a style choice: the normalisation makes every clip's mean exactly 0 and its standard deviation exactly 1,
 * so those two are constants and would prove nothing.
 */
export const PROBE_TONES = [{ hz: 440, amplitude: 1 }, { hz: 1310, amplitude: 0.5 }];

/** The canonical clip, at the front end's own rate and length. Both languages synthesise this identically. */
export function probeClip(fe = FRONT_END) {
  const n = Math.trunc(fe.sampleRate * fe.clipSeconds);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const t of PROBE_TONES) v += t.amplitude * Math.sin((2 * Math.PI * t.hz * i) / fe.sampleRate);
    x[i] = v;
  }
  return x;
}

/** The probe's numbers, rounded to six decimals so a last-bit difference cannot make two equal probes unequal. */
export function frontEndProbe(fe = FRONT_END) {
  const { features, frames } = logMel(probeClip(fe), fe.sampleRate, fe);
  const sorted = Array.from(features).sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
  let meanAbs = 0;
  for (const v of features) meanAbs += Math.abs(v);
  return {
    tones: PROBE_TONES.map((t) => t.hz),
    frames,
    min: r6(sorted[0]),
    max: r6(sorted[sorted.length - 1]),
    mean_abs: r6(meanAbs / features.length),
    p05: r6(at(0.05)),
    p50: r6(at(0.5)),
    p95: r6(at(0.95)),
  };
}

/**
 * Which probe numbers no longer match.
 *
 * The frame count is exact — it is an integer and it is the thing a hop or a padding change moves first. The rest
 * are compared RELATIVELY, with a tolerance nine orders of magnitude above the noise between a float32 training
 * pipeline and a float64 runtime, so a mismatch means a drifting front end rather than two libm versions.
 */
export function compareProbe(expected, actual, tolerance = 1e-3) {
  if (!expected || !actual) return [];
  const bad = [];
  if (expected.frames !== actual.frames) bad.push({ field: 'frames', expected: expected.frames, actual: actual.frames });
  for (const field of ['min', 'max', 'mean_abs', 'p05', 'p50', 'p95']) {
    if (expected[field] == null || actual[field] == null) continue;
    const scale = Math.max(1, Math.abs(expected[field]));
    if (Math.abs(expected[field] - actual[field]) > tolerance * scale) {
      bad.push({ field, expected: expected[field], actual: actual[field] });
    }
  }
  return bad;
}

const r6 = (x) => Number(x.toFixed(6));

// ── the container ────────────────────────────────────────────────────────────────────────────────────────

/** The front-end parameters a container carries, so a reader does not have to assume the family's defaults. */
export const frontEndOf = (model) => ({ ...FRONT_END, ...(model?.io?.front_end || {}) });

/** Decode a WAV buffer to mono, the way the training project does — mean across channels, not channel 0. */
export function monoFromWav(buf, mixdown = 'mean') {
  const w = decodeWav(buf);
  if (w.channels === 1 || mixdown === 'first') return { sampleRate: w.sampleRate, samples: w.data[0] };
  const n = w.frames;
  const out = new Float64Array(n);
  for (let c = 0; c < w.channels; c++) {
    const ch = w.data[c];
    for (let i = 0; i < n; i++) out[i] += ch[i];
  }
  for (let i = 0; i < n; i++) out[i] /= w.channels;
  return { sampleRate: w.sampleRate, samples: out };
}

/** One tensor's real values, from its codes and its scale(s). */
export function dequantize(t) {
  const n = t.codes.length;
  const out = new Float64Array(n);
  if (t.scales && t.scales.length) {
    const block = t.block_size > 0 ? t.block_size : 1;
    for (let i = 0; i < n; i++) out[i] = t.codes[i] * t.scales[Math.floor(i / block)];
  } else {
    for (let i = 0; i < n; i++) out[i] = t.codes[i] * t.scale;
  }
  return out;
}

const tensorOf = (layer, name) => (layer.tensors || []).find((t) => t.name === name) || null;

/**
 * The tower, as `{ kind, attrs, weight, bias }` with the weights already dequantized.
 *
 * ⚠️ THE LAYER LIST *IS* THE GRAPH. There is no architecture-specific code below this line: the runtime walks
 * whatever layers the container holds, so a second architecture is a second emitter rather than a second
 * runtime — and `pool: 'avg-all'` is how the global average pool is spelled, because it belongs to the conv
 * that precedes it rather than floating between layers where nothing would check it.
 */
/**
 * ⚠️ CACHED PER CONTAINER OBJECT, because dequantizing every weight on every call is not part of inferring
 * anything — and a latency figure that included it would be a figure about JSON parsing. The cache is weak, so a
 * container that goes out of scope takes its weights with it, and any packed container is a different object and
 * therefore a different entry.
 */
const towerCache = new WeakMap();

export function readTower(model) {
  const cached = towerCache.get(model);
  if (cached) return cached;
  const layers = [];
  for (const layer of model.layers || []) {
    const weight = tensorOf(layer, 'weight');
    const bias = tensorOf(layer, 'bias');
    if (!weight) throw new Error(`${layer.name}: no weight tensor`);
    layers.push({
      name: layer.name,
      kind: layer.kind,
      pad: layer.pad ?? 0,
      act: layer.act ?? 'none',
      pool: layer.pool ?? null,
      weight: dequantize(weight),
      weightShape: weight.shape,
      bias: bias ? dequantize(bias) : null,
    });
  }
  towerCache.set(model, layers);
  return layers;
}

/** The label list, or a throw — a classifier without readable outputs is not a classifier. */
export function labelsOf(model) {
  const labels = model?.task?.labels;
  if (!Array.isArray(labels) || labels.length < 2) throw new Error('the container carries no usable label list');
  return labels;
}

function conv2d(x, C, H, W, layer) {
  const [OC, IC, KH, KW] = layer.weightShape;
  if (IC !== C) throw new Error(`${layer.name}: expects ${IC} input channels, the tensor before it has ${C}`);
  const pad = layer.pad;
  const oh = H + 2 * pad - KH + 1;
  const ow = W + 2 * pad - KW + 1;
  const out = new Float64Array(OC * oh * ow);
  for (let oc = 0; oc < OC; oc++) {
    const bias = layer.bias ? layer.bias[oc] : 0;
    for (let y = 0; y < oh; y++) {
      for (let xx = 0; xx < ow; xx++) {
        let sum = bias;
        for (let ic = 0; ic < IC; ic++) {
          for (let ky = 0; ky < KH; ky++) {
            const iy = y + ky - pad;
            if (iy < 0 || iy >= H) continue;
            for (let kx = 0; kx < KW; kx++) {
              const ix = xx + kx - pad;
              if (ix < 0 || ix >= W) continue;
              sum += layer.weight[((oc * IC + ic) * KH + ky) * KW + kx] * x[(ic * H + iy) * W + ix];
            }
          }
        }
        if (layer.act === 'relu' && sum < 0) sum = 0;
        out[(oc * oh + y) * ow + xx] = sum;
      }
    }
  }
  return { data: out, C: OC, H: oh, W: ow };
}

function pool2(x, C, H, W) {
  const oh = Math.floor(H / 2);
  const ow = Math.floor(W / 2);
  const out = new Float64Array(C * oh * ow);
  for (let c = 0; c < C; c++) {
    for (let y = 0; y < oh; y++) {
      for (let xx = 0; xx < ow; xx++) {
        let m = -Infinity;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const v = x[(c * H + (2 * y + dy)) * W + (2 * xx + dx)];
          if (v > m) m = v;
        }
        out[(c * oh + y) * ow + xx] = m;
      }
    }
  }
  return { data: out, C, H: oh, W: ow };
}

function avgAll(x, C, H, W) {
  const out = new Float64Array(C);
  for (let c = 0; c < C; c++) {
    let s = 0;
    for (let i = 0; i < H * W; i++) s += x[(c * H) * W + i];
    out[c] = s / (H * W);
  }
  return out;
}

/**
 * The forward pass, over the container's own codes and scales.
 *
 * ⚠️ IT READS THE QUANTISED WEIGHTS, NOT A FLOAT COPY. That is the point: PACK's whole question — "what does 8
 * bits cost in accuracy?" — is answered by running THIS on the packed container and comparing with the same
 * call on the float one. A forward pass that dequantized into a float cache once and never looked again would
 * report that packing is free.
 */
export function forward(model, features, nMels, frames) {
  return softmax(runLayers(readTower(model), features, nMels, frames, false));
}

/**
 * The vector the HEAD sees: the pooled (or flattened) output of the convolutional tower.
 *
 * Exported because VERIFY and the fixture builder both need to look at what the tower produces rather than at
 * what the head decides — a report about a model whose features are all identical should say so, and a fixture
 * that fits a head has to see the features it is fitting.
 */
export function pooledFeatures(model, samples, sampleRate) {
  const fe = frontEndOf(model);
  const { features, nMels, frames } = logMel(samples, sampleRate, fe);
  return runLayers(readTower(model), features, nMels, frames, true);
}

/** The convolutional stack, then optionally the head. One walk, so the two cannot disagree about the tower. */
function runLayers(tower, features, nMels, frames, stopAtHead) {
  let x = { data: features, C: 1, H: nMels, W: frames };
  let flat = null;
  for (const layer of tower) {
    if (layer.kind === 'conv2d') {
      x = conv2d(x.data, x.C, x.H, x.W, layer);
      if (layer.pool === 2) x = pool2(x.data, x.C, x.H, x.W);
      else if (layer.pool === 'avg-all') flat = avgAll(x.data, x.C, x.H, x.W);
    } else if (layer.kind === 'linear') {
      if (stopAtHead) break;
      const [OC, IC] = layer.weightShape;
      // ⚠️ EITHER AN AVERAGE POOL OR A FLATTEN, and which one is not a guess: an `avg-all` conv sets `flat`, and
      // a head with no pool before it reads the feature map directly, row-major `[C][H][W]`. That is the order a
      // contiguous NCHW tensor flattens to, so it is the order the training project's `nn.Flatten` produced.
      const vec = flat ?? x.data;
      if (IC !== vec.length) {
        throw new Error(`${layer.name}: expects ${IC} inputs, the layer before it produces ${vec.length}`);
      }
      const out = new Float64Array(OC);
      for (let oc = 0; oc < OC; oc++) {
        let sum = layer.bias ? layer.bias[oc] : 0;
        for (let i = 0; i < IC; i++) sum += layer.weight[oc * IC + i] * vec[i];
        out[oc] = sum;
      }
      flat = out;
    } else {
      throw new Error(`${layer.name}: unknown layer kind "${layer.kind}"`);
    }
  }
  if (!flat) {
    // A conv-only tower is legitimate for `pooledFeatures` and means the caller asked for features; for `forward`
    // it means there is no head, which is a broken container rather than an empty answer.
    if (stopAtHead) return x.data;
    throw new Error('the tower produced no output — it has no classifier head');
  }
  return flat;
}

/** Softmax, shifted by the max so a large logit cannot overflow it. */
export function softmax(scores) {
  let m = -Infinity;
  for (const s of scores) if (s > m) m = s;
  let sum = 0;
  const out = new Float64Array(scores.length);
  for (let i = 0; i < scores.length; i++) { out[i] = Math.exp(scores[i] - m); sum += out[i]; }
  for (let i = 0; i < out.length; i++) out[i] /= sum;
  return out;
}

/** Classify one clip's samples. Returns the scores AND the index, because a report needs both. */
export function classify(model, samples, sampleRate) {
  const fe = frontEndOf(model);
  const { features, nMels, frames } = logMel(samples, sampleRate, fe);
  const scores = forward(model, features, nMels, frames);
  const labels = labelsOf(model);
  if (scores.length !== labels.length) {
    throw new Error(`the head has ${scores.length} outputs and the container names ${labels.length} labels`);
  }
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  return { index: best, label: labels[best], scores: Array.from(scores) };
}

// ── what is wrong with a container, beyond the format itself ──────────────────────────────────────────────

/**
 * The CLASSIFIER's problems, on top of `validateModel`'s format checks.
 *
 * The format asks "is this a readable container"; this asks "is it a readable container OF THIS FAMILY" — the
 * tower's shapes have to chain, the head has to have one output per label, and the front end has to be one this
 * runtime can actually compute. Both are reported the same way so a caller prints one list.
 */
export function classifierProblems(model) {
  const problems = [];
  if (model?.architecture !== CLASSIFIER_ARCH) {
    problems.push(`architecture is "${model?.architecture}", and this reader knows "${CLASSIFIER_ARCH}"`);
    return problems;
  }
  let labels = [];
  try { labels = labelsOf(model); } catch (e) { problems.push(e.message); }
  const fe = frontEndOf(model);
  if (!Number.isInteger(fe.nFft) || (fe.nFft & (fe.nFft - 1)) !== 0) problems.push(`nFft must be a power of two, got ${fe.nFft}`);
  if (!(fe.hop > 0 && fe.hop <= fe.nFft)) problems.push(`hop must be in 1..nFft, got ${fe.hop}`);
  if (!(fe.nMels > 0)) problems.push(`nMels must be positive, got ${fe.nMels}`);
  if (fe.window !== 'hann-periodic') problems.push(`unknown window "${fe.window}" — the runtime only computes the periodic Hann`);
  if (fe.padMode !== 'reflect') problems.push(`unknown padMode "${fe.padMode}" — the runtime only reflects`);
  // ⚠️ A FIELD THE READER NEVER LOOKS AT IS A FIELD THAT CAN SAY ANYTHING. `normalize` and `mixdown` were declared
  // in FRONT_END and silently ignored, so a container claiming "no normalisation" or "left channel only" would
  // have been read as if it said the opposite. A front end this runtime cannot honour is refused, not ignored.
  if (fe.normalize !== FRONT_END.normalize) problems.push(`unknown normalize "${fe.normalize}" — the runtime normalises each clip by its own mean and standard deviation`);
  if (fe.mixdown !== FRONT_END.mixdown) problems.push(`unknown mixdown "${fe.mixdown}" — the runtime averages the channels`);

  // The tower has to chain: channels into each conv, and a final width that matches the head's inputs.
  let C = 1;
  let H = fe.nMels;
  let W = featureFrames(fe);
  let flat = null;
  let sawHead = false;
  for (const layer of model.layers || []) {
    const k = layer.kind;
    if (!LAYER_KINDS[k]) { problems.push(`${layer.name}: unknown layer kind "${k}"`); continue; }
    const w = tensorOf(layer, 'weight');
    if (!w) { problems.push(`${layer.name}: no weight tensor`); continue; }
    if (k === 'conv2d') {
      if (w.shape.length !== 4) { problems.push(`${layer.name}: a conv2d weight needs 4 dimensions, got ${w.shape.length}`); continue; }
      const [OC, IC, KH, KW] = w.shape;
      if (IC !== C) problems.push(`${layer.name}: takes ${IC} input channels, the layer before it produces ${C}`);
      const pad = layer.pad ?? 0;
      const oh = H + 2 * pad - KH + 1;
      const width = W + 2 * pad - KW + 1;
      if (oh <= 0 || width <= 0) { problems.push(`${layer.name}: the kernel does not fit the feature map`); continue; }
      C = OC;
      if (layer.pool === 2) { H = Math.floor(oh / 2); W = Math.floor(width / 2); flat = null; }
      else if (layer.pool === 'avg-all') { flat = C; }
      else { H = oh; W = width; }
    } else {
      if (sawHead) problems.push(`${layer.name}: a second linear layer — this runtime has one head`);
      if (w.shape.length !== 2) { problems.push(`${layer.name}: a linear weight needs 2 dimensions, got ${w.shape.length}`); continue; }
      const [OC, IC] = w.shape;
      const inputs = flat ?? C * H * W;
      if (IC !== inputs) problems.push(`${layer.name}: takes ${IC} inputs, the layer before it produces ${inputs}`);
      if (labels.length && OC !== labels.length) {
        problems.push(`${layer.name}: ${OC} outputs for ${labels.length} labels, so the scores cannot be named`);
      }
      sawHead = true;
      C = OC;
      flat = OC;
    }
  }
  if (!sawHead) problems.push('the tower has no linear head, so it classifies nothing');
  return problems;
}

/** A one-line description, for a report or a log. */
export function describeClassifier(model) {
  let labels = [];
  try { labels = labelsOf(model); } catch { /* reported by classifierProblems */ }
  const fe = frontEndOf(model);
  return `${model?.architecture} · ${labels.length} labels · ${fe.nMels} mel × ${fe.nFft}/${fe.hop} · `
    + `${(model?.layers || []).length} layers · ${fe.sampleRate} Hz`;
}
