#!/usr/bin/env node
// audio-testbench — measure a CLAP plugin without a DAW, an audio device or a GUI.
//
// WHAT IT ANSWERS, and each of these is a question that otherwise costs a DAW session and an opinion:
//
//   does it load and run at all?            the plugin is instantiated, activated and processed offline
//   does it report its latency correctly?   the number it CLAIMS is compared with the number MEASURED
//   does bypass/gain actually do anything?  a parameter is set by event and the level change is measured
//   does it alias?                          a 15 kHz tone is driven through it and non-harmonic energy is measured
//   does it distort when it should not?     THD and THD+N of a 1 kHz sine, read from the output
//   is it silent, or full of NaN?           the hard failures, checked on every run
//
// HOW IT RUNS A PLUGIN WITHOUT A HOST: it compiles the plugin's own CLAP sources against a small offline host
// (tools/clap-offline) and renders a file through it. So this tests the CLAP CORE — the code the developer
// wrote. The wrapped VST3/AU/standalone binaries are a separate question, proved by the runner builds; saying
// so matters, because a bench that quietly tested something other than the shipped artifact would be worse
// than no bench.
//
//   node scripts/audio-testbench.mjs                     generate a reference plugin, build and measure it
//   node scripts/audio-testbench.mjs --plugin <dir>      measure an existing project (Source/*.cpp)
//   node scripts/audio-testbench.mjs --strict            also assert the REFERENCE plugin's known behaviour
//   node scripts/audio-testbench.mjs --keep              leave the build directory in place
//
// Requires a C++ compiler. Needs the CLAP headers: pass --clap-include, set CLAP_INCLUDE, or let it clone the
// pinned commit into .cache/clap.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import audioPlugin from '../server/src/lib/compile-targets/audio-plugin-macos.js';
import { linearToDb, peak, rms, rmsDb } from '../server/src/lib/audio/dsp.js';
import { coherentSineOfLength, sine, whiteNoise } from '../server/src/lib/audio/signals.js';
import { aliasCheck, estimateLatency, nullDepth, thd, thdPlusNoise } from '../server/src/lib/audio/analysis.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SR = 48000;

// Pinned exactly as the plugin build pins clap-wrapper: "it worked yesterday" is only useful if yesterday is a
// commit. This is the CLAP revision the macOS plugin build was proved against.
const CLAP_REPO = 'https://github.com/free-audio/clap.git';
const CLAP_REF = 'a47f6badb49d948fd009998f28309cdab78979c9';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const pass = [];
const fail = [];
const warn = [];
const check = (ok, label, detail) => (ok ? pass : fail).push(detail ? `${label} — ${detail}` : label);

// ── MRAW: the trivial float32 container the host speaks, so WAV parsing stays in the guarded JS library ────
function writeMraw(path, sampleRate, channels, interleaved) {
  const head = Buffer.alloc(20);
  head.write('MRAW', 0, 'ascii');
  head.writeUInt32LE(1, 4);
  head.writeUInt32LE(sampleRate, 8);
  head.writeUInt32LE(channels, 12);
  head.writeUInt32LE(interleaved.length / channels, 16);
  const body = Buffer.alloc(interleaved.length * 4);
  for (let i = 0; i < interleaved.length; i++) body.writeFloatLE(interleaved[i], i * 4);
  writeFileSync(path, Buffer.concat([head, body]));
}
function readMraw(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'MRAW') throw new Error(`${path} is not MRAW`);
  const sampleRate = buf.readUInt32LE(8);
  const channels = buf.readUInt32LE(12);
  const frames = buf.readUInt32LE(16);
  const out = Array.from({ length: channels }, () => new Float64Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) out[c][f] = buf.readFloatLE(20 + (f * channels + c) * 4);
  }
  return { sampleRate, channels, frames, data: out };
}
const interleave = (channels) => {
  const frames = channels[0].length;
  const out = new Float32Array(frames * channels.length);
  for (let f = 0; f < frames; f++) for (let c = 0; c < channels.length; c++) out[f * channels.length + c] = channels[c][f];
  return out;
};

