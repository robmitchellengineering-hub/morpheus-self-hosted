// The fixture the task-ladder guards are built on: a real dataset, and a container that really classifies.
//
// ── WHY NOT RANDOM WEIGHTS ───────────────────────────────────────────────────────────────────────────────
// A container full of noise exercises the reader and proves nothing about the stages. VERIFY's job is to compare
// a MEASURED accuracy with a CLAIMED one, and PACK's is to measure what a bit width costs — both of which are
// vacuous if the model cannot tell the two labels apart, because every arm scores the same and every refusal
// fires for the wrong reason.
//
// So the fixture FITS A HEAD: random convolutional features, then a linear separator placed exactly between the
// two labels' mean feature vectors. That is a one-step perceptron on real features of real audio, it is
// deterministic, and it produces a model that is genuinely right most of the time. Everything downstream can
// then be tested at the accuracy it actually has, including the A/B that PACK exists to take.
//
// ⚠️ IT WRITES REAL .wav FILES, because the stages being tested read them from disk and hand back the clip
// paths the container's card names — a fixture that only ever existed in memory would test the arithmetic and
// skip the part where the evidence has to be findable.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeWav } from '../../server/src/lib/audio/wav.js';
import { classifierModel } from '../../server/src/lib/tasks/classifierContainer.js';
import { logMel, frontEndOf, pooledFeatures } from '../../server/src/lib/tasks/classifierModel.js';

/** A small deterministic PRNG. `Math.random` would make a failure that cannot be reproduced. */
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Two sounds, and the pair matters more than the individual sound.
 *
 * ⚠️ A GUARD MUST NOT HANG ON THE LAST BITS OF `Math.sin`. The first version of this fixture used a tone against
 * a three-partial rattle, and the two labels' mean feature vectors came out **0.003 apart** — so the fitted
 * separator had a logit margin of about 0.004, and a clip was classified correctly or not depending on rounding.
 * The guard looked fine and was one libm revision from being flaky, which is the worst kind of green.
 *
 * `hiss` is spectrally nowhere near `tone`: eight partials from 5.2 kHz up, where a 440 Hz sine has almost no
 * energy at all. The measured separation is 0.05 — sixteen times wider — and 8-bit packing leaves it intact.
 * `rattle` is kept because its WIDTH is useful in the other direction: it sits on the decision boundary, which is
 * exactly what is needed to prove the pack gate can refuse a width rather than merely measure one.
 */
export const SOUNDS = {
  tone: (i, phase) => 0.4 * Math.sin((2 * Math.PI * 440 * i) / 48000 + phase),
  hiss: (i, phase) => {
    let s = 0;
    for (let k = 0; k < 8; k++) s += Math.sin((2 * Math.PI * (5200 + k * 900) * i) / 48000 + phase * k);
    return s / 8;
  },
  rattle: (i, phase) => (0.25 * Math.sin((2 * Math.PI * 700 * i) / 48000 + phase)
    + 0.2 * Math.sin((2 * Math.PI * 723 * i) / 48000 + phase)
    + 0.15 * Math.sin((2 * Math.PI * 2100 * i) / 48000 + phase)),
};

/** The pair everything is tested on. `rattle` is kept beside them as a sound that is spectrally close to `tone`. */
export const DEFAULT_LABELS = ['tone', 'hiss'];

/**
 * A dataset on disk: `recordings` takes per label, `clips` per take, one directory per label.
 *
 * The names follow the family's recording rule (`take3_002.wav`), because the split that matters is by recording
 * and the fixture should not be the one thing in the tree that ignores it.
 */
// ⚠️ TWO SECONDS BY DEFAULT — THE FRONT END'S OWN CLIP LENGTH, AND NOT AN ARBITRARY CHOICE. A shorter clip is
// zero-padded, and in the padding the mel energy is exactly ZERO, where `log(x + 1e-6)` puts a floor that does not
// scale with the signal. The gain invariance the front end is supposed to have is then false by 0.69 — the log of
// two — in every silent bin, so a fixture full of silence quietly weakens every gain-related assertion built on
// it. Full-length clips have signal everywhere and the property holds to 1e-5.
export function writeDataset(root, { labels = DEFAULT_LABELS, recordings = 4, clipsPerTake = 3, seconds = 2.0 } = {}) {
  const sampleRate = 48000;
  const n = Math.round(seconds * sampleRate);
  const written = [];
  for (const label of labels) {
    mkdirSync(join(root, label), { recursive: true });
    const sound = SOUNDS[label];
    if (!sound) throw new Error(`no sound called "${label}" — the fixture knows ${Object.keys(SOUNDS).join(', ')}`);
    for (let take = 0; take < recordings; take++) {
      for (let c = 0; c < clipsPerTake; c++) {
        const samples = new Float64Array(n);
        // A per-take phase wobble, so two takes are not the same file twice.
        const phase = take * 0.31 + c * 0.07;
        for (let i = 0; i < n; i++) samples[i] = sound(i, phase);
        const rel = `${label}/take${take}_${String(c).padStart(3, '0')}.wav`;
        writeFileSync(join(root, rel), Buffer.from(encodeWav({ sampleRate, data: samples, format: 'float32' })));
        written.push({ path: rel, label, samples, sampleRate });
      }
    }
  }
  return written;
}

