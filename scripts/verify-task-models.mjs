// Is the task registry a registry, and does the pre-flight refuse the right things for the right reasons?
//
// ── WHY THIS GUARD EXISTS AT ALL, WHEN NOTHING IS TRAINED YET ─────────────────────────────────────────────
// The first stage of the five is COLLECT, and the whole value of it is the VERDICT: a pre-flight that says
// "this will not train" is only worth having if it is right, and a pre-flight that is wrong in the permissive
// direction is worse than none — it spends the user's electricity and hands back a number that looks like
// success. The failure this file is built around is not a crash. It is a classifier that reports 99% because
// the same recording is on both sides of the split, and every check downstream agreeing with it.
//
// So each refusal below is asserted together with the reason it gives, and the ones that are warnings are
// asserted to be warnings — a check that refuses everything is as useless as one that refuses nothing.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TASK_FAMILIES, taskFamily, taskFamilyIds, validateRegistry } from '../server/src/lib/tasks/registry.js';
import { checkDataset, clipFacts, verdictOf } from '../server/src/lib/tasks/dataset.js';
import { encodeWav } from '../server/src/lib/audio/wav.js';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}
const reasonOf = (result, level = 'fail') => (result.issues.find((i) => i.level === level)?.what || '');

// ── synthetic clips, because a pre-flight about data has to be judged on data ───────────────────────────────
const SR = 48000;
/** A clip with something in it: a tone, at an amplitude. */
const tone = (seconds, { hz = 440, amplitude = 0.4 } = {}) => {
  const n = Math.round(seconds * SR);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / SR);
  return x;
};
const silent = (seconds) => new Float64Array(Math.round(seconds * SR));
const clip = (label, name, seconds = 1, opts = {}) => ({
  label, path: `${label}/${name}`, ...opts, seconds, sampleRate: SR,
  peak: opts.peak ?? 0.4, rms: opts.rms ?? 0.28,
  // Distinct by default: the duplicate check is exact, so a fixture that gave every clip the same
  // fingerprint would be testing that check by accident in every other case.
  fingerprint: opts.fingerprint === undefined ? `fnv1a-${label}-${name}` : opts.fingerprint,
});

console.log('\n1. the registry is data a builder can actually use');
check('every family is complete enough to build', validateRegistry(), []);
// ⚠️ ONE FIELD AT A TIME. The first version of this passed a fixture that was missing EVERYTHING, so it stayed
// green with any single requirement deleted — a mutation proved it, and the check now requires each field
// individually. A validator is only worth having if it says no to each thing it claims to require.
const complete = { id: 'x', label: 'X', question: '?', why: 'because', data: { layout: 'x' }, runtime: { how: 'generated' }, embed: ['cpp'], measure: ['accuracy'], built: ['data'], next: [], notYet: [] };
check('…a complete entry passes the validator', validateRegistry([complete]), []);
for (const field of ['label', 'question', 'why', 'data', 'runtime', 'embed', 'measure', 'built']) {
  const broken = { ...complete, [field]: ['embed', 'measure', 'built'].includes(field) ? [] : undefined };
  check(`…and it requires "${field}" rather than merely mentioning it`, validateRegistry([broken]).length > 0, true);
}
check('…as it does a duplicate id', validateRegistry([complete, { ...complete }]).length > 0, true);
check('the first family is the one this work is built against', taskFamilyIds()[0], 'audio.classify');
check('…and an unknown id is null rather than a guess', taskFamily('audio.magic'), null);
check('a family names what it does NOT do, so the limits are published rather than discovered',
  TASK_FAMILIES.every((f) => Array.isArray(f.notYet) && f.notYet.length > 0), true);
check('a family says which stages exist, so a registry entry cannot claim to be finished',
  TASK_FAMILIES.every((f) => Array.isArray(f.built) && f.built.length > 0 && Array.isArray(f.next)), true);

