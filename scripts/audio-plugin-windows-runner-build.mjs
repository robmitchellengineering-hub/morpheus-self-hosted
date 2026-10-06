// Build the audio-plugin-windows target on THIS machine, by running the target's own steps.
//
// WHY THIS EXISTS. The same reason as the macOS runner script: a compile target is proven by running it,
// and the required checks cannot run it — they prove the guards, on ubuntu, with no MSVC and no Windows.
// This has to run on a Windows runner, because the generated project uses the Visual Studio generator and
// because a plugin that will not load is the failure mode with no error message anywhere.
//
// WHAT IT DOES NOT DO, AND THAT IS THE POINT. It does not re-type a single build command. It imports the
// target, materialises what `scaffold()` generates (the same generator the macOS route uses), and executes
// the `run:` blocks of `buildSteps()` in order — the commands the rendered user workflow runs. A command
// changed in the target is a command changed here, which is what makes this evidence rather than a second
// implementation free to drift.
//
// USAGE (on Windows)
//
//   node scripts/audio-plugin-windows-runner-build.mjs
//   set AUDIO_PLUGIN_BUILD_DIR=C:\ap && node scripts/audio-plugin-windows-runner-build.mjs
//
// PowerShell is the shell, because that is what the runner uses by default and what the steps are written
// in. Exits non-zero on the first step that fails, and again if the standalone was not produced.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import audioPlugin from '../server/src/lib/compile-targets/audio-plugin-windows.js';
import { demoManifest } from './lib/pluginDemo.mjs';

const log = (m) => console.log(`[audio-plugin-windows] ${m}`);

if (process.platform !== 'win32') {
  console.error(`[audio-plugin-windows] this target is Windows-only (the generated project uses the Visual Studio generator and MSVC) — refusing to run on ${process.platform}.`);
  process.exit(1);
}

// One directory, named the same way in the workflow and in a hand-run, so the artifact the job uploads is
// the artifact this script wrote. `runner.temp` is what the target's own clone/configure steps read.
const RUNNER_TEMP = process.env.RUNNER_TEMP || mkdtempSync(join(tmpdir(), 'audio-plugin-runner-temp-'));
const OUT = process.env.AUDIO_PLUGIN_BUILD_DIR || join(RUNNER_TEMP, 'audio-plugin-windows-build');
mkdirSync(OUT, { recursive: true });
log(`platform ${process.platform}/${process.arch} · building in ${OUT}`);

// ── 1. Materialise exactly what the target generates ────────────────────────────────────────────────────
const seed = [{ path: 'README.md', content: '# audio-plugin-windows runner build\n' }];
// ── THE MODEL, WHEN ONE IS GIVEN ─────────────────────────────────────────────────────────────────────────
// ⚠️ THIS SCRIPT HAD NO WAY TO BUILD THE AMP, AND THE DEMO DOWNLOAD SHIPPED THE GAIN PLUGIN BECAUSE OF IT.
// The rig ran exactly one build, with no model, so `plugin-{mac,windows}-*.zip` was the stereo gain stage —
// and the release described it as "a neural amp model with an input trim, a gate and a three-band tone
// stack", which was false. The proof file it published said so in as many words ("(none: this is the gain
// plugin)") and listed one parameter, `Gain`, where the amp has six.
//
// `models/` is the conventional place and what lib/namPlugin.js looks in first; the basename is kept so a
// build log names the file the way its owner does. Mirrors the Linux ARM rig, which already has this — the
// mechanism was never route-specific, only this script's command line was.
// ── THE TWO THIRD-PARTY CHECKOUTS, CLEARED BEFORE ANY STEP RUNS ──────────────────────────────────────────
// ⚠️ THIS JOB NOW BUILDS TWICE, AND THE SECOND BUILD DIED ON THE FIRST ONE'S CLONE:
//
//   fatal: destination path '.../clap-wrapper' already exists and is not an empty directory
//
// The steps clone into $RUNNER_TEMP and `git clone` refuses a directory that exists — deliberately, and that
// refusal is worth keeping: a clone that reused whatever was already there would silently build against a
// tree from an earlier step. So they are cleared here and said out loud, which keeps the refusal and still
// lets one job prove both shapes.
//
// The Linux ARM rig has had this since it gained a second build, and its comment quotes the same error. This
// is that block, on the routes that were missing it — which is why the failure was identical and the fix is
// a copy rather than a discovery.
for (const dir of ['clap-wrapper', 'namcore']) {
  const stale = join(RUNNER_TEMP, dir);
  if (existsSync(stale)) {
    log(`clearing ${stale} so the steps behave as they would on a fresh runner`);
    rmSync(stale, { recursive: true, force: true });
  }
}

const modelArg = (() => {
  const at = process.argv.indexOf('--model');
  return at !== -1 && process.argv[at + 1] && !process.argv[at + 1].startsWith('--') ? process.argv[at + 1] : null;
})();