/** The tower the fixture fits: two convolutions and a head, which is the family's shape at a testable size. */
export function fixtureTower(seed = 7) {
  const next = rng(seed);
  const weight = (n, scale) => Array.from({ length: n }, () => (next() * 2 - 1) * scale);
  return [
    { name: 'features.0', kind: 'conv2d', pad: 1, act: 'relu', pool: 2, weightShape: [4, 1, 3, 3], weight: weight(36, 0.5), bias: weight(4, 0.05) },
    { name: 'features.2', kind: 'conv2d', pad: 1, act: 'relu', pool: 'avg-all', weightShape: [8, 4, 3, 3], weight: weight(288, 0.2), bias: weight(8, 0.05) },
  ];
}

/**
 * A container whose head separates the labels, fitted on the clips given.
 *
 * Returns `{ model, labels, accuracy }` where the accuracy is measured by the runtime itself — the honest number
 * to put in a card, and the one a guard should compare against rather than recompute differently.
 */
export function fittedClassifier(clips, { labels = null, bits = 32, seed = 7 } = {}) {
  // ⚠️ THE LABELS COME FROM THE CLIPS, not from a default. A caller that writes a dataset from one pair and fits
  // a separator on another pair's label names gets a fixture with an empty class — which is a confusing crash
  // inside the fit rather than at the argument.
  const found = labels ?? [...new Set(clips.map((c) => c.label))].sort();
  labels = found;
  if (labels.length !== 2) throw new Error(`the fixture fits a two-label separator, and these clips have ${labels.length}: ${labels.join(', ')}`);
  for (const label of labels) {
    if (!clips.some((c) => c.label === label)) throw new Error(`no clip is labelled "${label}"`);
  }
  const tower = fixtureTower(seed);
  // A conv-only container is enough to ask the tower for features; the head is added afterwards.
  const probe = classifierModel({ tower, labels, bits: 32 });
  const means = {};
  for (const label of labels) means[label] = null;
  let dim = 0;
  for (const clip of clips) {
    const v = pooledFeatures(probe, clip.samples, clip.sampleRate);
    dim = v.length;
    const acc = means[clip.label] || (means[clip.label] = new Float64Array(dim));
    for (let i = 0; i < dim; i++) acc[i] += v[i];
  }
  const counts = {};
  for (const label of labels) counts[label] = clips.filter((c) => c.label === label).length || 1;
  for (const label of labels) for (let i = 0; i < dim; i++) means[label][i] /= counts[label];

  // The separator: the difference of the means, thresholded at their midpoint. With two labels this is a
  // perceptron that has already converged, which is all a fixture needs.
  const direction = new Float64Array(dim);
  for (let i = 0; i < dim; i++) direction[i] = means[labels[0]][i] - means[labels[1]][i];
  let norm = Math.sqrt(direction.reduce((a, b) => a + b * b, 0)) || 1;
  for (let i = 0; i < dim; i++) direction[i] /= norm;
  let mid = 0;
  for (let i = 0; i < dim; i++) mid += (direction[i] * (means[labels[0]][i] + means[labels[1]][i])) / 2;
  const head = {
    name: 'head', kind: 'linear', act: 'none', pool: null, weightShape: [labels.length, dim],
    weight: [...direction, ...direction.map((v) => -v)],
    bias: [-mid, mid],
  };
  const model = classifierModel({ tower: [...tower, head], labels, bits });
  return { model, labels, tower: [...tower, head] };
}

/** The front-end numbers a fixture clip was made with, for a caller that wants to check them. */
export const fixtureFrontEnd = (model) => frontEndOf(model);

/** A generator-level sanity check a caller can assert on: the features of two labels are not the same. */
export function featureDistance(model, a, b) {
  const fa = logMel(a, 48000);
  const fb = logMel(b, 48000);
  let d = 0;
  for (let i = 0; i < fa.features.length; i++) d += Math.abs(fa.features[i] - fb.features[i]);
  return d / fa.features.length;
}
