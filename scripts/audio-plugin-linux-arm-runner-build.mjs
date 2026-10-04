// Build the audio-plugin-linux-arm target on THIS machine, by running the target's own steps.
//
// WHY THIS EXISTS. The same reason as the macOS and Windows runner scripts: a compile target is proven by
// running it, and the required checks cannot — they prove the guards, on a runner with no aarch64 CPU, no
// X11 and no ALSA. This has to run on an ARM64 Linux machine, because a plugin compiled for the wrong
// instruction set is the failure with no error message anywhere: the file exists, the name is right, and
// the host that loads it simply does not see it.
//
// WHAT IT DOES NOT DO, AND THAT IS THE POINT. It does not re-type a single build command. It imports the
// target, materialises what `scaffold()` generates, and executes the `run:` blocks of `buildSteps()` in
// order — the commands the rendered user workflow runs. A command changed in the target is a command
// changed here, which is what makes this evidence rather than a second implementation free to drift.
//
// USAGE (on ARM64 Linux)
//
//   node scripts/audio-plugin-linux-arm-runner-build.mjs
//   AUDIO_PLUGIN_BUILD_DIR=/tmp/ap node scripts/audio-plugin-linux-arm-runner-build.mjs
//
// Exits non-zero on the first step that fails, and again if any of the three formats is missing, is not an
// ELF image, or was compiled for a different CPU than the route names.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import audioPlugin, { LINUX_ASSETS } from '../server/src/lib/compile-targets/audio-plugin-linux-arm.js';

const log = (m) => console.log(`[audio-plugin-linux-arm] ${m}`);

// THE PLATFORM IS THE TARGET'S WHOLE CLAIM, so both halves of it are refused explicitly rather than left
// to fail somewhere deeper. A run on x86-64 Linux would build a perfectly good plugin for the wrong
// machine, and — without this — the AArch64 assertion would be the thing that caught it, one confusing
// step later. Two refusals, two messages, because "wrong OS" and "wrong CPU" are different mistakes.
if (process.platform !== 'linux') {
  console.error(`[audio-plugin-linux-arm] this target is Linux-only (it installs apt packages and links X11 and ALSA) — refusing to run on ${process.platform}.`);
  process.exit(1);
}
if (process.arch !== 'arm64') {
  console.error(`[audio-plugin-linux-arm] this target is aarch64-only (it is the Raspberry Pi route) — refusing to run on ${process.arch}. Building here would produce an ELF for the wrong CPU and the artefact's name would still say linux-arm.`);
  process.exit(1);
}

// One directory, named the same way in the workflow and in a hand-run, so the artifact the job uploads is
// the artifact this script wrote. `RUNNER_TEMP` is what the target's own clone/configure steps read.
const RUNNER_TEMP = process.env.RUNNER_TEMP || mkdtempSync(join(tmpdir(), 'audio-plugin-runner-temp-'));
const OUT = process.env.AUDIO_PLUGIN_BUILD_DIR || join(RUNNER_TEMP, 'audio-plugin-linux-arm-build');
mkdirSync(OUT, { recursive: true });
log(`platform ${process.platform}/${process.arch} · building in ${OUT}`);

// ── 0. Make the job look like a fresh runner ────────────────────────────────────────────────────────────
// THE STEPS CLONE INTO $RUNNER_TEMP AND `git clone` REFUSES A DIRECTORY THAT EXISTS — deliberately, and that
// refusal is worth keeping: a clone that reused whatever was already there would silently build against a
// different revision than the pin. But this script is run TWICE in one job now (once for the gain stage, once
// with a model), and the second run died on
//
//   fatal: destination path '/home/runner/work/_temp/clap-wrapper' already exists and is not an empty directory
//
// which is my workflow's fault rather than the steps'. So the two third-party checkouts are cleared here and
// said out loud, which keeps the refusal and still lets one job prove both shapes.
for (const dir of ['clap-wrapper', 'namcore']) {
  const stale = join(RUNNER_TEMP, dir);
  if (existsSync(stale)) {
    log(`clearing ${stale} so the steps behave as they would on a fresh runner`);
    rmSync(stale, { recursive: true, force: true });
  }
}

