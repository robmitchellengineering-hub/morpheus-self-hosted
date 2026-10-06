// VERIFY and PACK — does a container's claim survive being checked, and is a bit width a measurement?
//
// ── WHY THIS GUARD EXISTS, AND WHAT IT IS ACTUALLY GUARDING ───────────────────────────────────────────────
// The ladder is COLLECT → TRAIN → VERIFY → PACK → EMBED, and the middle two are the ones a person will believe
// without checking. A card that says 94% and a pack report that says "8 bits, no loss" are both just numbers
// until something reproduces them — and the failure they hide is the expensive kind, because it ships:
//
//   * the training project measures the model IN MEMORY; the customer runs the FILE. Between those two points
//     sit the export, the container's codes and scales, the front end the runtime computes and the reader
//     itself. A drift in any of them produces a model worse than the one measured, with no error anywhere.
//   * "8-bit costs nothing" is true for some models and false for others, and the difference is not visible in
//     the file — it has to be measured by running BOTH.
//
// So the assertions here are about REPRODUCIBILITY: the number in the card, got back from the container; a
// container that lies, refused; a front end that drifted from training, caught. The fixture is a model that
// genuinely classifies — a random-weight container would let every one of these pass by agreeing with itself.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encodeWav, decodeWav } from '../server/src/lib/audio/wav.js';
import { validateModel, parseModel, serializeModel, modelBytes } from '../server/src/lib/audio/modelFormat.js';
import {
  FRONT_END, hannPeriodic, linspace, reflectPad, resampleTo, logMel, featureFrames,
  classifierProblems, classify, softmax, dequantize, readTower, frontEndOf, describeClassifier,
  frontEndProbe, compareProbe, PROBE_TONES,
} from '../server/src/lib/tasks/classifierModel.js';
import { classifierModel, pythonFrontEndConstants } from '../server/src/lib/tasks/classifierContainer.js';
import { verifyClassifier, formatVerification, DEFAULT_MARGIN } from '../server/src/lib/tasks/verifyModel.js';
import { packClassifier, packIssues, packableBits, formatPack } from '../server/src/lib/tasks/packModel.js';
import { cppSource, EMBED_TARGETS } from '../server/src/lib/tasks/embedClassifier.js';
import { trainingProject, validateProject } from '../server/src/lib/tasks/trainProject.js';
import { hann } from '../server/src/lib/audio/dsp.js';
import { TASK_FAMILIES, taskFamily, validateRegistry } from '../server/src/lib/tasks/registry.js';
import { writeDataset, fittedClassifier, featureDistance, DEFAULT_LABELS } from './lib/taskFixture.mjs';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}
const ROOT = new URL('..', import.meta.url).pathname;

// ── the fixture: a dataset on disk and a model that really separates it ─────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'morpheus-ladder-'));
const datasetDir = join(work, 'ds');
const clips = writeDataset(datasetDir, { labels: DEFAULT_LABELS, recordings: 3, clipsPerTake: 2 });
const { model, tower } = fittedClassifier(clips);
const labels = model.task.labels;
const cardClips = clips.map((c) => c.path);
const rightOn = (m, list = clips) => list.filter((c) => classify(m, c.samples, c.sampleRate).label === c.label).length;
const accuracyOf = (m, list = clips) => rightOn(m, list) / list.length;
const withCard = (m, { accuracy = null, clips: named = cardClips, split = 'test' } = {}) => ({
  ...m,
  card: { name: 'fixture', split: { name: split, clips: named }, metrics: accuracy == null ? {} : { accuracy, clips: named.length, split } },
});

console.log('\n1. the front end is the training project\'s front end, not a similar one');
// ⚠️ THE PERIODIC HANN, AND THIS IS THE CHECK THAT NAMES IT. `dsp.js` has a Hann window and it is the SYMMETRIC
// one — the right choice for filter design and the wrong one for an STFT. Using it would window every frame
// slightly differently from training, forever, with no error anywhere. So the two are asserted to differ.
check('the STFT window is the periodic Hann that torch.hann_window returns',
  [hannPeriodic(8)[1].toFixed(6), hannPeriodic(8)[0], hannPeriodic(8)[8]],
  [(0.5 * (1 - Math.cos((2 * Math.PI) / 8))).toFixed(6), 0, undefined]);
