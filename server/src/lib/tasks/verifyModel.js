// VERIFY — the stage that decides whether a container's CLAIM is true, by re-scoring the clips it names.
//
// ── WHY THIS IS NOT "RUN THE TEST SET AGAIN" ─────────────────────────────────────────────────────────────
// `evaluate.py` already measures the model on a held-out split, and its own docstring says accuracy alone is not
// a measurement. So what does a second measurement add? The answer is the thing this whole ladder turns on:
//
//   ⭐ THE TRAINING PROJECT MEASURES THE MODEL IT HAS IN MEMORY. THIS MEASURES THE FILE SOMEBODY WILL EMBED.
//
// Between those two points sit the export, the container's codes and scales, the front end the *runtime*
// computes, and the reader itself — and a mistake in any of them produces a model that is worse than the one
// that was measured, with no error anywhere. The failure is silent and it is the expensive kind: the model
// ships, and the first person to notice is a customer.
//
// So this stage re-computes the accuracy from the container, with the runtime's own front end, over exactly the
// clip list the card names — and REFUSES to let it through when the number it gets is not the number claimed.
// The disagreement IS the signal, and a front end that drifted from training is the most likely cause.
//
// ── THE BASELINE IS NOT A FORMALITY ──────────────────────────────────────────────────────────────────────
// A dataset that is 90% one class scores 90% by answering that class every time. Every number in this report is
// therefore paired with the majority-class baseline over the SAME clips, and a model that does not clear it is
// refused however good its accuracy looks. This is the same mistake `checkDataset` catches in the data and
// `evaluate.py` warns about in the confusion matrix — here it is the difference between shipping and not.
import { modelBytes, validateModel } from '../audio/modelFormat.js';
import { classifierProblems, classify, labelsOf, frontEndOf, frontEndProbe, compareProbe } from './classifierModel.js';

/** How much better than "always answer the commonest label" a model has to be. */
export const DEFAULT_MARGIN = 0.05;

/**
 * The verdict on a container.
 *
 * `clips` is `[{ path, label, samples, sampleRate }]` — already decoded, because the CLI owns the filesystem and
 * this owns the arithmetic. `label` is the label the clip's own directory says it is; a clip whose label is not
 * one this model can output is reported rather than scored, because counting it as wrong would be a different
 * claim than the one being checked.
 */
