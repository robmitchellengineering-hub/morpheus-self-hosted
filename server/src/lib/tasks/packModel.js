// PACK — the stage that trades bytes for accuracy, and MEASURES the trade instead of assuming it.
//
// ── WHY THIS IS OURS AND NOT THE TRAINING PROJECT'S ──────────────────────────────────────────────────────
// `export.py` writes 32-bit codes and stops. Quantising is a decision with alternatives, and a decision with
// alternatives belongs where the alternatives can be compared: at 8 bits this model is a quarter of the size,
// and the question "what did that cost?" is answerable only by running BOTH and counting. A script whose author
// cannot see the other arm cannot take that measurement, which is why it is a stage and not a flag.
//
// ── ⭐ THE MEASUREMENT IS AN A/B ON THE SAME READER ───────────────────────────────────────────────────────
// The packed container goes through the same `classify()` as the 32-bit one — same file, same front end, same
// arithmetic, and the weights read from the container's own codes and scales rather than from a float copy. That
// last part is the whole point: a forward pass that dequantized once into a cache and never looked again would
// report that packing is free.
//
// ⚠️ AND THE NUMBER THAT MATTERS IS AGREEMENT ON THE CLIPS THE CARD NAMES, not SQNR. A model can lose 20 dB of
// signal-to-quantisation-noise and classify identically, and it can lose 3 dB and flip the one clip that
// mattered. SQNR is reported because it is the honest engineering figure, and the agreement and the accuracy
// delta are reported because they are the ones a person can act on.
import { sqnrDb } from '../audio/dsp.js';
import { modelBytes } from '../audio/modelFormat.js';
import { classifierModel } from './classifierContainer.js';
import { classify, labelsOf, readTower, frontEndOf } from './classifierModel.js';
import { taskFamily } from './registry.js';

/** The widths a family offers, from the registry — so the CLI cannot invent a width nobody measured. */
export const packableBits = (familyId = 'audio.classify') => taskFamily(familyId)?.quantise?.bits ?? [8];

/**
 * Pack a classifier to a lower bit width, and measure what it cost.
 *
 * Returns the packed container and a report. The report is the deliverable: `{bits, bytes, params, sqnrDb,
 * agreement, accuracy, baseline, latencyMsPerClip, per_layer}`.
 */
export function packClassifier(model, { bits, clips = [], frontEnd = null, keepCard = true } = {}) {
  const allowed = packableBits(model?.family || 'audio.classify');
  if (!allowed.includes(bits)) {
    throw new Error(`this family can be packed at ${allowed.join('/')} bits, and ${bits} is not one of them`);
  }
  const labels = labelsOf(model);
  const fe = frontEnd ?? frontEndOf(model);
  const tower = readTower(model);

  // The packed container is built by the SAME constructor export.py uses, from the same tower — so packing is a
  // change of one number, and a packed model is not a different kind of file.
  const packed = classifierModel({
    tower,
    labels,
    frontEnd: fe,
    bits,
    accumulatorBits: model.accumulator_bits ?? 32,
    sampleRate: model.sample_rate,
    source: { ...(model.source || {}), packed_from: model.source?.tool || 'unknown', packed_bits: bits },
    card: keepCard ? { ...(model.card || {}) } : null,
  });

  // ── the measurement ─────────────────────────────────────────────────────────────────────────────────────
  const before = modelBytes(model);
  const after = modelBytes(packed);
  const report = {
    bits,
    bytes_before: before.total,
    bytes_after: after.total,
    params: after.params,
    ratio: before.total ? after.total / before.total : null,
    sqnr_db: null,
    per_layer: [],
    clips: clips.length,
    agreement: null,
    accuracy_before: null,
    accuracy_after: null,
  };

  // SQNR over every weight, and per layer, because one bad layer is what a single number hides.
  const allOriginal = [];
  const allPacked = [];
  const packedTower = readTower(packed);
  for (let i = 0; i < tower.length; i++) {
    const a = tower[i].weight;
    const b = packedTower[i].weight;
    allOriginal.push(...a);
    allPacked.push(...b);
    report.per_layer.push({ name: tower[i].name, weights: a.length, sqnr_db: finite(sqnrDb(a, b)) });
  }
  report.sqnr_db = finite(sqnrDb(allOriginal, allPacked));

  if (clips.length) {
    let agree = 0;
    let rightBefore = 0;
    let rightAfter = 0;
    let scored = 0;
    for (const clip of clips) {
      let a;
      let b;
      try {
        a = classify(model, clip.samples, clip.sampleRate);
        b = classify(packed, clip.samples, clip.sampleRate);
      } catch {
        continue; // an unreadable clip is reported by VERIFY; here it must not be silently counted as agreement
      }
      scored++;
      if (a.index === b.index) agree++;
      if (a.label === clip.label) rightBefore++;
      if (b.label === clip.label) rightAfter++;
    }
    if (scored) {
      report.agreement = agree / scored;
      report.accuracy_before = rightBefore / scored;
      report.accuracy_after = rightAfter / scored;
      report.scored = scored;
    }
  }

  // The card follows the artefact: a packed model whose card still quotes the float model's accuracy is a lie
  // that reads as diligence.
  if (packed.card) {
    packed.card.quantization = {
      bits,
      sqnr_db: report.sqnr_db,
      bytes_before: before.total,
      bytes_after: after.total,
      agreement: report.agreement,
      accuracy_before: report.accuracy_before,
      accuracy_after: report.accuracy_after,
      note: 'measured by PACK against the clips the card names, on the same reader that will run the model',
    };
    if (report.accuracy_after != null) packed.card.metrics = { ...(packed.card.metrics || {}), accuracy: report.accuracy_after };
  }
  return { model: packed, report };
}

