#!/usr/bin/env node
//
// Run the generated plugin's PANEL the way a HOST runs it, and fail the build if it does not survive that.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────────────────
// One day produced three crashes that every gate this repository had was happy with:
//
//   * a nil font put into a dictionary literal inside `drawRect:` — an exception raised in the HOST's process,
//     which took GarageBand down with it;
//   * and then, after moving those attributes out of `drawRect:`, the same dictionaries cached WITHOUT being
//     retained. `PluginGui.mm` is compiled without ARC, so the host's run loop freed them at the end of the
//     iteration the panel was created in and the next draw messaged dead objects: SIGSEGV in NSStringDrawing,
//     instantly, the first time the editor was opened.
//
// Every one of those passed a compile, a static guard reading the source, and an offscreen render. They passed
// because **nothing in any pipeline ever RAN the panel** — and the one harness that rendered it kept a single
// autorelease pool for the whole run, so a borrowed object stayed alive by accident. A real host drains a pool
// every run-loop iteration. `tools/clap-gui-host --drain-pool` is that host; this script is what makes it run
// WHERE A USER'S PLUGIN IS BUILT rather than when somebody remembers to.
//
// ── WHAT IT DOES ───────────────────────────────────────────────────────────────────────────────────────────
// Compiles the GUI host against the materialised project — the same sources CMake has just built — and renders
// the panel TWICE: once plainly, and once with the pool drained between creating the panel and drawing it. Both
// must exit 0, produce a real bitmap, and agree on the panel's size.
//
// ⚠️ IT FAILS LOUDLY WHEN IT CANNOT DO ITS JOB. A missing source tree, CLAP header, engine checkout or host
// binary is an ERROR, never a skip: a check that did not run must not read as a check that passed (H17). The
// opposite failure is just as bad — a build that goes green because this step quietly did nothing.
//
// Run:  node scripts/audio-plugin-panel-render.mjs [--build-dir <dir>] [--engine <dir>] [--clap-include <dir>]
//       [--out <dir>]
//       On a runner, RUNNER_TEMP and AUDIO_PLUGIN_BUILD_DIR are already set, so it needs no arguments.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const at = argv.indexOf(name);
  return at !== -1 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : fallback;
};
const RUNNER_TEMP = process.env.RUNNER_TEMP || tmpdir();
const fail = (why) => {
  console.error(`\n[panel-render] REFUSING TO PASS: ${why}`);
  process.exit(1);
};
const log = (m) => console.log(`[panel-render] ${m}`);

// The rig build is the one a person downloads and the one with every control on it, so it is the default: a
// panel proven on the plain gain stage and not on the rig would prove the wrong shape.
const buildDir = resolve(opt('--build-dir', process.env.AUDIO_PLUGIN_BUILD_DIR || join(RUNNER_TEMP, 'audio-plugin-nam-build')));
const engineDir = resolve(opt('--engine', join(RUNNER_TEMP, 'namcore')));
const outDir = resolve(opt('--out', join(RUNNER_TEMP, 'panel-render')));

// ── the sources CMake just built. If they are not here, this step is looking at the wrong tree and must say so
// rather than compile something else and call it the plugin. ────────────────────────────────────────────────
const SOURCES = ['Plugin.cpp', 'PluginEntry.cpp', 'PluginGui.mm', 'ModelData.cpp', 'CabIr.cpp'];
const sourceDir = join(buildDir, 'Source');
for (const f of SOURCES) {
  if (!existsSync(join(sourceDir, f))) fail(`${join(sourceDir, f)} does not exist — is --build-dir the materialised project?`);
}

// ── the engine, exactly as the generated CMake globs it: top level AND one directory down, because the WaveNet
// architecture registers itself from `NAM/wavenet/` and a glob that misses it links a plugin that cannot load a
// single capture (`No config parser registered for architecture: WaveNet`). ──────────────────────────────────
const namDir = join(engineDir, 'NAM');
if (!existsSync(join(namDir, 'get_dsp.h'))) fail(`${namDir}/get_dsp.h does not exist — pass --engine, or check the cache step`);
const engineSources = [];
for (const rel of ['', ...readdirSync(namDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)]) {
  const dir = rel ? join(namDir, rel) : namDir;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.cpp'))) engineSources.push(join(dir, f));
}
if (!engineSources.length) fail(`${namDir} holds no .cpp files — the engine checkout is not the one the build used`);

