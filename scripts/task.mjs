// task — what Morpheus can build besides an amp, and whether your data can train it.
//
//   node scripts/task.mjs families
//   node scripts/task.mjs check <dataset-dir> [--family audio.classify] [--json]
//
// ── WHY THIS IS A CLI BEFORE THERE IS A MODEL ─────────────────────────────────────────────────────────────
// The five stages are COLLECT → TRAIN → VERIFY → PACK → EMBED, and TRAIN runs on the user's own machine — that
// is a decision, not a gap. Which makes COLLECT the first thing that can be built and finished: it is ours, it
// needs nothing trained, and it is the stage that saves the hours. Everything after it is shipped against data
// that has already been told it is good enough to be worth the electricity.
//
// A dataset is one directory per label with .wav files inside it. That layout is not a preference — it is what
// every training script in the world assumes, and a tool that invents its own would be a tool whose output
// nobody can feed to the trainer they already have.
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { TASK_FAMILIES, taskFamily } from '../server/src/lib/tasks/registry.js';
import { checkDataset, clipFacts, verdictOf } from '../server/src/lib/tasks/dataset.js';
import { decodeWav } from '../server/src/lib/audio/wav.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const WAV = /\.wav$/i;
/** A ceiling on what the pre-flight will decode. A verdict is worth seconds, not minutes. */
const MAX_DECODE_BYTES = 8 * 1024 * 1024;

/**
 * One clip's facts, from the file itself.
 *
 * ⚠️ THE PEAK AND RMS COME FROM THE SAMPLES, NOT FROM THE HEADER. A WAV header holds no peak, and a tool that
 * guessed one from the bit depth would report every 24-bit file as healthy — including the silent ones this
 * pre-flight exists to catch. The decode is skipped for a file too big to be worth it, and SAID TO BE skipped,
 * because a clip the tool did not look at must not be reported as a clip it checked.
 */
function factsFor(path, label) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    return clipFacts({ path, label, unreadable: e.code === 'EACCES' ? 'permission denied' : String(e.message) });
  }
  try {
    const wav = decodeWav(bytes);
    const channels = wav.data || [];
    let peak = 0;
    let sum = 0;
    let n = 0;
    for (const ch of channels) {
      for (let i = 0; i < ch.length; i++) {
        const v = Math.abs(ch[i]);
        if (v > peak) peak = v;
        sum += ch[i] * ch[i];
        n++;
      }
    }
    return clipFacts({
      path,
      label,
      seconds: wav.frames != null ? wav.frames / wav.sampleRate : (channels[0]?.length || 0) / wav.sampleRate,
      sampleRate: wav.sampleRate,
      peak,
      rms: n ? Math.sqrt(sum / n) : 0,
      // ⚠️ THE FINGERPRINT IS WHAT MAKES THE DUPLICATE CHECK EXACT, and it is computed HERE because this is the
      // only place the samples exist. Quantised to 1e-4 first: two renders of the same audio that differ in
      // the last bits are the same recording for this purpose, and a hash over raw floats would call them
      // different. FNV-1a, because it is four lines and this is not a security boundary.
      fingerprint: (() => {
        let h = 0x811c9dc5;
        for (const ch of channels) {
          for (let i = 0; i < ch.length; i++) {
            h ^= (Math.round(ch[i] * 10000) | 0);
            h = Math.imul(h, 0x01000193) >>> 0;
          }
        }
        return `fnv1a-${h.toString(16)}-${n}`;
      })(),
    });
  } catch (e) {
    return clipFacts({ path, label, unreadable: String(e.message || e) });
  }
}

