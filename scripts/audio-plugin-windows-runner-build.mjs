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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import audioPlugin from '../server/src/lib/compile-targets/audio-plugin-windows.js';

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