// ── 1. Materialise exactly what the target generates ────────────────────────────────────────────────────
// A MODEL IS OPT-IN, and the default is unchanged. With no `AUDIO_PLUGIN_MODEL` this script builds the gain
// plugin exactly as it did before models existed, which is what keeps the earlier proof valid; with one it
// builds the amp plugin, which fetches and compiles the reference engine as well. `--model` is the same
// switch spelled for a hand-run.
const modelArg = (() => {
  const at = process.argv.indexOf('--model');
  return process.env.AUDIO_PLUGIN_MODEL || (at !== -1 ? process.argv[at + 1] : '') || '';
})();
const seed = [{ path: 'README.md', content: '# audio-plugin-linux-arm runner build\n' }];
if (modelArg) {
  if (!existsSync(modelArg)) {
    console.error(`[audio-plugin-linux-arm] the model ${modelArg} does not exist — refusing to spend a build on it.`);
    process.exit(1);
  }
  // `models/` is the conventional place and what lib/namPlugin.js looks in first; the basename is kept so a
  // failure message names the file the user recognises rather than a temp path.
  seed.push({ path: `models/${basename(modelArg)}`, content: readFileSync(modelArg, 'utf8') });
  log(`building with a model: ${basename(modelArg)}`);
} else {
  log('building WITHOUT a model (the gain stage) — set AUDIO_PLUGIN_MODEL=/path/to/model.nam to build the amp');
}
const validation = audioPlugin.validate(seed);
if (!validation.valid) {
  console.error(`[audio-plugin-linux-arm] the target rejected an empty workspace: ${JSON.stringify(validation)}`);
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

// ── 2. Run the target's own steps, in order, through bash ───────────────────────────────────────────────
// `uses:` steps are skipped: checkout and upload belong to the workflow around this. Every `run:` block is
// executed, including the target's own verify step — so the ELF, architecture and entry-point assertions
// are the target's, not a second copy of them.
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
  console.log(`\n[audio-plugin-linux-arm] > ${label}`);
  // `bash -c`, and the steps carry their own `set -euo pipefail` rather than relying on this invocation —
  // a step whose failure handling lives in the thing that launches it is a step that behaves differently
  // on the runner, and GitHub's own default shell is `bash -e {0}`, not this.
  const result = spawnSync('bash', ['-c', step.run], {
    cwd: OUT,
    env: { ...process.env, RUNNER_TEMP },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error(`\n[audio-plugin-linux-arm] x "${label}" failed (exit ${result.status}) — nothing after it ran.`);
    process.exit(1);
  }
  ran++;
}
log(`${ran} shell step(s) ran, ${skipped} non-shell step(s) skipped`);

// ── 3. Read the produced binaries, independently of the step that checked them ──────────────────────────
// The target's verify step used `readelf` and `nm`. This reads the ELF header directly, in JS, which is a
// different code path to the same claim: if that step's `readelf` parsing were wrong — a locale, a changed
// output format, a `sed` that stopped matching — this still catches a plugin built for the wrong CPU, and
// it is the assertion the whole route exists for.
const AARCH64 = 0xb7; // EM_AARCH64
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46];

function elfMachine(path) {
  try {
    const fd = readFileSync(path);
    if (fd.length < 0x40) return null;
    if (!ELF_MAGIC.every((b, i) => fd[i] === b)) return null;
    // e_machine is a 2-byte little-endian field at offset 0x12. Read from the header rather than asked of a
    // tool, because the tool is the thing being double-checked.
    return fd.readUInt16LE(0x12);
  } catch { return null; }
}

const walk = (dir) => (existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
  : []);
const assets = join(OUT, LINUX_ASSETS);
const produced = walk(assets);
log('produced:');
for (const p of produced) {
  const rel = p.slice(assets.length + 1);
  const machine = elfMachine(p);
  if (machine !== null) {
    log(`  ${rel}  ${statSync(p).size} bytes  ${machine === AARCH64 ? 'AArch64 ELF' : `ELF for machine 0x${machine.toString(16)}`}`);
  }
}

// The three formats this route promises. `find`-style discovery rather than a constructed path — the VST3
// is a folder whose inner directory is named after the CPU, and the standalone has no extension at all, so
// a hardcoded path is exactly the mistake the Windows route made on its fourth run.
const expected = [
  ['VST3', (p) => p.endsWith('.so') && p.includes('.vst3')],
  ['CLAP', (p) => p.endsWith('.clap')],
  // The standalone is an executable with NO extension, so it is identified by being one of the files in the
  // assets directory itself, not inside a bundle.
  ['standalone', (p) => !p.includes('.vst3') && !p.endsWith('.clap') && !p.includes('.wclap') && dirname(p) === assets],
];
for (const [format, match] of expected) {
  const hit = produced.filter((p) => match(p) && statSync(p).isFile());
  if (!hit.length) {
    console.error(`[audio-plugin-linux-arm] x no ${format} binary was produced under ${assets}. On an ARM64 Linux runner this format must appear — the others prove nothing about it.`);
    process.exit(1);
  }
  const machine = elfMachine(hit[0]);
  if (machine !== AARCH64) {
    console.error(`[audio-plugin-linux-arm] x the ${format} at ${hit[0]} is ${machine === null ? 'not an ELF image' : `an ELF for machine 0x${machine.toString(16)}`}, not AArch64 — this plugin would not load on the machine this route names.`);
    process.exit(1);
  }
  log(`ok ${format}: ${hit[0].slice(OUT.length + 1)} (${statSync(hit[0]).size} bytes, AArch64)`);
}
log('all three formats built, each an AArch64 ELF');
