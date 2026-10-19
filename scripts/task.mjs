// task — what Morpheus can build besides an amp, and whether your data can train it.
//
//   node scripts/task.mjs families
//   node scripts/task.mjs check <dataset-dir> [--family audio.classify] [--json]
//   node scripts/task.mjs scaffold --out <dir> [--dataset <dir>] [--family audio.classify]
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
import { basename, dirname, join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { TASK_FAMILIES, taskFamily } from '../server/src/lib/tasks/registry.js';
import { checkDataset, clipFacts, verdictOf } from '../server/src/lib/tasks/dataset.js';
import { PROJECT_FILES, trainingProject, validateProject } from '../server/src/lib/tasks/trainProject.js';
import { decodeWav } from '../server/src/lib/audio/wav.js';
import { describeClassifier, monoFromWav } from '../server/src/lib/tasks/classifierModel.js';
import { verifyClassifier, formatVerification } from '../server/src/lib/tasks/verifyModel.js';
import { packClassifier, packIssues, formatPack } from '../server/src/lib/tasks/packModel.js';
import { cppSource, EMBED_TARGETS } from '../server/src/lib/tasks/embedClassifier.js';
import { serializeModel } from '../server/src/lib/audio/modelFormat.js';

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

/**
 * The clips a container's card names, decoded, ready to be scored.
 *
 * ⚠️ THE LABEL COMES FROM THE DIRECTORY, NOT FROM THE CARD. The card says which clips were held out; the
 * dataset says what they are. Taking both from the same file would make the check circular — a model whose
 * labels had been shuffled would agree with itself perfectly.
 *
 * A clip that cannot be found or decoded comes back with `error` set rather than being dropped, so the report can
 * say "three of the clips you named are missing" instead of scoring the rest and reporting a clean number.
 */
function clipsForVerification(model, root) {
  const declared = model?.card?.split?.clips;
  const missing = [];
  if (!Array.isArray(declared)) return { clips: [], missing };
  const clips = declared.map((rel) => {
    const label = basename(dirname(rel));
    const path = join(root, rel);
    try {
      const { sampleRate, samples } = monoFromWav(readFileSync(path));
      return { path: rel, label, samples, sampleRate };
    } catch (e) {
      missing.push(rel);
      return { path: rel, label, samples: null, error: e.code === 'ENOENT' ? 'not found' : String(e.message) };
    }
  });
  return { clips, missing };
}

function printFamilies() {  console.log('\nThe task families Morpheus can build\n');
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

// ── scaffold: write the training project, WITH the dataset's verdict inside it ────────────────────────────
// ⚠️ THE VERDICT IS PART OF THE PROJECT, AND THE TRAINER REFUSES TO RUN WITHOUT IT. That is what makes the
// pre-flight a gate rather than advice: `train.py` opens preflight.json first and stops if it is missing or
// says no. Generating the project without checking the dataset writes a project that will not start — which is
// the correct outcome, and better than one that trains on anything.
if (command === 'scaffold') {
  const out = value('--out');
  const familyId = value('--family', 'audio.classify');
  if (!out) {
    console.error('usage: node scripts/task.mjs scaffold --out <dir> [--dataset <dir>] [--family <id>]');
    process.exit(2);
  }
  const family = taskFamily(familyId);
  if (!family) {
    console.error(`no such task family: ${familyId}\n  Known: ${TASK_FAMILIES.map((f) => f.id).join(', ')}`);
    process.exit(2);
  }
  const datasetDir = value('--dataset');
  let verdict = null;
  if (datasetDir) {
    const collected = collect(resolve(datasetDir), family);
    const result = checkDataset(collected.clips, familyId);
    if (collected.problem) {
      result.issues.unshift({ level: 'fail', what: collected.problem, detail: `Move each kind of sound into its own directory: ${family.data.layout}.` });
    }
    verdict = { ...result, ok: verdictOf(result).ok, dataset: resolve(datasetDir) };
  }
  const project = trainingProject(familyId, verdict);
  const problems = validateProject(project);
  if (problems.length) {
    console.error(`the generated project is incomplete, so it was not written:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  mkdirSync(out, { recursive: true });
  for (const file of project.files) writeFileSync(join(out, file.path), file.content);
  console.log(`\nwrote ${project.files.length} files to ${out}\n`);
  for (const path of PROJECT_FILES) console.log(`  ${path}`);
  console.log('');
  if (!verdict) {
    console.log('  ⚠️ no --dataset was given, so preflight.json holds a refusal and train.py will not start.');
    console.log('     Run: node scripts/task.mjs scaffold --out <dir> --dataset <your-clips>\n');
  } else if (!verdict.ok) {
    console.log('  ✗ the dataset did not pass, so train.py will refuse to start. The reasons are in preflight.json:\n');
    for (const issue of verdict.issues.filter((i) => i.level === 'fail')) console.log(`     ${issue.what}`);
    console.log('');
  } else {
    console.log('  ✓ the dataset passed — next, in that directory:\n');
    console.log('     python -m venv .venv && . .venv/bin/activate');
    console.log('     pip install -r requirements.txt');
    console.log('     python train.py --dataset ' + resolve(datasetDir) + ' --dry-run\n');
  }
  process.exit(verdict && !verdict.ok ? 1 : 0);
}

// ── verify: re-score the clips a container names, and check its claim against the container ───────────────
// ⚠️ THE POINT IS NOT "RUN THE TEST SET AGAIN". `evaluate.py` measured the model in MEMORY; this measures the
// FILE — through the runtime's own front end, reading the container's own codes and scales. A drift between the
// two is the failure that ships silently, and this is the only stage that can see it.
if (command === 'verify') {
  const modelPath = args[1] && !args[1].startsWith('--') ? resolve(args[1]) : null;
  if (!modelPath) {
    console.error('usage: node scripts/task.mjs verify <model.json> --data <dataset-dir> [--json]');
    process.exit(2);
  }
  const root = value('--data') ? resolve(value('--data')) : null;
  if (!root) {
    console.error('the clips the card names are relative to a dataset directory — pass --data <dataset-dir>');
    process.exit(2);
  }
  let model;
  try {
    model = JSON.parse(readFileSync(modelPath, 'utf8'));
  } catch (e) {
    console.error(`${modelPath} is not readable as JSON: ${e.message}`);
    process.exit(2);
  }
  const { clips, missing } = clipsForVerification(model, root);
  const result = verifyClassifier(model, clips);
  if (flag('--json')) {
    console.log(JSON.stringify({ model: modelPath, dataset: root, ...result }, null, 2));
  } else {
    console.log(`\n${basename(modelPath)} — ${describeClassifier(model)}\n`);
    console.log(formatVerification(result));
    if (missing.length) console.log(`\n  (${missing.length} clip(s) named by the card were not found on disk)`);
    console.log('');
    console.log(result.ok
      ? '  ✓ verified — the container does what its card says, on the clips the card names\n'
      : '  ✗ not verified — do not embed this until the reasons above are answered\n');
  }
  process.exit(result.ok ? 0 : 1);
}

// ── pack: trade bytes for accuracy, and measure the trade ─────────────────────────────────────────────────
if (command === 'pack') {
  const modelPath = args[1] && !args[1].startsWith('--') ? resolve(args[1]) : null;
  if (!modelPath) {
    console.error('usage: node scripts/task.mjs pack <model.json> [--bits 8] [--data <dataset-dir>] [--out packed.json]');
    process.exit(2);
  }
  const model = JSON.parse(readFileSync(modelPath, 'utf8'));
  const bits = Number(value('--bits', '8'));
  const root = value('--data') ? resolve(value('--data')) : null;
  // The clips are the same evidence VERIFY used — the ones the card names — so the A/B is over the set whose
  // accuracy the card is about, rather than a fresh sample that would flatter whichever arm ran first.
  const clips = root ? clipsForVerification(model, root).clips.filter((c) => c.samples) : [];
  let packed;
  let report;
  try {
    ({ model: packed, report } = packClassifier(model, { bits, clips }));
  } catch (e) {
    console.error(`${e.message}`);
    process.exit(2);
  }
  const issues = packIssues(report);
  const out = value('--out', null);
  if (out) writeFileSync(out, serializeModel(packed));
  if (flag('--json')) {
    console.log(JSON.stringify({ model: modelPath, out, report, issues }, null, 2));
  } else {
    console.log(`\n${basename(modelPath)} → ${bits}-bit\n`);
    console.log(formatPack(report));
    console.log('');
    for (const issue of issues) console.log(`  ${issue.level === 'fail' ? '✗' : '!'} ${issue.what}\n      ${issue.detail}`);
    if (!issues.length) console.log('  ✓ nothing to say: the accuracy survived the width\n');
    if (out) console.log(`  wrote ${out}`);
    console.log('');
  }
  process.exit(issues.some((i) => i.level === 'fail') ? 1 : 0);
}

// ── embed: write source the user owns, with no runtime of ours in it ──────────────────────────────────────
if (command === 'embed') {
  const modelPath = args[1] && !args[1].startsWith('--') ? resolve(args[1]) : null;
  const out = value('--out');
  const language = value('--language', 'cpp');
  const name = value('--name', 'morpheus_classifier');
  if (!modelPath || !out) {
    console.error('usage: node scripts/task.mjs embed <model.json> --out <dir> [--language cpp] [--name morpheus_classifier]');
    process.exit(2);
  }
  if (!EMBED_TARGETS.includes(language)) {
    // ⚠️ A TARGET THAT DOES NOT EXIST IS NAMED RATHER THAN SILENTLY SUBSTITUTED. The family lists python among the
    // places a model can go; this stage can only write C today, and saying so is the difference between a gap and
    // a surprise.
    console.error(`this stage writes ${EMBED_TARGETS.join(', ')} — "${language}" is not built yet`);
    process.exit(2);
  }
  const model = JSON.parse(readFileSync(modelPath, 'utf8'));
  let source;
  try {
    source = cppSource(model, { name });
  } catch (e) {
    console.error(`cannot embed this container: ${e.message}`);
    process.exit(1);
  }
  mkdirSync(out, { recursive: true });
  for (const file of source.files) writeFileSync(join(out, file.path), file.content);
  if (flag('--json')) {
    console.log(JSON.stringify({ model: modelPath, out, language, files: source.files.map((f) => f.path), notes: source.notes }, null, 2));
  } else {
    console.log(`\nwrote ${source.files.length} files to ${out}\n`);
    for (const file of source.files) console.log(`  ${file.path}  (${(file.content.length / 1024).toFixed(1)} KB)`);
    console.log('');
    for (const note of source.notes) console.log(`  ${note}`);
    console.log(`\n  build it:  cc -O2 ${out}/${name}.c ${out}/${name}_main.c -lm -o ${name}_demo\n`);
  }
  process.exit(0);
}

if (command !== 'check') {
  console.error('usage: node scripts/task.mjs families | check <dataset-dir> [--family <id>] [--json] '
    + '| scaffold --out <dir> [--dataset <dir>] | verify <model.json> --data <dir> '
    + '| pack <model.json> --bits <n> [--data <dir>] [--out <file>] | embed <model.json> --out <dir> [--language cpp]');
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