check('…and NOT the symmetric one dsp.js has, which would window every frame differently',
  Math.abs(hannPeriodic(8)[1] - hann(8)[1]) > 1e-3, true);

// The constants are written twice — once here, once in the generated Python — and that is the one thing about a
// two-language front end that CAN be checked without numpy installed. Read them out of the generated file.
const generated = trainingProject('audio.classify');
const datasetPy = generated.files.find((f) => f.path === 'dataset.py').content;
const constants = pythonFrontEndConstants();
check('the generated dataset.py declares the same five front-end numbers this reader computes with',
  Object.entries(constants).map(([k, v]) => new RegExp(`^${k} = ${v}$`, 'm').test(datasetPy)),
  Object.keys(constants).map(() => true));
check('…so changing the reader\'s front end without changing the training project is a failing build',
  new RegExp(`^HOP = ${FRONT_END.hop}$`, 'm').test(datasetPy), true);

// ⚠️ THE TOLERANCE IS NOT ZERO AND THE REASON IS WORTH KNOWING: doubling a clip doubles the mel energies but not
// the `log(x + 1e-6)` epsilon, so the two spectrograms agree to about 1e-4 rather than exactly. What makes the
// check mean something is the OTHER numbers below — the features are standardised, and a gain change moves them
// by nothing next to the distance between two labels.
// ⚠️ THE MEAN, NOT THE WORST BIN. Doubling a clip adds `log 2` to every bin and the normalisation subtracts the
// mean back off — except in the bins whose energy is down at the `log(x + 1e-6)` floor, where the epsilon does not
// scale and the residual is the log of two. That is a handful of near-silent bins out of 24064, so the worst bin
// is 0.045 and the mean is 0.0037. Asserting on the worst bin would be asserting on the noisiest number in the
// spectrogram; the mean is the one that describes the property.
const gainDiff = (() => {
  const a = logMel(clips[0].samples, 48000).features;
  const b = logMel(Float64Array.from(clips[0].samples, (v) => v * 2), 48000).features;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
})();
check('a clip\'s own loudness cancels out, because the normalisation is per clip', gainDiff < 0.01, true);
check('…and the check has teeth: that is a hundred times smaller than the gap between two labels',
  gainDiff < featureDistance(model, clips[0].samples, clips[clips.length - 1].samples) / 100, true);
check('…because every clip comes out standardised, which is what the normalisation claims',
  (() => {
    const f = logMel(clips[0].samples, 48000).features;
    const mean = f.reduce((a, b) => a + b, 0) / f.length;
    const std = Math.sqrt(f.reduce((a, b) => a + (b - mean) ** 2, 0) / (f.length - 1));
    return [Math.abs(mean) < 1e-9, Math.abs(std - 1) < 1e-4];
  })(), [true, true]);
check('…and a front end this runtime cannot honour is an error, not a preference it ignores',
  (() => {
    try { logMel(clips[0].samples, 48000, { ...FRONT_END, window: 'hann-symmetric' }); return 'computed it anyway'; }
    catch (e) { return /periodic Hann/.test(e.message); }
  })(), true);
check('…and the frame count comes from the same arithmetic that builds the spectrogram',
  [logMel(clips[0].samples, 48000).frames, featureFrames()], [376, 376]);
check('the padding is a reflect, not a zero pad', Array.from(reflectPad(Float64Array.from([1, 2, 3, 4]), 2)), [3, 2, 1, 2, 3, 4, 3, 2]);
check('…and a clip at another sample rate is resampled to the truncated length, as torch does',
  resampleTo(new Float64Array(44100), 44100, 48000).length, Math.trunc((44100 * 48000) / 44100));
check('linspace keeps both endpoints exact, which is what numpy does', [linspace(0, 1, 3)[2], linspace(2, 2, 4)[0]], [1, 2]);
check('the two labels really do look different to the front end, so the fixture is not testing nothing',
  featureDistance(model, clips[0].samples, clips[clips.length - 1].samples) > 0.05, true);