// ── CLAP headers. The target clones clap-wrapper and hands it to CMake, so the header is either inside the
// build tree (FetchContent) or in the wrapper checkout; both are searched, and neither is assumed. ───────────
function findClapInclude() {
  const explicit = opt('--clap-include');
  if (explicit) return resolve(explicit);
  const roots = [buildDir, join(RUNNER_TEMP, 'clap-wrapper')].filter(existsSync);
  for (const root of roots) {
    const hit = execFileSync('find', [root, '-path', '*/clap/clap.h', '-print', '-quit'], { encoding: 'utf8' }).trim();
    if (hit) return dirname(dirname(hit));
  }
  return null;
}
const clapInclude = findClapInclude();
if (!clapInclude || !existsSync(join(clapInclude, 'clap', 'clap.h'))) {
  fail(`no clap/clap.h under ${buildDir} or ${join(RUNNER_TEMP, 'clap-wrapper')} — pass --clap-include`);
}
log(`sources   ${sourceDir}`);
log(`engine    ${namDir} (${engineSources.length} .cpp)`);
log(`clap      ${clapInclude}`);

// ── build the host the way the tool's own header says to: the plugin's sources, one binary, Cocoa. ──────────
mkdirSync(outDir, { recursive: true });
const host = join(outDir, 'clap_gui_host');
const compile = spawnSync('c++', [
  '-std=c++20', '-O2', '-w', '-DNAM_SAMPLE_FLOAT',
  `-I${clapInclude}`,
  `-I${join(namDir)}`,
  `-I${engineDir}`,
  `-I${join(engineDir, 'Dependencies', 'eigen')}`,
  `-I${join(engineDir, 'Dependencies', 'nlohmann')}`,
  `-I${sourceDir}`,
  join(REPO, 'tools', 'clap-gui-host', 'clap_gui_host.mm'),
  ...SOURCES.map((f) => join(sourceDir, f)),
  ...engineSources,
  '-framework', 'Cocoa', '-framework', 'QuartzCore',
  '-o', host,
], { encoding: 'utf8' });
if (compile.status !== 0) {
  console.error(compile.stdout || '');
  console.error(compile.stderr || '');
  fail(`the GUI host did not compile against ${sourceDir}`);
}
log(`host      ${host}`);

// ── the two renders. `--drain-pool` is the one that matters: it models the host's run loop, and the shipped
// use-after-free is invisible without it. ──────────────────────────────────────────────────────────────────
function render(label, extraArgs) {
  const png = join(outDir, `${label}.png`);
  const run = spawnSync(host, ['--out', png, ...extraArgs], { encoding: 'utf8', timeout: 120_000 });
  const out = `${run.stdout || ''}${run.stderr || ''}`;
  // A crash is a SIGNAL, not an exit code, and a signal must never be read as anything else.
  if (run.signal) {
    console.error(out.split('\n').slice(-12).join('\n'));
    fail(`${label}: the panel host was killed by ${run.signal} — that is the plugin crashing a host`);
  }
  if (run.status !== 0) {
    console.error(out.split('\n').slice(-12).join('\n'));
    fail(`${label}: the panel host exited ${run.status}`);
  }
  if (!existsSync(png)) fail(`${label}: the host exited 0 and wrote no bitmap`);
  const bytes = statSync(png).size;
  if (bytes < 2000) fail(`${label}: the render is ${bytes} bytes — that is not a drawn panel`);
  const size = (out.match(/the panel asks for (\d+x\d+) points/) || [])[1] || null;
  if (!size) fail(`${label}: the host never reported the panel's size, so nothing here proved a panel exists`);
  const sha = createHash('sha256').update(readFileSync(png)).digest('hex').slice(0, 16);
  log(`${label.padEnd(14)} panel ${size} · ${bytes} bytes · sha ${sha}`);
  return { size, bytes };
}

const plain = render('plain', []);
const drained = render('drained', ['--drain-pool']);
if (plain.size !== drained.size) {
  fail(`the panel reports ${plain.size} with a host's pool drained and ${drained.size} without it`);
}

log('PASS — the panel draws, and it survives the run loop that frees what the plugin did not own');
