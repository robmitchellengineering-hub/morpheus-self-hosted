// The task families Morpheus can build, as DATA — the same move as the audio block registry, one level up.
//
// ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────────────────────────────────
// The audio pathway already does the whole job for one task: a container, a runtime, a generator that writes
// source you own, a pre-flight that tells you whether your data is any good, and a measurement. What it does
// not do is generalise — everything about it is shaped like an amplifier.
//
// A task family is that shape, named. `audio.classify` is the first entry and the only one with an
// implementation so far; the others are listed because the STAGES are the same five for all of them, and
// because a family that is not in here cannot be built without inventing a sixth stage.
//
// ── THE FIVE STAGES, AND WHICH OF THEM THIS ONE FAMILY HAS ────────────────────────────────────────────────
//
//   COLLECT ──▶ TRAIN ──▶ VERIFY ──▶ PACK ──▶ EMBED
//    built      theirs     planned   partly    planned
//
// **TRAIN IS THEIRS AND ALWAYS WILL BE.** Not a limitation to apologise for: training on Morpheus's hardware
// would be a fixed cost paid before the first customer, and it would make every user's model our liability.
// What we generate is the project they run — pinned, resumable, with our measurement built in.
//
// ── ⚠️ WHY THE RUNTIME IS US RATHER THAN A LIBRARY ───────────────────────────────────────────────────────
// The obvious answer for `audio.classify` is TensorFlow Lite: Apache-2.0, small, everywhere. It is not the
// answer here, for the reason the plugin pipeline already proves: **we can generate the forward pass as
// source.** A model compiled to a few hundred lines of C++ has no library to ship, no ABI to match, no
// licence file to carry and no runtime to be deprecated out from under it — and the user owns it, which is
// the whole product promise. A library is what you reach for when you cannot write the forward pass; for the
// sizes this feature is for, we can.
//
// The audio amp model is the precedent: `morpheus-model/1` already holds integer weights at a real bit width,
// with per-channel scales and an accumulator width, and `namPlugin.js` already embeds a reference runtime
// (NeuralAmpModelerCore, MIT) rather than hand-porting WaveNet. That container is not amp-shaped. This
// registry is what makes it a family rather than a coincidence.

/**
 * The families, in the order a person would meet them.
 *
 * `built` is the honest state: a family whose data contract exists and whose training project does not is
 * marked as such, because a registry that lists nine families and implements none of them is a brochure.
 */
export const TASK_FAMILIES = [
  {
    id: 'audio.classify',
    label: 'Audio — tell sounds apart',
    question: 'Which of these is it?',
    // ⚠️ WHY THIS ONE FIRST. It is the smallest thing that exercises every NEW part — a family the container
    // has never held, a non-plugin embedding, a second kind of measurement — for the same customer, into the
    // same compile targets, using the capture and verification machinery that already exists. If the template
    // does not generalise here it does not generalise, and finding that out costs a week rather than a month.
    why: 'A guitar that sounds wrong, a machine that is about to fail, a bird, a cough: the same model shape '
      + 'answers all of them, and it is small enough to embed in firmware.',
    data: {
      layout: 'one directory per label, .wav files inside it',
      extensions: ['.wav'],
      minLabels: 2,
      maxLabels: 64,
      minClipsPerLabel: 20,
      recommendedClipsPerLabel: 200,
      minSeconds: 0.25,
      maxSeconds: 30,
      // ⚠️ THE SPLIT IS PART OF THE CONTRACT RATHER THAN THE TRAINING PROJECT'S BUSINESS, because the way this
      // goes wrong is not a bad split ratio — it is the SAME RECORDING appearing on both sides of it. A
      // classifier that has seen the test clip scores 99% and is worth nothing, and the number looks like
      // success from every angle. See `checkDataset` for the leak check, which is the reason this file exists.
      // ⚠️ THE SPLIT IS BY RECORDING, NOT BY CLIP, AND THE NAMES ARE HOW IT KNOWS. Windows of one take are
      // near-identical, so a clip-level split puts some in train and some in test and reports a score that
      // measures memory. The rule is published here rather than guessed at by the pre-flight: a convention the
      // user can follow beats a heuristic that fires on everybody.
      split: { train: 0.8, validation: 0.1, test: 0.1, recordingRule: 'the file name before the first _ or - is the recording; clips sharing one are never split across train and test' },
      recommendedClipsTotal: 100,
    },
    runtime: { how: 'generated', what: 'a small convolutional network, emitted as C++ and Python source' },
    embed: ['cpp', 'python'],
    measure: ['accuracy', 'confusion', 'bytes', 'latencyMs'],
    // Said plainly rather than discovered: what this family will not do, and why.
    notYet: [
      'no detection or segmentation — one label per clip, not one per region',
      'no multi-label clips, so a recording of two things at once belongs to neither',
      'no streaming — a clip is classified whole, which is also what makes the latency figure honest',
    ],
    built: ['data'],
    next: ['train', 'verify', 'pack', 'embed'],
  },
];

/** The family with this id, or null. Unknown ids are NOT guessed at — see `taskFamilyFor`. */
export const taskFamily = (id) => TASK_FAMILIES.find((f) => f.id === String(id || '')) || null;

/** The ids, for a CLI or a picker. */
export const taskFamilyIds = () => TASK_FAMILIES.map((f) => f.id);

/**
 * What is wrong with a family definition, as a list of reasons.
 *
 * A registry is data and data drifts. This is the check that a new entry is complete rather than merely
 * present: a family that names no data contract, no runtime, no embedding target or no measurement is a
 * family nobody can build, and it would fail at the far end of the pipeline instead of here.
 */
export function validateRegistry(families = TASK_FAMILIES) {
  const problems = [];
  const seen = new Set();
  for (const f of families) {
    const at = f?.id || '(no id)';
    if (!f?.id) problems.push('a family has no id');
    else if (seen.has(f.id)) problems.push(`${at}: two families share this id`);
    seen.add(f?.id);
    for (const field of ['label', 'question', 'why']) {
      if (!f?.[field]) problems.push(`${at}: has no ${field}`);
    }
    if (!f?.data) problems.push(`${at}: names no data contract, so nothing can say whether a dataset fits it`);
    if (!f?.runtime?.how) problems.push(`${at}: names no runtime, so nobody can say what a model runs on`);
    if (!Array.isArray(f?.embed) || !f.embed.length) problems.push(`${at}: names no embedding target, so a trained model has nowhere to go`);
    if (!Array.isArray(f?.measure) || !f.measure.length) problems.push(`${at}: names no measurement, so nothing can say whether it works`);
    if (!Array.isArray(f?.built) || !f.built.length) problems.push(`${at}: claims to have built nothing`);
  }
  return problems;
}