// ── locate the CLAP headers ────────────────────────────────────────────────────────────────────────────────
function clapIncludeDir() {
  const explicit = value('--clap-include') ?? process.env.CLAP_INCLUDE;
  if (explicit) {
    if (!existsSync(join(explicit, 'clap', 'clap.h'))) {
      console.error(`--clap-include ${explicit} does not contain clap/clap.h`);
      process.exit(2);
    }
    return explicit;
  }
  const cache = join(ROOT, '.cache', 'clap');
  if (existsSync(join(cache, 'include', 'clap', 'clap.h'))) return join(cache, 'include');
  console.log(`fetching the CLAP headers (pinned ${CLAP_REF.slice(0, 8)}) into .cache/clap …`);
  mkdirSync(dirname(cache), { recursive: true });
  try {
    execFileSync('git', ['clone', '--quiet', CLAP_REPO, cache], { stdio: 'inherit' });
    execFileSync('git', ['-C', cache, 'checkout', '--quiet', CLAP_REF], { stdio: 'inherit' });
  } catch {
    console.error(`could not fetch the CLAP headers.\n  git clone ${CLAP_REPO} .cache/clap && git -C .cache/clap checkout ${CLAP_REF}\n  …or pass --clap-include <dir> / set CLAP_INCLUDE.`);
    process.exit(2);
  }
  return join(cache, 'include');
}

