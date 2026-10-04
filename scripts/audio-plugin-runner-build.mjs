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
//   node scripts/audio-plugin-runner-build.mjs
//   AUDIO_PLUGIN_BUILD_DIR=/tmp/ap node scripts/audio-plugin-runner-build.mjs
//
// Exits non-zero on the first step that fails, and again if the standalone was not produced. macOS only:
// the steps use `sysctl`, `nm`, `lipo` and `ditto`, and the standalone needs Xcode. Actions bills macOS at
// 10x, which is why the workflow that calls this is `workflow_dispatch`-only.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import audioPlugin from '../server/src/lib/compile-targets/audio-plugin.js';

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