export function verifyClassifier(model, clips, { margin = DEFAULT_MARGIN, tolerance = 0.02, minClips = 20, claim = null } = {}) {
  const issues = [];
  const facts = { clips: clips.length, labels: [], scored: 0, unscored: 0 };

  // ── structure first: a container that cannot be read cannot be verified either ──────────────────────────
  const format = validateModel(model);
  for (const e of format.errors) issues.push({ level: 'fail', what: 'the container is not readable', detail: e });
  const family = classifierProblems(model);
  for (const p of family) issues.push({ level: 'fail', what: 'the container is not one this runtime can run', detail: p });
  if (issues.length) return { ok: false, facts, issues };

  const labels = labelsOf(model);
  const fe = frontEndOf(model);
  facts.labels = labels;
  facts.front_end = { nMels: fe.nMels, nFft: fe.nFft, hop: fe.hop, sampleRate: fe.sampleRate, clipSeconds: fe.clipSeconds };

  // ── ⭐ the front end, checked against the probe the container carries ────────────────────────────────────
  // This runs BEFORE the clips and it is the check that does not depend on the model being wrong. A drift that
  // costs no accuracy is invisible to every other assertion in this file, and it is the one that ships.
  const probe = model?.io?.front_end?.probe;
  if (!probe) {
    issues.push({
      level: 'warn',
      what: 'the container carries no front-end probe, so a drift that costs no accuracy cannot be seen',
      detail: 'The probe is what catches a runtime whose window, padding, hop or normalisation has moved away '
        + 'from the training project. Without it, this stage can only tell you the model got worse — and a model '
        + 'with a wide margin does not.',
    });
  } else {
    const drift = compareProbe(probe, frontEndProbe(fe));
    facts.probe = { expected: probe, drift };
    if (drift.length) {
      issues.push({
        level: 'fail',
        what: `the runtime's front end no longer matches the one that trained this model (${drift.map((d) => d.field).join(', ')})`,
        detail: drift.map((d) => `${d.field}: the container says ${d.expected}, this runtime computes ${d.actual}`).join('; ')
          + '. The weights are fine — it is the spectrogram underneath them that moved, which is why the accuracy '
          + 'can still look all right while every clip the model sees is subtly wrong.',
      });
    }
  }

  // ── the evidence: which clips is this claim about? ──────────────────────────────────────────────────────
  const declared = claim ?? model?.card?.split?.clips ?? null;
  if (!Array.isArray(declared) || !declared.length) {
    issues.push({
      level: 'fail',
      what: 'the container names no test clips, so there is nothing to check its accuracy against',
      detail: 'export.py writes card.split.clips when it exports. A container without them can only be taken on '
        + 'trust, and a number nobody can reproduce is not evidence.',
    });
  }
  const index = new Map(labels.map((l, i) => [l, i]));
  const unknownLabel = new Set();
  const unreadable = [];
  const confusion = labels.map(() => labels.map(() => 0));
  let correct = 0;
  let latencyMs = 0;

  for (const clip of clips) {
    // ⚠️ A CLIP THAT COULD NOT BE READ IS NOT A CLIP THAT WAS GOT WRONG. Counting it as a miss would quietly
    // lower the accuracy and turn a missing file into "the model got worse"; the failure is named instead.
    if (!clip.samples || clip.error) { unreadable.push(clip); facts.unscored++; continue; }
    if (!index.has(clip.label)) { unknownLabel.add(clip.label); facts.unscored++; continue; }
    const expected = index.get(clip.label);
    const started = process.hrtime.bigint();
    const out = classify(model, clip.samples, clip.sampleRate);
    latencyMs += Number(process.hrtime.bigint() - started) / 1e6;
    confusion[expected][out.index] += 1;
    if (out.index === expected) correct += 1;
    facts.scored++;
  }
  if (unreadable.length) {
    issues.push({
      level: 'fail',
      what: `${unreadable.length} of the clips the card names could not be read under this dataset`,
      detail: `${unreadable.slice(0, 3).map((c) => `${c.path} (${c.error || 'no samples'})`).join('; ')}`
        + `${unreadable.length > 3 ? `, and ${unreadable.length - 3} more` : ''}. The clips the card names have to be `
        + 'findable from the dataset directory, or the claim cannot be reproduced — which is the same as not having one.',
    });
  }
  for (const l of unknownLabel) {
    issues.push({
      level: 'fail',
      what: `a clip is labelled "${l}" and the model has no such output`,
      detail: `The model can answer ${labels.join(', ')}. Either the clip is in the wrong directory or the `
        + 'container is from a different dataset, and in both cases the accuracy below would be about the wrong question.',
    });
  }
  if (!facts.scored) {
    issues.push({ level: 'fail', what: 'not one clip could be scored', detail: 'Nothing here can be verified.' });
    return { ok: false, facts, issues };
  }

  // ── the measurement, and the baseline it has to beat ────────────────────────────────────────────────────
  const accuracy = correct / facts.scored;
  const perClass = {};
  for (let i = 0; i < labels.length; i++) {
    const seen = confusion[i].reduce((a, b) => a + b, 0);
    perClass[labels[i]] = { clips: seen, recall: seen ? confusion[i][i] / seen : null };
  }
  const baseline = Math.max(...Object.values(perClass).map((c) => c.clips)) / facts.scored;
  const bytes = modelBytes(model);
  facts.accuracy = accuracy;
  facts.baseline = baseline;
  facts.margin = accuracy - baseline;
  facts.confusion = confusion;
  facts.per_class = perClass;
  facts.bytes = bytes.total;
  facts.params = bytes.params;
  facts.latency_ms_per_clip = latencyMs / facts.scored;

  // ⚠️ THE BASELINE CHECK IS A REFUSAL, NOT A WARNING. "It scores 90%" is not a result when 90% of the clips
  // are one label — and the whole reason this ladder exists is that a number like that gets embedded.
  if (facts.margin < margin) {
    issues.push({
      level: 'fail',
      what: `the model does not beat answering "${dominant(perClass)}" every time`,
      detail: `${(accuracy * 100).toFixed(1)}% on ${facts.scored} clips against a baseline of `
        + `${(baseline * 100).toFixed(1)}% — a margin of ${(facts.margin * 100).toFixed(1)} points, and this task `
        + `asks for ${(margin * 100).toFixed(0)}. Either the data cannot separate these labels or the model has not learned to.`,
    });
  }

  // ── ⭐ the claim, checked against the container rather than believed ─────────────────────────────────────
  const claimed = model?.card?.metrics?.accuracy;
  if (typeof claimed === 'number') {
    facts.claimed_accuracy = claimed;
    const claimedClips = model?.card?.metrics?.clips;
    const sameSet = !declared || !claimedClips || claimedClips === facts.scored;
    if (!sameSet) {
      issues.push({
        level: 'warn',
        what: `the card's number is about ${claimedClips} clips and these ${facts.scored} are not the same set`,
        detail: 'The comparison below is still made, but the two numbers are not measuring the same thing.',
      });
    }
    if (accuracy < claimed - tolerance) {
      issues.push({
        level: 'fail',
        what: `the card claims ${(claimed * 100).toFixed(1)}% and this container scores ${(accuracy * 100).toFixed(1)}%`,
        detail: 'The file does not do what the file says. The most likely cause is the front end — a different '
          + 'window, padding or normalisation than the training project used — and the second is the container '
          + 'itself. Embedding this would ship the difference to a customer, silently.',
      });
    }
  } else {
    issues.push({
      level: 'warn',
      what: 'the container carries no accuracy to check, so only the baseline was verified',
      detail: 'export.py copies the number from metrics.json when it exists. Without it, nothing here can say '
        + 'whether the file matches what trained — only that it beats a coin toss weighted by the data.',
    });
  }

  if (facts.scored < minClips) {
    issues.push({
      level: 'warn',
      what: `only ${facts.scored} clips were checked`,
      detail: `Under ${minClips} the accuracy is a coin toss with error bars wider than the effect. This is a `
        + 'sanity check, not a measurement.',
    });
  }

  return { ok: !issues.some((i) => i.level === 'fail'), facts, issues };
}