check('softmax is a distribution, so a score can be read as a confidence',
  Math.abs(softmax(Float64Array.from([1, 2, 3])).reduce((a, b) => a + b, 0) - 1) < 1e-12, true);

console.log('\n2. the container a trained model becomes');
check('a classifier container is a valid morpheus-model/1, with no complaints from this reader',
  [validateModel(model).valid, classifierProblems(model)], [true, []]);
check('…and it describes itself in one line', describeClassifier(model).startsWith('AudioClassifier · 2 labels'), true);
// ⚠️ A HEAD THAT CANNOT READ ITS FEATURE MAP IS A CONTAINER THAT THROWS AT INFERENCE. Caught in the shape check,
// where it is a sentence, rather than in `classify`, where it is an exception on somebody's device.
const wrongHead = JSON.parse(JSON.stringify(model));
wrongHead.layers[wrongHead.layers.length - 1].tensors[0].shape = [2, 99];
check('a head whose width does not match the tower is reported, not thrown at inference',
  classifierProblems(wrongHead).some((p) => /takes 99 inputs/.test(p)), true);
const wrongKind = JSON.parse(JSON.stringify(model));
wrongKind.layers[0].kind = 'magic';
check('an unknown layer kind is refused', classifierProblems(wrongKind).some((p) => /unknown layer kind/.test(p)), true);
const wrongWindow = JSON.parse(JSON.stringify(model));
wrongWindow.io.front_end.window = 'hann-symmetric';
check('a front end this runtime cannot compute is refused rather than approximated',
  classifierProblems(wrongWindow).some((p) => /only computes the periodic Hann/.test(p)), true);
// The scales: a conv's weights are quantised per OUTPUT channel, and the format insists several scales come with a
// block size. Without it the container is invalid; with it, `modelBytes` counts 4 bytes per channel, not per code.
const conv = model.layers[0].tensors[0];
check('per-channel scales carry the block size the format needs to count them',
  [conv.scales.length, conv.block_size, conv.codes.length / conv.scales.length], [4, 9, 9]);
check('…and a code dequantizes back to within half a step of the weight it came from',
  (() => {
    const back = dequantize(conv);
    const step = Math.max(...conv.scales);
    let worst = 0;
    for (let i = 0; i < back.length; i++) worst = Math.max(worst, Math.abs(back[i] - tower[0].weight[i]));
    return worst <= step / 2 + 1e-12;
  })(), true);
check('the same reader runs a narrower container and gets nearly the same answer',
  (() => {
    const eight = classifierModel({ tower, labels, bits: 8 });
    const a = classify(model, clips[0].samples, clips[0].sampleRate).scores;
    const b = classify(eight, clips[0].samples, clips[0].sampleRate).scores;
    return Math.max(...a.map((v, i) => Math.abs(v - b[i]))) < 0.05;
  })(), true);
check('…and the byte count follows the width, not the JSON', modelBytes(classifierModel({ tower, labels, bits: 8 })).total < modelBytes(model).total / 3, true);

console.log('\n3. ⭐ VERIFY: the card\'s number, got back out of the container');
const honest = withCard(model, { accuracy: accuracyOf(model) });
const verified = verifyClassifier(honest, clips);
check('a container that does what its card says verifies', verified.ok, true);
check('…and the accuracy it reports is the one the fixture actually has',
  verified.facts.accuracy, accuracyOf(model));
check('…paired with the baseline it had to beat, so a good-looking number means something',
  [verified.facts.baseline, verified.facts.margin > DEFAULT_MARGIN], [0.5, true]);
check('…and the report is readable', formatVerification(verified).includes('baseline'), true);
check('…with bytes and a latency per clip, because those are what an embedding decision needs',
  [verified.facts.bytes > 0, verified.facts.latency_ms_per_clip > 0], [true, true]);

// ⭐⭐ THE CHECK THIS WHOLE STAGE EXISTS FOR, AND IT IS AIMED AT THE CASE THE ACCURACY CANNOT SEE.
// This model has a wide margin: with the wrong hop it still scores every clip correctly. Every accuracy-based
// assertion in this file stays green — which is exactly why a container carries a PROBE of its front end. The
// drift is caught by the probe, on a model whose accuracy never moved.
const drifted = JSON.parse(JSON.stringify(model));
drifted.io.front_end.hop = 128;
const driftedResult = verifyClassifier({ ...drifted, card: honest.card }, clips);
check('⭐ a container whose front end drifted from training is REFUSED, not embedded',
  [driftedResult.ok, driftedResult.issues.some((i) => /front end no longer matches/.test(i.what))], [false, true]);