console.log('\n2. a dataset that is good enough is accepted, without noise');
const good = [];
for (const label of ['clean', 'distorted']) {
  for (let i = 0; i < 60; i++) good.push(clip(label, `take_${label === 'clean' ? 'a' : 'b'}${i}.wav`, 1 + (i % 5) * 0.1));
}
const goodResult = checkDataset(good);
check('a clean, balanced, well-sized dataset has nothing to say', goodResult.issues.length, 0);
check('…and the verdict is trainable', verdictOf(goodResult).ok, true);
check('…with the facts a person would want to see', [goodResult.facts.clips, goodResult.facts.readable, Object.keys(goodResult.facts.labels).length], [120, 120, 2]);
check('…and it says whether the duplicate check could run at all',
  goodResult.facts.checkedForDuplicates, true);

console.log('\n3. ⭐ the leak: the mistake that produces a GOOD number, caught by CONTENT');
// The same audio under two labels. Every individual clip is fine, the counts are fine, the audio is real — and
// the model is being asked to separate two things that are the same. The first version of this check compared
// NAMES (stripping trailing digits), which fires on every numbered dataset and misses this entirely.
const leaked = [
  clip('kick', 'a1.wav', 1, { fingerprint: 'fnv1a-same' }),
  clip('snare', 'b1.wav', 1, { fingerprint: 'fnv1a-same' }),
  ...Array.from({ length: 25 }, (_, i) => clip('kick', `a${i + 2}.wav`)),
  ...Array.from({ length: 25 }, (_, i) => clip('snare', `b${i + 2}.wav`)),
];
const leakResult = checkDataset(leaked);
check('⭐ the same audio under two labels is a refusal',
  [verdictOf(leakResult).ok, /same audio is in 2 different labels/.test(reasonOf(leakResult))], [false, true]);
check('…and the reason names the files and says what it means',
  [/a1.wav/.test(JSON.stringify(leakResult)), /mislabelled|wrong directory/.test(JSON.stringify(leakResult))], [true, true]);

const repeated = checkDataset([...good, clip('clean', 'copy.wav', 1, { fingerprint: good[0].fingerprint })]);
check('two identical copies under ONE label is a warning, not a refusal — repeats are legitimate',
  [verdictOf(repeated).ok, repeated.issues.some((i) => i.level === 'warn' && /identical copies/.test(i.what))], [true, true]);
check('…and a caller who cannot fingerprint is told the check did not run rather than that it passed',
  checkDataset([
    clipFacts({ path: 'a/1.wav', label: 'a', seconds: 1, sampleRate: SR, peak: 0.4, rms: 0.3 }),
    clipFacts({ path: 'b/2.wav', label: 'b', seconds: 1, sampleRate: SR, peak: 0.4, rms: 0.3 }),
  ]).facts.checkedForDuplicates, false);

console.log('\n4. the things that cannot be trained on, each refused for its own reason');
const oneLabel = checkDataset(Array.from({ length: 30 }, (_, i) => clip('only', `a${i}.wav`)));
check('one label is a refusal, and the reason says why it is not a small problem',
  [verdictOf(oneLabel).ok, /only one label/.test(reasonOf(oneLabel)), /learned nothing/.test(JSON.stringify(oneLabel))], [false, true, true]);

const starved = checkDataset([
  ...Array.from({ length: 30 }, (_, i) => clip('common', `a${i}.wav`)),
  ...Array.from({ length: 3 }, (_, i) => clip('rare', `b${i}.wav`)),
]);
check('a class with three clips is refused, and the reason does the arithmetic out loud',
  [verdictOf(starved).ok, /has 3 clips/.test(reasonOf(starved)), /test set holds/.test(JSON.stringify(starved))], [false, true, true]);
check('…and the imbalance is ALSO reported, because the two are different problems',
  starved.issues.some((i) => i.level === 'warn' && /unbalanced/.test(i.what)), true);