// ── build ──────────────────────────────────────────────────────────────────────────────────────────────────
const work = value('--work') ?? mkdtempSync(join(tmpdir(), 'audio-testbench-'));
mkdirSync(work, { recursive: true });
const projectDir = value('--plugin') ?? join(work, 'reference-plugin');
if (!value('--plugin')) {
  const { files } = audioPlugin.scaffold([{ path: 'README.md', content: '# test bench reference plugin\n' }]);
  for (const f of files) {
    const p = join(projectDir, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
  }
  console.log(`generated a reference plugin in ${projectDir}`);
}

// ⚠️ GLOBBED, NOT NAMED. This listed Plugin.cpp and PluginEntry.cpp, and a generated project now also carries
// the panel — one file per platform — so a hand-written list breaks the first time the generator emits
// another. See audio-nam-render-check.mjs for the same fix and the failure that prompted it.
const sources = readdirSync(join(projectDir, 'Source'))
  .filter((f) => f.endsWith('.cpp') || f.endsWith('.mm'))
  .sort()
  .map((f) => join(projectDir, 'Source', f));
if (!sources.length) {
  console.error(`no CLAP sources under ${projectDir}/Source`);
  process.exit(2);
}
const hostSrc = join(ROOT, 'tools', 'clap-offline', 'clap_offline.cpp');
const bin = join(work, 'clap_offline');
const cxx = process.env.CXX ?? 'c++';
console.log(`compiling with ${cxx} …`);
const compile = spawnSync(cxx, [
  '-std=c++20', '-O2', '-w',
  `-I${clapIncludeDir()}`,
  `-I${join(projectDir, 'Source')}`,
  hostSrc, ...sources, '-o', bin,
], { encoding: 'utf8' });
if (compile.status !== 0) {
  console.error(`compilation failed:\n${compile.stderr || compile.stdout}`);
  process.exit(1);
}

// ── --self-test: prove the bench can fail ──────────────────────────────────────────────────────────────────
// A bench that cannot fail is decoration, and the way to know is to hand it a plugin that is genuinely broken.
// This patches the reference plugin's own gain application so its control is wired to nothing — the exact bug
// the parameter check exists to catch — and requires the bench to fail on it.
if (flag('--self-test')) {
  const broken = join(work, 'broken-plugin');
  mkdirSync(join(broken, 'Source'), { recursive: true });
  const srcPath = join(projectDir, 'Source', 'Plugin.cpp');
  const original = readFileSync(srcPath, 'utf8');
  // ⚠️ THE PATTERN IS THE PLUGIN'S SHAPE, and it changed when the parameter list became a table: the output
  // level is now one entry in `smoothed[]`, so the line reads `in_l * db_to_linear(p->smoothed[IDX_OUTPUT])`.
  // The count below is what tells you the shape moved again rather than silently patching nothing.
  const APPLIED_GAIN = /in_[lr] \* db_to_linear\(p->smoothed\[IDX_[A-Z_]+\)\)/g;
  const uses = (str) => (str.match(APPLIED_GAIN) || []).length;
  const patched = original
    .replace(/in_l \* db_to_linear\(p->smoothed\[IDX_[A-Z_]+\]\)/g, 'in_l * 1.0')
    .replace(/in_r \* db_to_linear\(p->smoothed\[IDX_[A-Z_]+\]\)/g, 'in_r * 1.0');
  // Count the APPLIED-gain lines specifically: `p->smoothed` appears elsewhere (it is stepped toward its
  // target), so a whole-file check for it fails on a patch that worked perfectly — which is what happened.
  if (uses(original) < 2 || uses(patched) !== 0) {
    console.error(`self-test could not patch the gain application (found ${uses(original)} applied-gain lines) — the reference plugin changed shape`);
    process.exit(2);
  }
  writeFileSync(join(broken, 'Source', 'Plugin.cpp'), patched);
  writeFileSync(join(broken, 'Source', 'PluginEntry.cpp'), readFileSync(join(projectDir, 'Source', 'PluginEntry.cpp')));
  console.log('self-test: running the bench against a plugin whose Gain control is wired to nothing …');
  const run = spawnSync(process.execPath, [
    fileURLToPath(import.meta.url), '--plugin', broken, '--strict',
    ...(value('--clap-include') ? ['--clap-include', value('--clap-include')] : []),
  ], { encoding: 'utf8' });
  process.stdout.write(run.stdout ?? '');
  process.stderr.write(run.stderr ?? '');
  if (run.status === 0) {
    console.error('\n✗ the bench PASSED a plugin whose control does nothing — it cannot fail, so it proves nothing\n');
    process.exit(1);
  }
  console.log('\n✓ self-test: the bench failed the broken plugin, so its checks are load-bearing\n');
  process.exit(0);
}

// ── render one signal through the plugin ───────────────────────────────────────────────────────────────────
function render(samples, { params = [], blockSize = 256, channels = 1 } = {}) {
  const inPath = join(work, 'in.mraw');
  const outPath = join(work, 'out.mraw');
  const chans = Array.from({ length: channels }, () => Float64Array.from(samples));
  writeMraw(inPath, SR, channels, interleave(chans));
  const argv = ['--in', inPath, '--out', outPath, '--blocksize', String(blockSize)];
  for (const [id, v] of params) argv.push('--param', `${id}=${v}`);
  const run = spawnSync(bin, argv, { encoding: 'utf8' });
  if (run.status !== 0) {
    console.error(`the plugin failed to render: ${run.stderr || run.stdout}`);
    process.exit(1);
  }
  // ⚠️ THE HOST PRINTS TWO JSON LINES, AND THIS USED TO TAKE THE LAST ONE. It printed only the descriptor
  // until it grew a timing report (`processSeconds` / `audioSeconds`, added for the throughput measurement in
  // scripts/audio-model-bench.mjs); from then on `.pop()` returned the TIMING object, so every run read
  // `info.name` as `undefined` and crashed on `info.params`. The bench measured NOTHING in that time, and the
  // crash is the only reason it looked like a failure rather than like a wrong number.
  //
  // The descriptor is now found by WHAT IT IS — the only reported object carrying a plugin `id` — rather than
  // by its position, so a third line cannot do this again.
  const reported = (run.stdout || '').trim().split('\n')
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
  const info = reported.find((o) => o && typeof o.id === 'string');
  if (!info) {
    console.error(`the host printed no plugin descriptor:\n${run.stdout}`);
    process.exit(1);
  }
  return { info, audio: readMraw(outPath) };
}

// ── the measurements ───────────────────────────────────────────────────────────────────────────────────────
const tone = sine({ freq: 1000, sampleRate: SR, length: SR, amplitude: 0.25 });
const first = render(tone);
const info = first.info;
const out = first.audio.data[0];

console.log(`\nplugin   ${info.name} (${info.id}) by ${info.vendor}, version ${info.version}`);
console.log(`ports    ${info.inputChannels} in → ${info.portChannels} channel(s) at ${info.sampleRate} Hz, block ${info.blockSize}`);
console.log(`params   ${info.params.map((p) => `#${p.id} ${p.name} [${p.min}..${p.max}] = ${p.value}`).join(' · ') || 'none'}`);
console.log(`latency  reported ${info.reportedLatency} samples\n`);

// 1. it ran, and produced audio
check(out.some((v) => v !== 0), 'the plugin produced output');
check(out.every((v) => Number.isFinite(v)), 'the output contains no NaN or Inf');
check(rms(out) > 0, 'the output is not silent', `rms ${rmsDb(out).toFixed(1)} dBFS`);

// 2. reported latency vs measured — the classic plugin bug, and the one a DAW cannot show you.
//    The claim is only checkable if the plugin MAKES one, so a plugin that introduces latency and declares
//    nothing fails here rather than passing on a technicality (0 == 0).
const lat = estimateLatency(tone, Float64Array.from(out), { sampleRate: SR });
if (info.reportsLatency) {
  check(Math.abs(lat.fractional - info.reportedLatency) <= 1.0,
    'the latency it REPORTS matches the latency it HAS',
    `reported ${info.reportedLatency}, measured ${lat.fractional.toFixed(2)} samples`);
} else {
  check(Math.abs(lat.fractional) <= 1.0,
    'it introduces no latency, so declaring none is honest',
    `measured ${lat.fractional.toFixed(2)} samples with no declared latency`);
}
check(lat.correlation > 0.9, 'the output correlates with the input', `r=${lat.correlation.toFixed(4)}`);

// 3. nothing added that was not asked for: null against the input
const nulled = nullDepth(tone, Float64Array.from(out), { sampleRate: SR });
console.log(`null     ${nulled.residualDb.toFixed(1)} dB against the input (gain-matched ${nulled.gainDb.toFixed(2)} dB)`);
if (!flag('--strict')) {
  check(nulled.residualDb < -60 || Math.abs(nulled.gainDb) > 0.5,
    'the plugin is either transparent or deliberately changing the level',
    `null ${nulled.residualDb.toFixed(1)} dB, gain ${nulled.gainDb.toFixed(2)} dB`);
}

// 4. a parameter, set by event, does something measurable
const gainParam = info.params.find((p) => /gain|drive|level|volume|output/i.test(p.name));
if (gainParam) {
  const target = Math.min(gainParam.max, gainParam.default + 6);
  const boosted = render(tone, { params: [[gainParam.id, target]] });
  const before = rms(out);
  const after = rms(boosted.audio.data[0]);
  const delta = linearToDb(after / before);
  const expected = target - gainParam.default;
  console.log(`param    "${gainParam.name}" ${gainParam.default} → ${target} measured as ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} dB (expected ${expected >= 0 ? '+' : ''}${expected.toFixed(2)})`);
  check(Math.abs(delta - expected) <= 0.25, `setting "${gainParam.name}" changes the level by the amount it says`,
    `measured ${delta.toFixed(2)} dB, expected ${expected.toFixed(2)} dB`);
  if (flag('--strict')) check(delta > 1, `"${gainParam.name}" is not ignored`, `${delta.toFixed(2)} dB`);
} else {
  warn.push('no gain-like parameter found, so the parameter path was not exercised');
}

// 5. distortion it should not be adding, and aliasing it should not be folding
const asSine = thd(Float64Array.from(out), { sampleRate: SR, fundamental: 1000, harmonics: 9 });
const asThdn = thdPlusNoise(Float64Array.from(out), { sampleRate: SR, fundamental: 1000 });
console.log(`THD      ${asSine.thdPercent.toFixed(5)} %  (${asSine.thdDb.toFixed(1)} dB)`);
console.log(`THD+N    ${asThdn.thdnPercent.toFixed(5)} %  (${asThdn.thdnDb.toFixed(1)} dB)`);
check(asThdn.thdnDb < -60, 'what comes out is as clean as what went in', `THD+N ${asThdn.thdnDb.toFixed(1)} dB`);

const high = coherentSineOfLength({ bin: 2560, fftSize: 8192, sampleRate: SR }).samples; // 15 kHz
const highOut = render(high).audio.data[0];
const aliases = aliasCheck(Float64Array.from(highOut), { sampleRate: SR, fundamental: 15000 });
console.log(`aliasing strongest non-harmonic component ${Number.isFinite(aliases.strongestAliasDb) ? `${aliases.strongestAliasDb.toFixed(1)} dB` : 'none'}`);
check(!(aliases.strongestAliasDb > -60), 'no aliasing above -60 dB', aliases.strongestAliasDb > -60 ? `${aliases.strongestAliasDb.toFixed(1)} dB` : 'none above the floor');

// 6. a second, different signal, to catch a plugin that only sounds right on one input
const noise = whiteNoise({ length: SR / 2, seed: 7, amplitude: 0.25 });
const noiseOut = render(noise);
check(noiseOut.audio.data[0].every((v) => Number.isFinite(v)), 'a noise input does not produce NaN');
check(peak(noiseOut.audio.data[0]) < 8, 'the output is not running away', `peak ${peak(noiseOut.audio.data[0]).toFixed(3)}`);

// ── the report ─────────────────────────────────────────────────────────────────────────────────────────────
console.log('');
for (const p of pass) console.log(`  PASS  ${p}`);
for (const w of warn) console.log(`  WARN  ${w}`);
for (const f of fail) console.log(`  FAIL  ${f}`);
console.log(`\n${pass.length}/${pass.length + fail.length} checks passed`);
if (flag('--json')) console.log(JSON.stringify({ plugin: info, nullDepthDb: nulled.residualDb, latencyMeasured: lat.fractional, thdnDb: asThdn.thdnDb, aliasDb: aliases.strongestAliasDb, pass, fail, warn }));

if (!flag('--keep')) rmSync(work, { recursive: true, force: true });
else console.log(`build kept in ${work}`);

if (fail.length) {
  console.log('\n✗ the plugin did not meet the bench\n');
  process.exit(1);
}
console.log('the plugin loads, runs, reports its latency honestly and does what its controls say\n');