const dominant = (perClass) => Object.entries(perClass).sort((a, b) => b[1].clips - a[1].clips)[0][0];

/** The report as lines a human reads, in the order that matters: the verdict, the number, the baseline. */
export function formatVerification(result) {
  const f = result.facts;
  const lines = [];
  if (!f.accuracy) {
    lines.push('there is nothing to report: the container could not be verified');
  } else {
    lines.push(`${(f.accuracy * 100).toFixed(1)}% on ${f.scored} clips  ·  baseline ${(f.baseline * 100).toFixed(1)}%`
      + `  ·  margin ${(f.margin * 100).toFixed(1)} points`);
    if (f.claimed_accuracy != null) lines.push(`the card claims ${(f.claimed_accuracy * 100).toFixed(1)}%`);
    lines.push(`${f.params} weights · ${f.bytes} bytes · ${f.latency_ms_per_clip.toFixed(1)} ms per clip`);
    lines.push('');
    const width = Math.max(...f.labels.map((l) => l.length));
    lines.push(' ' + ' '.repeat(width + 2) + f.labels.map((l) => l.slice(0, 7).padStart(7)).join('  '));
    for (let i = 0; i < f.labels.length; i++) {
      lines.push(`${f.labels[i].padStart(width)}  ` + f.confusion[i].map((n) => String(n).padStart(7)).join('  '));
    }
    lines.push('');
    for (const [label, row] of Object.entries(f.per_class)) {
      const recall = row.recall == null ? 'n/a' : `${(row.recall * 100).toFixed(0)}%`;
      lines.push(`  ${label}: ${row.clips} clips, ${recall} of them right`);
    }
  }
  for (const issue of result.issues) {
    lines.push(`  ${issue.level === 'fail' ? '✗' : '!'} ${issue.what}`);
    if (issue.detail) lines.push(`      ${issue.detail}`);
  }
  return lines.join('\n');
}