/** Every .wav under a dataset directory, labelled by the directory it is in. */
function collect(root, family) {
  const clips = [];
  const entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (!entries.length) {
    // A flat directory is the mistake everybody makes once. Say so rather than reporting zero labels.
    const flat = readdirSync(root).filter((f) => WAV.test(f));
    if (flat.length) {
      return {
        clips: [],
        problem: `${root} holds ${flat.length} .wav file(s) and no subdirectories. A dataset is ${family.data.layout}`,
      };
    }
    return { clips: [], problem: `${root} holds no subdirectories, so no labels` };
  }
  for (const entry of entries) {
    const dir = join(root, entry.name);
    for (const file of readdirSync(dir)) {
      if (!WAV.test(file)) continue;
      const path = join(dir, file);
      let size = 0;
      try { size = statSync(path).size; } catch { /* reported by the decode below */ }
      clips.push(size > MAX_DECODE_BYTES
        ? clipFacts({ path, label: entry.name, unreadable: `${(size / 1048576).toFixed(1)} MB is over the ${MAX_DECODE_BYTES / 1048576} MB pre-flight limit` })
        : factsFor(path, entry.name));
    }
  }
  return { clips, problem: null };
}

function printFamilies() {
  console.log('\nThe task families Morpheus can build\n');
  for (const f of TASK_FAMILIES) {
    console.log(`  ${f.id}`);
    console.log(`    ${f.label} — "${f.question}"`);
    console.log(`    why:      ${f.why}`);
    console.log(`    data:     ${f.data.layout}, ${f.data.minLabels}+ labels, ${f.data.minClipsPerLabel}+ clips each`);
    console.log(`    runs on:  ${f.runtime.what}`);
    console.log(`    embeds in: ${f.embed.join(', ')}`);
    console.log(`    measured: ${f.measure.join(', ')}`);
    console.log(`    built:    ${f.built.join(', ')}   ·   next: ${f.next.join(', ')}`);
    for (const n of f.notYet) console.log(`    not yet:  ${n}`);
    console.log('');
  }
  console.log('  TRAIN runs on YOUR machine. Morpheus generates the project; it does not train for you.\n');
}

const command = args[0] || 'families';
if (command === 'families') {
  printFamilies();
  process.exit(0);
}

if (command !== 'check') {
  console.error('usage: node scripts/task.mjs families | check <dataset-dir> [--family <id>] [--json]');
  process.exit(2);
}

const root = args[1] && !args[1].startsWith('--') ? resolve(args[1]) : null;
if (!root) {
  console.error('usage: node scripts/task.mjs check <dataset-dir> [--family <id>] [--json]');
  process.exit(2);
}
const familyId = value('--family', 'audio.classify');
const family = taskFamily(familyId);
if (!family) {
  console.error(`no such task family: ${familyId}\n  Known: ${TASK_FAMILIES.map((f) => f.id).join(', ')}`);
  process.exit(2);
}

const { clips, problem } = collect(root, family);
const result = checkDataset(clips, familyId);
const verdict = verdictOf(result);
if (problem) {
  result.issues.unshift({ level: 'fail', what: problem, detail: `Move each kind of sound into its own directory: ${family.data.layout}.` });
  verdict.ok = false;
}

if (flag('--json')) {
  console.log(JSON.stringify({ dataset: root, family: familyId, ...result, ok: verdict.ok }, null, 2));
} else {
  console.log(`\n${basename(root)} — ${result.facts.readable} clip(s), ${Object.keys(result.facts.labels).length} label(s), ${(result.facts.seconds || 0).toFixed(0)}s of audio\n`);
  for (const [label, n] of Object.entries(result.facts.labels).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${label}`);
  }
  console.log('');
  for (const issue of result.issues) {
    console.log(`  ${issue.level === 'fail' ? 'FAIL' : 'warn'}  ${issue.what}`);
    console.log(`        ${issue.detail}`);
    console.log('');
  }
  if (!result.issues.length) console.log('  Nothing to say: this dataset fits the contract.\n');
  console.log(verdict.ok
    ? `  ✓ trainable — ${verdict.warnings.length} thing(s) worth knowing\n`
    : `  ✗ not trainable yet — ${verdict.failures.length} thing(s) to fix first\n`);
}

process.exit(verdict.ok ? 0 : 1);