/** What is wrong with a pack, judged against the drop the caller is willing to accept. */
export function packIssues(report, { maxAccuracyDrop = 0.01, minAgreement = 0.9 } = {}) {
  const issues = [];
  if (report.accuracy_before != null && report.accuracy_after != null) {
    const drop = report.accuracy_before - report.accuracy_after;
    if (drop > maxAccuracyDrop) {
      issues.push({
        level: 'fail',
        what: `${report.bits}-bit costs ${(drop * 100).toFixed(1)} points of accuracy`,
        detail: `${(report.accuracy_before * 100).toFixed(1)}% at 32 bits, ${(report.accuracy_after * 100).toFixed(1)}% at `
          + `${report.bits}. The size saving is real and so is the loss; take the wider width, or train a model that `
          + 'survives it.',
      });
    }
    if (report.agreement != null && report.agreement < minAgreement) {
      issues.push({
        level: 'warn',
        what: `the ${report.bits}-bit model answers differently on ${((1 - report.agreement) * 100).toFixed(0)}% of the clips`,
        detail: 'Agreement is what a customer experiences as "it used to work". A wide gap at a small accuracy '
          + 'drop usually means two labels the model was never confident about.',
      });
    }
  } else {
    issues.push({
      level: 'warn',
      what: 'nothing was measured, because no clips were given',
      detail: 'A pack with no measurement is a size, not a decision.',
    });
  }
  return issues;
}

/** The report as lines a human reads. */
export function formatPack(report) {
  const lines = [];
  lines.push(`${report.bits}-bit: ${report.bytes_after} bytes for ${report.params} weights `
    + `(${report.bytes_before} at 32-bit, ${report.ratio != null ? `${(report.ratio * 100).toFixed(0)}%` : 'n/a'})`);
  lines.push(`quantisation noise: ${report.sqnr_db == null ? 'exact' : `${report.sqnr_db.toFixed(1)} dB`}`);
  if (report.accuracy_before != null) {
    const drop = (report.accuracy_before - report.accuracy_after) * 100;
    lines.push(`accuracy ${(report.accuracy_before * 100).toFixed(1)}% → ${(report.accuracy_after * 100).toFixed(1)}% `
      + `(${drop >= 0 ? '-' : '+'}${Math.abs(drop).toFixed(1)} points) · agreement ${(report.agreement * 100).toFixed(1)}% `
      + `over ${report.scored} clips`);
  }
  for (const layer of report.per_layer) {
    lines.push(`  ${layer.name}: ${layer.weights} weights, ${layer.sqnr_db == null ? 'exact' : `${layer.sqnr_db.toFixed(1)} dB`}`);
  }
  return lines.join('\n');
}

const finite = (x) => (Number.isFinite(x) ? Number(x.toFixed(3)) : null);