// ⚠️ A CABINET IS A BLOCK IN THE BOARD, BUT THE FILE IS NOT THE BOARD. `demoBoard()` names a `cab` block, and
// the target emits the cabinet stage whenever the board has one — behind `#if MORPHEUS_HAS_CAB`, which is 0
// until an impulse response is actually in the project. So the demo builds and sounds the same with or without
// this flag, and passing it is what turns the block from an inert stage into a speaker. The demo shipped
// without one for as long as there was no impulse response we were allowed to redistribute — see the note in
// scripts/lib/pluginDemo.mjs and the release notice.
const cabArg = (() => {
  const at = process.argv.indexOf('--cab');
  return at !== -1 && process.argv[at + 1] && !process.argv[at + 1].startsWith('--') ? process.argv[at + 1] : null;
})();
if (cabArg) {
  if (!existsSync(cabArg)) {
    console.error(`[${tag}] the cabinet ${cabArg} does not exist — refusing to spend a build on it.`);
    process.exit(1);
  }
  // ⚠️ `models/`, BESIDE THE .nam — NOT A DIRECTORY OF ITS OWN. That is the convention the target ranks first
  // (lib/cabIr.js: a .wav under `models/` wins over one anywhere else), it is where the Linux rig has always put
  // it, and a second convention on two of three platforms is how the same project builds differently per platform.
  seed.push({ path: `models/${basename(cabArg)}`, content: readFileSync(cabArg).toString('base64'), encoding: 'base64' });
  console.log(`[${tag}] building with a cabinet: ${basename(cabArg)}`);
}

if (modelArg) {
  if (!existsSync(modelArg)) {
    console.error(`[audio-plugin-windows] the model ${modelArg} does not exist — refusing to spend a build on it.`);
    process.exit(1);
  }
  seed.push({ path: `models/${basename(modelArg)}`, content: readFileSync(modelArg, 'utf8') });
  console.log(`[audio-plugin-windows] building with a model: ${basename(modelArg)}`);

  // ⚠️ AND THE BOARD, OR THE DEMO IS NOT THE THING THE RELEASE DESCRIBES — TWICE OVER. A model with no chain
  // gives the PLAIN plugin: the model IS processed, but the host offers ONE control, `Gain`, and the build's own
  // proof said so while the release page claimed an amplifier. And a chain is only four blocks, so the demo was
  // an amp and nothing else — no drive, no delay, no spring reverb, which is the difference between a demo that
  // sounds like a DI box and one that sounds like a rig. `demoManifest()` is the whole published signal path,
  // defined once in scripts/lib/pluginDemo.mjs so three runners cannot publish three products.
  seed.push({ path: 'morpheus.plugin.json', content: demoManifest() });

} else {
  console.log('[audio-plugin-windows] building WITHOUT a model (the gain stage)');
}

const validation = audioPlugin.validate(seed);
if (!validation.valid) {
  console.error(`[audio-plugin-windows] the target rejected an empty workspace: ${JSON.stringify(validation)}`);
  process.exit(1);
}
const { files, generated, warnings } = audioPlugin.scaffold(seed);
for (const f of files) {
  const dest = join(OUT, f.path);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, f.content);
}
log(`generated ${generated.join(', ')}`);
for (const w of warnings || []) log(`warning: ${w}`);

// ── 2. Run the target's own steps, in order, through PowerShell ─────────────────────────────────────────
// `uses:` steps are skipped: checkout and upload belong to the workflow around this. Every `run:` block is
// executed, including the target's own verify step — so the PE and entry-point assertions are the target's,
// not a second copy of them.
const steps = audioPlugin.buildSteps(files);
let ran = 0;
let skipped = 0;
for (const step of steps) {
  const label = step.name || step.uses || '(unnamed step)';
  if (!step.run) {
    log(`skip (not a shell step): ${label}`);
    skipped++;
    continue;
  }
  console.log(`\n[audio-plugin-windows] > ${label}`);
  const result = spawnSync('pwsh', ['-NoProfile', '-Command', step.run], {
    cwd: OUT,
    env: { ...process.env, RUNNER_TEMP },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error(`\n[audio-plugin-windows] x "${label}" failed (exit ${result.status}) — nothing after it ran.`);
    process.exit(1);
  }
  ran++;
}
log(`${ran} shell step(s) ran, ${skipped} non-shell step(s) skipped`);

// ── 3. Say what was produced, and insist on the standalone ──────────────────────────────────────────────
const assets = join(OUT, 'build', 'assets');
const isPE = (p) => {
  try {
    const fd = readFileSync(p);
    if (fd.length < 0x40 || fd.readUInt16LE(0) !== 0x5a4d) return false;      // 'MZ'
    const peOffset = fd.readUInt32LE(0x3c);
    return fd.length > peOffset + 4 && fd.readUInt32LE(peOffset) === 0x00004550; // 'PE\0\0'
  } catch { return false; }
};

const walk = (dir) => (existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
  : []);
const produced = walk(assets);
log('produced:');
for (const p of produced) {
  const rel = p.slice(assets.length + 1).replace(/\\/g, '/');
  const size = statSync(p).size;
  if (/\.(exe|dll|vst3|clap)$/i.test(p)) log(`  ${rel}  ${size} bytes  ${isPE(p) ? 'PE' : 'NOT A PE'}`);
}

// The three formats this route promises, at the paths clap-wrapper actually uses on Windows. The target's
// own verify step asserts these too; failing here as well means a run cannot be green while missing the one
// artifact the user cannot get any other way — the standalone.
const expected = [
  ['VST3', join(assets, 'VST3'), '.vst3'],
  ['CLAP', join(assets, 'CLAP'), '.clap'],
  ['standalone', join(assets, 'Standalone-morpheus_plugin_standalone'), '.exe'],
];
for (const [format, dir, ext] of expected) {
  const hit = walk(dir).filter((p) => p.toLowerCase().endsWith(ext) && isPE(p));
  if (!hit.length) {
    console.error(`[audio-plugin-windows] x no ${format} binary was produced under ${dir}. On a Windows runner this format must appear — the others prove nothing about it.`);
    process.exit(1);
  }
  log(`ok ${format}: ${hit[0].slice(OUT.length + 1).replace(/\\/g, '/')} (${statSync(hit[0]).size} bytes)`);
}
log('all three formats built, each a PE image');
