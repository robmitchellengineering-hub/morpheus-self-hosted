// COLLECT — whether a pile of labelled clips can train a classifier at all, said BEFORE the GPU time is spent.
//
// ── WHY THIS IS THE FIRST STAGE AND NOT THE LAST ─────────────────────────────────────────────────────────
// Training a small classifier is minutes on a laptop and hours on a bad one. The expensive part is not the
// compute — it is that a dataset which cannot work still trains, and then reports a number that looks like
// success. Every failure below is one somebody has already had:
//
//   * **the leak.** The same recording on both sides of the split. The model has seen the test clip, scores
//     99%, and is worth nothing. Nothing raises, nothing warns, and the number is published.
//   * **the silent clip.** A clip with no signal in it teaches the class that silence belongs to it, and then
//     the model answers that class whenever the room is quiet.
//   * **the clipped capture.** Peak at or over full scale. The distortion is now a feature of that label.
//   * **the starved class.** Four clips of a rare sound. The model cannot learn it and the split cannot even
//     measure it — a class with four clips has one in the test set, or none.
//   * **the lone label.** One class. Every model scores 100% and learns nothing.
//
// ── IT IS A PURE FUNCTION OVER FACTS, AND THAT IS DELIBERATE ─────────────────────────────────────────────
// `checkDataset` takes a list of what was FOUND — path, label, duration, rate, peak, rms — rather than
// reading files. Reading is the CLI's job (`scripts/task.mjs`); deciding is this module's, so the decision can
// be tested without a dataset, and so the same logic can one day run on the server over bytes it was handed,
// exactly as the capture pre-flight does. The capture pre-flight is the model for this whole file: it refuses
// specific things with specific reasons, and the reason names the fix.
import { taskFamily } from './registry.js';

/** dBFS from a linear amplitude, for the messages a person reads. */
const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

/**
 * What the pre-flight needs to know about one clip.
 *
 * `seconds`, `sampleRate`, `peak` and `rms` come from decoding the file. A caller that cannot decode — a
 * partial upload, a corrupt WAV — passes what it has and says so with `unreadable`, because "I could not read
 * this" is a different answer from "this is silent", and confusing the two sends the user to fix the wrong
 * thing.
 */
export function clipFacts({ path, label, seconds = null, sampleRate = null, peak = null, rms = null, unreadable = null, fingerprint = null }) {
  return { path: String(path), label: String(label ?? ''), seconds, sampleRate, peak, rms, unreadable, fingerprint };
}

/**
 * The verdict: `{ facts, issues }`, where an issue is `{ level, what, detail }` and `level` is `fail` or
 * `warn`. Same shape as `checkCapture` — one verdict format in this repository, so a panel that renders one
 * renders the other.
 */
