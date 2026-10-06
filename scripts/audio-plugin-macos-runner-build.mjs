// Build the audio-plugin target on THIS machine, by running the target's own steps.
//
// WHY THIS EXISTS
//
// A compile target can only be proven by running it, and this one has a format that needs a tool this
// repo's development machine does not have. Three of its four formats were built in a spike here (CLAP,
// VST3, AUv2, all universal); the fourth — the standalone — could not be, because its macOS shell is
// compiled by `ibtool`, which requires full Xcode, and the machine has only the Command Line Tools.
// GitHub's macOS runners ship Xcode, so this is the one place the whole target can be built — and until
// now nothing ran it: CI proves the guards, not the plugin. The build only happened when a user compiled.
//
// WHAT IT DOES NOT DO, AND THAT IS THE POINT. It does not re-type a single build command. It imports the
// target, materialises what `scaffold()` generates, and runs the `run:` blocks of `buildSteps()` in order
// — the same commands the rendered user workflow runs. A command changed in the target is changed here,
// which is what makes this evidence rather than a second implementation free to drift from the first.
//
// USAGE
//
//   node scripts/audio-plugin-macos-runner-build.mjs
//   AUDIO_PLUGIN_BUILD_DIR=/tmp/ap node scripts/audio-plugin-macos-runner-build.mjs
//
// Exits non-zero on the first step that fails, and again if the standalone was not produced. macOS only:
// the steps use `sysctl`, `nm`, `lipo` and `ditto`, and the standalone needs Xcode. Actions bills macOS at
// 10x, which is why the workflow that calls this is `workflow_dispatch`-only.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import audioPlugin from '../server/src/lib/compile-targets/audio-plugin-macos.js';
import { demoManifest } from './lib/pluginDemo.mjs';

const log = (m) => console.log(`[audio-plugin] ${m}`);

if (process.platform !== 'darwin') {
  console.error(`[audio-plugin] this target is macOS-only (the steps call sysctl/nm/lipo/ditto) — refusing to run on ${process.platform}.`);
  process.exit(1);
}

// One directory, named the same way in the workflow and in a hand-run, so the artifact the job uploads is
// the artifact this script wrote. `runner.temp` is what the target's own clone/configure steps read.
const RUNNER_TEMP = process.env.RUNNER_TEMP || mkdtempSync(join(tmpdir(), 'audio-plugin-runner-temp-'));
const OUT = process.env.AUDIO_PLUGIN_BUILD_DIR || join(RUNNER_TEMP, 'audio-plugin-build');
mkdirSync(OUT, { recursive: true });
log(`platform ${process.platform}/${process.arch} · building in ${OUT}`);

// ── 1. Materialise exactly what the target generates ────────────────────────────────────────────────────
const seed = [{ path: 'README.md', content: '# audio-plugin runner build\n' }];
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
    console.error(`[audio-plugin-macos] the model ${modelArg} does not exist — refusing to spend a build on it.`);
    process.exit(1);
  }
  seed.push({ path: `models/${basename(modelArg)}`, content: readFileSync(modelArg, 'utf8') });
  console.log(`[audio-plugin-macos] building with a model: ${basename(modelArg)}`);

  // ⚠️ AND THE BOARD, OR THE DEMO IS NOT THE THING THE RELEASE DESCRIBES — TWICE OVER. A model with no chain
  // gives the PLAIN plugin: the model IS processed, but the host offers ONE control, `Gain`, and the build's own
  // proof said so while the release page claimed an amplifier. And a chain is only four blocks, so the demo was
  // an amp and nothing else — no drive, no delay, no spring reverb, which is the difference between a demo that
  // sounds like a DI box and one that sounds like a rig. `demoManifest()` is the whole published signal path,
  // defined once in scripts/lib/pluginDemo.mjs so three runners cannot publish three products.
  seed.push({ path: 'morpheus.plugin.json', content: demoManifest() });

} else {
  console.log('[audio-plugin-macos] building WITHOUT a model (the gain stage)');
}

const validation = audioPlugin.validate(seed);
if (!validation.valid) {
  console.error(`[audio-plugin] the target rejected an empty workspace: ${JSON.stringify(validation)}`);
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

// ── 2. Run the target's own steps, in order ─────────────────────────────────────────────────────────────
// `uses:` steps are skipped: checkout and upload belong to the workflow around this, and there is nothing
// for them to do here. Every step that carries a `run:` is executed, including the verify step and the
// packaging step — this is meant to be the user's build, not a subset of it.
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
  console.log(`\n[audio-plugin] ▶ ${label}`);
  const result = spawnSync('bash', ['-c', step.run], {
    cwd: OUT,
    env: { ...process.env, RUNNER_TEMP },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error(`\n[audio-plugin] ✗ "${label}" failed (exit ${result.status}) — nothing after it ran.`);
    process.exit(1);
  }
  ran++;
}
log(`${ran} shell step(s) ran, ${skipped} non-shell step(s) skipped`);

// ── 3. Say what was produced, and insist on the format this job exists for ──────────────────────────────
const assets = join(OUT, 'build', 'assets');
const entries = existsSync(assets) ? readdirSync(assets) : [];
const bundles = entries.filter((n) => /\.(clap|vst3|component|app)$/.test(n)).sort();
log('produced:');
for (const name of bundles) {
  const bin = join(assets, name, 'Contents/MacOS', name.replace(/\.[^.]+$/, ''));
  const size = existsSync(bin) ? `${Math.round(statSync(bin).size / 1024)}K` : 'no binary';
  const archs = existsSync(bin)
    ? (spawnSync('lipo', ['-archs', bin], { encoding: 'utf8' }).stdout || '').trim()
    : '';
  log(`  ${name}  ${size}  ${archs}`);
}
for (const zip of entries.filter((n) => n.endsWith('.zip')).sort()) {
  log(`  ${zip}  ${statSync(join(assets, zip)).size} bytes`);
}

// The standalone is the reason this job exists — the three plugin formats can be built (and were) on a
// machine with only the Command Line Tools. Failing here names that, rather than leaving a green run that
// quietly skipped the one format nobody has ever built.
const standalone = bundles.find((n) => n.endsWith('.app'));
if (!standalone) {
  console.error('[audio-plugin] ✗ no standalone .app was produced. On a runner with Xcode this is the format that must appear — the others prove nothing about it.');
  process.exit(1);
}
const standaloneBin = join(assets, standalone, 'Contents/MacOS', standalone.replace(/\.[^.]+$/, ''));
if (!existsSync(standaloneBin)) {
  console.error(`[audio-plugin] ✗ the standalone bundle exists with NO BINARY in it (${standalone}) — the empty-bundle failure, on the one format whose step could have been skipped.`);
  process.exit(1);
}
log(`✓ all four formats built, standalone binary present at ${standaloneBin.replace(OUT, '.')}`);