const withSilence = checkDataset([...good, clip('clean', 'quiet.wav', 1, { peak: 0, rms: 0 })]);
check('a silent clip is a refusal rather than a curiosity',
  [verdictOf(withSilence).ok, /silent/.test(reasonOf(withSilence))], [false, true]);

const unreadable = checkDataset([...good, clipFacts({ path: 'clean/broken.wav', label: 'clean', unreadable: 'not a RIFF file' })]);
check('a clip that could not be read is refused, and said to be unreadable rather than silent',
  [verdictOf(unreadable).ok, /could not be read/.test(reasonOf(unreadable)), /not a RIFF file/.test(JSON.stringify(unreadable))], [false, true, true]);

const tooShort = checkDataset([...good, clip('clean', 'blip.wav', 0.05)]);
check('a clip shorter than the family allows is refused, because it is mostly its own onset',
  [verdictOf(tooShort).ok, /shorter than/.test(reasonOf(tooShort))], [false, true]);

const loud = checkDataset([...good, clip('clean', 'hot.wav', 1, { peak: 1.0, rms: 0.7 })]);
check('a clip at full scale is a warning, not a refusal — it is a fact, not a fault',
  [/reach full scale/.test(JSON.stringify(loud)), verdictOf(loud).ok], [true, true]);

console.log('\n5. the CLI, on a real directory, because the pure function is only half of it');
const work = mkdtempSync(join(tmpdir(), 'morpheus-task-'));
const write = (label, name, samples) => {
  const dir = join(work, 'dataset', label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), encodeWav({ sampleRate: SR, data: samples, format: 'float32' }));
};
for (let i = 0; i < 30; i++) {
  write('clean', `takeA${i}.wav`, tone(1 + (i % 4) * 0.1, { hz: 220, amplitude: 0.4 }));
  write('distorted', `takeB${i}.wav`, tone(1 + (i % 4) * 0.1, { hz: 440, amplitude: 0.6 }));
}
const run = (dir) => spawnSync(process.execPath, [join(new URL('..', import.meta.url).pathname, 'scripts', 'task.mjs'), 'check', dir, '--json'], { encoding: 'utf8' });
const okRun = run(join(work, 'dataset'));
const okJson = (() => { try { return JSON.parse(okRun.stdout); } catch { return null; } })();
check('the CLI reads a real dataset directory and reports its shape',
  [okRun.status, okJson?.facts?.readable, Object.keys(okJson?.facts?.labels || {}).sort().join(',')], [0, 60, 'clean,distorted']);
check('…and says the verdict out loud', okJson?.ok, true);

// The flat-directory mistake, which everybody makes once: the clips are there and no label directories are.
mkdirSync(join(work, 'flat'), { recursive: true });
writeFileSync(join(work, 'flat', 'a.wav'), encodeWav({ sampleRate: SR, data: tone(1), format: 'float32' }));
const flatRun = run(join(work, 'flat'));
const flatJson = (() => { try { return JSON.parse(flatRun.stdout); } catch { return null; } })();
check('a flat directory of wavs is refused, and told what the layout should be',
  [flatRun.status, /no subdirectories|holds 1 .wav file/.test(JSON.stringify(flatJson)), /its own directory/.test(JSON.stringify(flatJson))],
  [1, true, true]);
check('…with a non-zero exit, so a script can act on it', flatRun.status === 1, true);

// One silent clip in an otherwise good dataset, through the real reader — the decode path, not the fixture.
write('clean', 'silence.wav', silent(1));
const silentRun = run(join(work, 'dataset'));
const silentJson = (() => { try { return JSON.parse(silentRun.stdout); } catch { return null; } })();
check('the CLI decodes the samples, so it can see a silent file rather than trusting a header',
  [silentRun.status, /silent/.test(JSON.stringify(silentJson?.issues))], [1, true]);

rmSync(work, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ the task pre-flight is not telling the truth about datasets\n');
  process.exit(1);
}
console.log('a dataset is judged before it costs anybody a GPU hour\n');