export function checkDataset(clips, familyId = 'audio.classify') {
  const family = taskFamily(familyId);
  if (!family) throw new Error(`no such task family: ${familyId}`);
  if (!Array.isArray(clips)) throw new Error('checkDataset needs a list of clips');

  const c = family.data;
  const issues = [];
  const facts = { family: family.id, clips: clips.length, labels: {}, seconds: null, readable: 0, unreadable: 0 };

  // ── 1. What is actually in the pile ───────────────────────────────────────────────────────────────────
  const byLabel = new Map();
  let totalSeconds = 0;
  const rates = new Set();
  let silent = 0;
  let clipped = 0;
  let quiet = 0;

  for (const clip of clips) {
    if (clip.unreadable) {
      facts.unreadable++;
      issues.push({
        level: 'fail',
        what: `${clip.path} could not be read`,
        detail: `${clip.unreadable} — a file the trainer cannot read is a file the trainer will skip, and a `
          + 'dataset is only as good as the clips that survive the loader.',
      });
      continue;
    }
    facts.readable++;
    const label = clip.label || '(no label)';
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(clip);
    if (Number.isFinite(clip.seconds)) totalSeconds += clip.seconds;
    if (Number.isFinite(clip.sampleRate)) rates.add(clip.sampleRate);
    if (Number.isFinite(clip.peak) && clip.peak <= 1e-6) silent++;
    if (Number.isFinite(clip.peak) && clip.peak >= 0.999) clipped++;
    if (Number.isFinite(clip.rms) && db(clip.rms) < -40) quiet++;
  }

  for (const [label, list] of byLabel) facts.labels[label] = list.length;
  facts.seconds = totalSeconds;
  facts.sampleRates = [...rates].sort((a, b) => a - b);
  facts.balanced = null;

  // ── 2. The things that cannot be fixed by training harder ─────────────────────────────────────────────
  if (byLabel.size < c.minLabels) {
    issues.push({
      level: 'fail',
      what: `there is only ${byLabel.size === 1 ? 'one label' : `${byLabel.size} labels`}, and this family needs at least ${c.minLabels}`,
      detail: 'A classifier with one class scores 100% and has learned nothing. Put each kind of sound in '
        + `its own directory — ${c.layout}.`,
    });
  }
  if (byLabel.size > c.maxLabels) {
    issues.push({
      level: 'warn',
      what: `${byLabel.size} labels is a lot for one small model`,
      detail: `Above ${c.maxLabels} the classes start to overlap and a phone-sized network runs out of `
        + 'capacity before it runs out of data. Fewer, broader labels usually beat more, narrower ones.',
    });
  }
  if (!facts.readable) {
    issues.push({
      level: 'fail',
      what: 'not one clip could be read',
      detail: 'There is nothing to train on. Check the directory layout and the file extensions.',
    });
    return { facts, issues };
  }

  const counts = [...byLabel.values()].map((l) => l.length);
  const smallest = Math.min(...counts);
  const largest = Math.max(...counts);
  for (const [label, list] of byLabel) {
    if (list.length < c.minClipsPerLabel) {
      issues.push({
        level: 'fail',
        what: `"${label}" has ${list.length} clip${list.length === 1 ? '' : 's'} and cannot be learned`,
        detail: `A class needs at least ${c.minClipsPerLabel} to be learnable and to survive being split `
          + `three ways — at ${list.length} the test set holds ${Math.floor(list.length * c.split.test)} of `
          + `them. Around ${c.recommendedClipsPerLabel} is where this starts working.`,
      });
    }
  }
  facts.balanced = largest / Math.max(1, smallest);
  if (facts.balanced > 5) {
    issues.push({
      level: 'warn',
      what: `the classes are unbalanced ${facts.balanced.toFixed(0)}:1`,
      detail: `"${[...byLabel.entries()].sort((a, b) => b[1].length - a[1].length)[0][0]}" has ${largest} and `
        + `"${[...byLabel.entries()].sort((a, b) => a[1].length - b[1].length)[0][0]}" has ${smallest}. The `
        + 'model will lean towards the common class, and overall accuracy will hide it — read the confusion '
        + 'matrix, not the accuracy. Adding clips to the small class is the fix; weighting the loss is a '
        + 'patch over one.',
    });
  }

  // ⭐ THE LEAK, AND WHY THIS IS A CONTENT CHECK RATHER THAN A NAME CHECK.
  //
  // The mistake worth catching is the same recording on both sides of the split, and it is worth catching
  // because it produces a GOOD number: the model is tested on what it memorised, reports 99%, and every check
  // downstream agrees.
  //
  // The first version of this compared FILE NAMES — stripping trailing digits so `kick_01.wav` and
  // `kick_02.wav` looked like one recording. That is wrong twice over: it fires on every dataset that numbers
  // its clips, which is nearly all of them, and it misses the case that actually happens — the same file
  // copied into two label directories with names that share nothing. Names cannot answer this question, so
  // this does not ask them.
  //
  // What it asks instead is content, and the strongest exact form of it: the SAME samples, under two labels.
  // `fingerprint` is a hash of the decoded audio, supplied by whoever read the file. A caller that does not
  // supply one gets no duplicate check rather than a passing one, and `facts.checkedForDuplicates` says which
  // of the two happened.
  const byPrint = new Map();
  let fingerprinted = 0;
  for (const clip of clips) {
    if (clip.unreadable || !clip.fingerprint) continue;
    fingerprinted++;
    const key = clip.fingerprint;
    if (!byPrint.has(key)) byPrint.set(key, []);
    byPrint.get(key).push(clip);
  }
  facts.fingerprinted = fingerprinted;
  facts.checkedForDuplicates = fingerprinted > 1;
  for (const group of byPrint.values()) {
    if (group.length < 2) continue;
    const labels = [...new Set(group.map((g) => g.label))];
    const names = group.map((g) => g.path).slice(0, 3).join(', ');
    if (labels.length > 1) {
      // The hard one: the same audio in two classes. Whatever it is, the model is being asked to tell them
      // apart, and it cannot — one of the two labels is wrong, or the clip is in the wrong place.
      issues.push({
        level: 'fail',
        what: `the same audio is in ${labels.length} different labels: ${names}`,
        detail: `Bit-identical under ${labels.join(', ')}. One of the two is mislabelled, or a file was copied `
          + 'into the wrong directory — and a model trained on this is being asked to separate two things '
          + 'that are the same.',
      });
    } else {
      issues.push({
        level: 'warn',
        what: `${group.length} identical copies of one clip under "${labels[0]}": ${names}`,
        detail: 'Harmless for training, but they will land on both sides of the split and inflate the score. '
          + 'Deduplicate unless they are deliberately repeated takes.',
      });
    }
  }

  // How many recordings the names imply, by the convention the family publishes — reported rather than judged,
  // because a naming convention is a thing the user follows or does not, and guessing from it is what the
  // paragraph above is about. The split that uses it lives in the training project.
  const recordingOf = (path) => String(path).split('/').pop().replace(/\.[^.]*$/, '').split(/[_-]/)[0].toLowerCase();
  const recordings = new Set([...byLabel.entries()].flatMap(([label, list]) => list.map((x) => `${label}/${recordingOf(x.path)}`)));
  facts.recordings = recordings.size;
  facts.recordingRule = c.split.recordingRule;

  // ── 3. The audio itself ───────────────────────────────────────────────────────────────────────────────
  if (silent) {
    issues.push({
      level: 'fail',
      what: `${silent} clip${silent === 1 ? ' is' : 's are'} silent`,
      detail: 'A clip with no signal teaches its class that silence belongs to it, and the model then answers '
        + 'that class whenever the room is quiet. Delete them, or find out why the recording is empty.',
    });
  }
  if (clipped) {
    issues.push({
      level: 'warn',
      what: `${clipped} clip${clipped === 1 ? '' : 's'} reach full scale`,
      detail: 'A clipped capture makes the distortion part of the label. It matters least for a classifier and '
        + 'most for anything that measures loudness — but it is a fact about the data, so it is said here '
        + 'rather than discovered in the confusion matrix.',
    });
  }
  if (quiet) {
    issues.push({
      level: 'warn',
      what: `${quiet} clip${quiet === 1 ? '' : 's'} sit below -40 dBFS`,
      detail: 'Quiet clips are not wrong — level is normalised before the model sees them — but a pile this '
        + 'quiet usually means the gain was set once and the source changed.',
    });
  }
  const tooShort = clips.filter((x) => Number.isFinite(x.seconds) && x.seconds < c.minSeconds).length;
  const tooLong = clips.filter((x) => Number.isFinite(x.seconds) && x.seconds > c.maxSeconds).length;
  if (tooShort) {
    issues.push({
      level: 'fail',
      what: `${tooShort} clip${tooShort === 1 ? ' is' : 's are'} shorter than ${c.minSeconds}s`,
      detail: 'Shorter than this and the clip is mostly the onset — the model learns the attack of every '
        + 'recording rather than the sound in it.',
    });
  }
  if (tooLong) {
    issues.push({
      level: 'warn',
      what: `${tooLong} clip${tooLong === 1 ? ' is' : 's are'} longer than ${c.maxSeconds}s`,
      detail: 'This family classifies a whole clip at once, so a long clip is one label over a lot of '
        + 'different sound. Chop it into windows and label them, which also multiplies your dataset.',
    });
  }
  if (facts.sampleRates.length > 1) {
    issues.push({
      level: 'warn',
      what: `the clips arrive at ${facts.sampleRates.length} different sample rates`,
      detail: `${facts.sampleRates.join(' Hz, ')} Hz. Morpheus resamples to a fixed rate before the model, so `
        + 'this is not an error — but a clip that was recorded at one rate and resampled to another carries '
        + 'the resampler\'s colour, and that is a feature the model can learn instead of the sound.',
    });
  }

  // ── 4. Enough to go round ─────────────────────────────────────────────────────────────────────────────
  const usable = clips.filter((x) => !x.unreadable).length;
  const testCount = Math.floor(usable * c.split.test);
  if (testCount < byLabel.size * 2) {
    issues.push({
      level: 'warn',
      what: `the test split would hold about ${testCount} clips for ${byLabel.size} classes`,
      detail: `At ${Math.round(c.split.test * 100)}% of ${usable}, that is fewer than two per class, so a `
        + `single clip moves the accuracy by ${(100 / Math.max(1, testCount)).toFixed(0)} points. Around `
        + `${c.recommendedClipsTotal} clips in total is where the numbers start meaning something.`,
    });
  }
  if (usable < c.recommendedClipsTotal) {
    issues.push({
      level: 'warn',
      what: `${usable} clips in total`,
      detail: `This family works from about ${c.recommendedClipsTotal}. It is a warning rather than a refusal `
        + 'because a small clean dataset beats a large dirty one — but expect the first model to be weak, and '
        + 'add clips rather than epochs.',
    });
  }

  return { facts, issues };
}

/** Whether the verdict allows training, and what is merely worth knowing. */
export const verdictOf = (result) => ({
  ok: !result.issues.some((i) => i.level === 'fail'),
  failures: result.issues.filter((i) => i.level === 'fail'),
  warnings: result.issues.filter((i) => i.level === 'warn'),
});