check('…⭐ even though its accuracy is untouched — the drift costs nothing on this data, which is why it would ship',
  driftedResult.facts.accuracy, accuracyOf(model));
check('…and the reason names the field and both numbers, so the cause can be found',
  /frames: the container says 376, this runtime computes 751/.test(driftedResult.issues.map((i) => i.detail).join(' ')), true);
check('…so a change to the reader\'s front end is a failing build even when every classification still lands',
  (() => {
    const fe = frontEndOf(model);
    const drift = compareProbe(frontEndProbe(fe), frontEndProbe({ ...fe, fmin: 40 }));
    return drift.length > 0;
  })(), true);
check('a container with no probe is warned about rather than passed silently',
  (() => {
    const bare = JSON.parse(JSON.stringify(model));
    delete bare.io.front_end.probe;
    const r = verifyClassifier({ ...bare, card: honest.card }, clips);
    return [r.ok, r.issues.some((i) => /no front-end probe/.test(i.what))];
  })(), [true, true]);
// The probe the training project writes is the one the reader computes — one tone list, in one place.
const exportSrc = generated.files.find((f) => f.path === 'export.py').content;
check('the generated export.py probes with the same tones this reader does',
  [PROBE_TONES.map((t) => t.hz), /PROBE_TONES = \[\{"hz":440/.test(exportSrc)], [[440, 1310], true]);
check('…and it WRITES the probe rather than merely defining the function that computes it',
  /["']probe["']\s*:\s*front_end_probe\(\)/.test(exportSrc), true);
check('…and both halves of the contract are asserted, because one without the other is useless',
  [validateProject(generated).length,
    validateProject({ ...generated, files: generated.files.map((f) => (f.path === 'export.py' ? { ...f, content: f.content.replace('"probe": front_end_probe()', '"probe": {}') } : f)) })
      .some((p) => /does not put a front-end probe/.test(p))],
  [0, true]);

const noEvidence = verifyClassifier({ ...model, card: { metrics: { accuracy: 0.99 } } }, clips);
check('a container that names no test clips is refused: a number nobody can reproduce is not evidence',
  [noEvidence.ok, noEvidence.issues.some((i) => /names no test clips/.test(i.what))], [false, true]);

const gone = withCard(model, { accuracy: accuracyOf(model), clips: cardClips.map((p, i) => (i === 0 ? 'clean/nothing_here.wav' : p)) });
const missing = verifyClassifier(gone, [{ ...clips[0], path: 'clean/nothing_here.wav', samples: null, error: 'not found' }, ...clips.slice(1)]);
check('a clip the card names but the dataset does not have is refused, and counted as unreadable rather than wrong',
  [missing.ok, missing.issues.some((i) => /could not be read/.test(i.what))], [false, true]);
check('…and an unreadable clip does not quietly lower the accuracy',
  missing.facts.accuracy, accuracyOf(model, clips.slice(1)));

const strange = verifyClassifier(withCard(model, { accuracy: accuracyOf(model) }), [{ ...clips[0], label: 'birds' }, ...clips.slice(1)]);
check('a clip in a directory the model has no output for is refused',
  [strange.ok, strange.issues.some((i) => /labelled "birds"/.test(i.what))], [false, true]);

// A model that answers one label every time scores exactly the baseline, and the baseline check is a refusal.
const constant = JSON.parse(JSON.stringify(model));
const headIndex = constant.layers.length - 1;
constant.layers[headIndex].tensors[0].codes = constant.layers[headIndex].tensors[0].codes.map(() => 0);
const flat = verifyClassifier(withCard(constant, { accuracy: 0.5 }), clips);
check('a model that answers the same label every time is refused however good its accuracy looks',
  [flat.ok, flat.issues.some((i) => /does not beat answering/.test(i.what))], [false, true]);

// ⭐ THE CARD'S NUMBER AGAINST THE CONTAINER, IN THE CASE THAT ISOLATES IT. A model that scores 100% cannot be
// over-claimed against (any claim below 100% is an under-claim, correctly ignored), and a model that has been
// made worse usually falls through the BASELINE check first — so a test built on either would pass with the
// claim comparison deleted, which is the failure this file exists to catch. The realistic case is a card whose
// number came from a cleaner run than the container: some clips carry the wrong label, so the model is right
// about most of them, wrong about a few, and comfortably above the baseline.
const mislabelled = clips.map((c, i) => (i % 4 === 0 ? { ...c, label: c.label === labels[0] ? labels[1] : labels[0] } : c));
const overclaimed = verifyClassifier(honest, mislabelled);
check('⭐ a card whose number came from a different run is refused, naming both numbers',
  [overclaimed.ok, overclaimed.issues.filter((i) => i.level === 'fail').length,
    overclaimed.issues.some((i) => /the card claims .* and this container scores/.test(i.what))],
  [false, 1, true]);
check('…and it is the CLAIM that failed, not the baseline — the model still beats answering one label',
  overclaimed.facts.margin > DEFAULT_MARGIN, true);

// Tampering with the weights while leaving the card alone is the cheapest lie there is.
const tampered = JSON.parse(JSON.stringify(model));
tampered.layers[headIndex].tensors[0].codes = tampered.layers[headIndex].tensors[0].codes.map((c) => -c);
const lied = verifyClassifier({ ...tampered, card: honest.card }, clips);
check('…as is a container whose weights no longer match its card at all',
  [lied.ok, lied.facts.claimed_accuracy], [false, accuracyOf(model)]);

const unmeasured = withCard(model, {});
const warned = verifyClassifier(unmeasured, clips);
check('a card with no accuracy warns rather than fails — the baseline was still verified', [warned.ok, warned.issues.some((i) => i.level === 'warn')], [true, true]);

console.log('\n4. PACK: a width is a measurement, not a setting');
const { model: packed, report } = packClassifier(withCard(model, { accuracy: 0.42 }), { bits: 8, clips });
check('packing produces a container the same reader accepts', [validateModel(packed).valid, classifierProblems(packed)], [true, []]);
check('…the report measures agreement and accuracy over the clips, rather than assuming them',
  [typeof report.agreement, typeof report.accuracy_before, report.scored], ['number', 'number', clips.length]);
check('…and reports quantisation noise per layer as well as overall',
  [report.per_layer.length, report.sqnr_db > 0], [3, true]);
check('…and the report is readable', formatPack(report).includes('8-bit'), true);
check('⭐ the packed card carries the MEASURED accuracy, not the one the source container claimed',
  [packed.card.quantization.bits, packed.card.quantization.accuracy_after, packed.card.metrics.accuracy],
  [8, report.accuracy_after, report.accuracy_after]);
check('…so the number that travels with the artefact is the number the artefact earns',
  packed.card.metrics.accuracy !== 0.42, true);
check('this family offers the widths the registry names, and no others',
  [packableBits(), (() => { try { packClassifier(model, { bits: 7, clips: [] }); return 'packed'; } catch (e) { return /can be packed at/.test(e.message); } })()],
  [[32, 16, 8], true]);
check('a pack with nothing to measure is a warning, because a size is not a decision',
  packIssues({ bits: 8, accuracy_before: null, accuracy_after: null }).some((i) => i.level === 'warn'), true);
// ⭐ THE GATE ITSELF. This one is a predicate, tested with a report that has a real drop in it, and the honest
// note is that it is a UNIT test: on THIS model 8 bits happens to cost nothing, so no amount of driving the real
// path would make the gate fire. Forcing it — with an outlier weight, or a model chosen to sit on a rounding
// boundary — would be a fixture built to fail, and a fixture built to fail proves the gate can fire, not that it
// fires at the right moment. What IS proven end to end, just above, is that the numbers it judges are measured.
check('⭐ a width that really does cost accuracy is refused, with the loss named',
  (() => {
    const issues = packIssues({ bits: 8, accuracy_before: 0.95, accuracy_after: 0.80, agreement: 0.97, scored: 120, bytes_before: 1484, bytes_after: 422 });
    return [issues.some((i) => i.level === 'fail'), /costs 15\.0 points/.test(issues.map((i) => i.what).join(' '))];
  })(), [true, true]);
check('…and a width whose answers mostly change is a warning even when the accuracy holds',
  packIssues({ bits: 4, accuracy_before: 0.9, accuracy_after: 0.9, agreement: 0.7, scored: 120 }).some((i) => i.level === 'warn'), true);
check('…and a width that costs nothing is not, on a model with a margin', [packIssues(report).length, report.agreement], [0, 1]);
check('the 16-bit step is offered too, and lands between the two', (() => {
  const mid = packClassifier(model, { bits: 16, clips }).report;
  return mid.bytes_after > report.bytes_after && mid.bytes_after < report.bytes_before;
})(), true);

console.log('\n5. ⭐ EMBED: the source a user compiles, run against the reader');

/**
 * Emit, compile and run the generated classifier on one clip, and give back what it said.
 *
 * ⚠️ THE CLIP IS FED AS THE FILE'S OWN float32 SAMPLES — decoded, not the Float64Array the fixture generated.
 * Comparing the C against the in-memory array would be comparing two different inputs and would need a tolerance
 * a thousand times looser; comparing them on the same decoded samples makes "the generated C computes the same
 * function as the reader" a claim that can be checked to the last digit.
 */
function buildAndRun(container, dir, wavName) {
  mkdirSync(dir, { recursive: true });
  const emitted = cppSource(container);
  for (const f of emitted.files) writeFileSync(join(dir, f.path), f.content);
  const demo = join(dir, 'demo');
  const cc = process.env.CC || 'cc';
  const compile = spawnSync(cc, ['-O2', '-Wall', '-Wextra', '-o', demo,
    join(dir, 'morpheus_classifier.c'), join(dir, 'morpheus_classifier_main.c'), '-lm'], { encoding: 'utf8' });
  const run = compile.status === 0 ? spawnSync(demo, [wavName], { encoding: 'utf8' }) : null;
  return { emitted, compile, run, demo };
}

const clipPath = join(datasetDir, clips[0].path);
const built = buildAndRun(model, join(work, 'src'), clipPath);
check('the generated source compiles, with no warnings at all',
  [built.compile.status, (built.compile.stderr || '').trim()],
  [0, '']);
check('…and it is C, with a C API a host can call from C or C++',
  [/extern "C"/.test(built.emitted.files[0].content), built.emitted.files.map((f) => f.path).sort()],
  [true, ['README.md', 'morpheus_classifier.c', 'morpheus_classifier.h', 'morpheus_classifier_main.c'].sort()]);
check('⭐ its scores are the READER\'S scores, on the same decoded samples — not merely the right label',
  (() => {
    const w = decodeWav(readFileSync(clipPath));
    const mine = classify(model, w.data[0], w.sampleRate);
    const theirs = (built.run.stdout || '').split('\n').slice(1).map((l) => parseFloat(l.trim().split(/\s+/).pop())).filter((v) => Number.isFinite(v));
    let worst = 0;
    for (let i = 0; i < mine.scores.length; i++) worst = Math.max(worst, Math.abs(mine.scores[i] - theirs[i]));
    return [theirs.length, worst < 1e-6];
  })(), [labels.length, true]);
check('…and the label it prints is the label the reader gives',
  (built.run.stdout || '').split('\n')[0], classify(model, decodeWav(readFileSync(clipPath)).data[0], 48000).label);

// ⚠️ THE WIDTH IN THE SOURCE IS THE WIDTH THAT WAS PACKED. An 8-bit container whose weights were emitted as
// int32_t would be a file that claims a saving nobody gets — the size in the PACK report has to be the size the
// compiler emits, or the whole exercise is a number in a JSON file.
const packedForEmbed = classifierModel({ tower, labels, bits: 8 });
const built8 = buildAndRun(packedForEmbed, join(work, 'src8'), clipPath);
check('an 8-bit container is emitted as 8-bit integers, so the size saving is real',
  [/static const int8_t L0_W\[36\]/.test(built8.emitted.files[1].content), /static const int32_t/.test(built.emitted.files[1].content)],
  [true, true]);
check('…and it still compiles clean and agrees with the reader at that width',
  [built8.compile.status, (() => {
    const w = decodeWav(readFileSync(clipPath));
    const mine = classify(packedForEmbed, w.data[0], w.sampleRate);
    const theirs = (built8.run.stdout || '').split('\n').slice(1).map((l) => parseFloat(l.trim().split(/\s+/).pop())).filter((v) => Number.isFinite(v));
    return theirs.length === mine.scores.length && mine.scores.every((v, i) => Math.abs(v - theirs[i]) < 1e-6);
  })()], [0, true]);
check('the emitter refuses a container that is not one of its family, rather than writing wrong source',
  (() => {
    try { cppSource({ ...model, architecture: 'SomethingElse' }); return 'wrote it anyway'; }
    catch (e) { return /writes AudioClassifier containers/.test(e.message); }
  })(), true);
check('the targets this stage can emit are ones the family actually names',
  EMBED_TARGETS.every((t) => taskFamily('audio.classify').embed.includes(t)), true);
check('…and the README it writes carries the numbers a person needs to trust it',
  [new RegExp(`${labels.length} labels`).test(built.emitted.files[3].content), /32-bit/.test(built.emitted.files[3].content)], [true, true]);

console.log('\n6. the CLI drives the same code');
const modelPath = join(work, 'model.json');
writeFileSync(modelPath, serializeModel(withCard(model, { accuracy: accuracyOf(model) })));
const runCli = (...argv) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'task.mjs'), ...argv], { encoding: 'utf8' });
const cliOk = runCli('verify', modelPath, '--data', datasetDir);
check('verify exits 0 for a container whose claim holds', [cliOk.status, /verified/.test(cliOk.stdout)], [0, true]);
const liarPath = join(work, 'liar.json');
writeFileSync(liarPath, serializeModel(tampered));
const cliNo = runCli('verify', liarPath, '--data', datasetDir);
check('…and exits 1, with the reason, for one whose claim does not — so a script can gate on it',
  [cliNo.status, /do not embed this/.test(cliNo.stdout)], [1, true]);
const packedPath = join(work, 'packed.json');
const cliPack = runCli('pack', modelPath, '--bits', '8', '--data', datasetDir, '--out', packedPath);
check('pack writes a container that parses back, and exits 0 when the width cost nothing',
  [cliPack.status, validateModel(parseModel(readFileSync(packedPath, 'utf8'))).valid], [0, true]);
check('…and the written container is a 8-bit one, not the file that went in',
  [parseModel(readFileSync(packedPath, 'utf8')).layers.every((l) => l.bits === 8), /8-bit/.test(cliPack.stdout)], [true, true]);
const embedDir = join(work, 'cli-embed');
const cliEmbed = runCli('embed', packedPath, '--out', embedDir);
check('embed writes a directory a person can build, and says how',
  [cliEmbed.status, /cc -O2/.test(cliEmbed.stdout), existsSync(join(embedDir, 'morpheus_classifier.c'))], [0, true, true]);
const cliEmbedPython = runCli('embed', packedPath, '--out', join(work, 'nope'), '--language', 'python');
check('…and refuses a language it does not write, naming the ones it does rather than substituting one',
  [cliEmbedPython.status, /not built yet/.test(cliEmbedPython.stderr)], [2, true]);

console.log('\n7. the registry says what can be packed, so the CLI cannot invent a width');
check('the family names its bit widths', taskFamily('audio.classify').quantise.bits, [32, 16, 8]);
check('a family that names no width is refused by the validator, one field at a time',
  validateRegistry([{ id: 'x', label: 'X', question: '?', why: 'because', data: { layout: 'x' }, runtime: { how: 'generated' }, embed: ['cpp'], measure: ['a'], built: ['data'] }])
    .some((p) => /no bit width to pack at/.test(p)), true);
check('…and the shipped family is complete', validateRegistry(TASK_FAMILIES), []);

rmSync(work, { recursive: true, force: true });
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`\n✗ the task ladder is not telling the truth about a model`); process.exit(1); }
console.log('\nOK — a container is verified against its own evidence, and a width is measured.');
