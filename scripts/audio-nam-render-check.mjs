// Does the plugin that carries a model actually PLAY the model?
//
// WHY THIS EXISTS. `verify-audio-plugin.mjs` proves the model is embedded, the engine is linked, and the
// plugin compiles for the right CPU. None of that says the plugin's OUTPUT is the model's output, and that
// is the only claim a musician cares about. So this renders the same dry signal twice — once through the
// plugin's own CLAP entry point with `tools/clap-offline`, once through NeuralAmpModelerCore's own `render`
// tool — and compares them sample by sample.
//
// THE REFERENCE IS THE SAME CODE, DELIBERATELY. Both sides build the SAME pinned NeuralAmpModelerCore
// checkout (see `lib/namPlugin.js`), so a difference in the output is a difference in how the PLUGIN drives
// the engine, not two implementations disagreeing. That is what makes a tight threshold meaningful: the
// engine is not under test here, the plugin is.
//
// ⚠️ AND BOTH SIDES ARE BUILT WITH NAM_SAMPLE_FLOAT, WHICH IS NOT THE DEFAULT FOR NAMCORE'S OWN TOOLS. The
// plugin pins float samples (it halves the model's working memory, which is the difference between a WaveNet
// on a Raspberry Pi and one on a workstation); NAMCore's `render` defaults to double. Comparing a float
// plugin against a double reference would measure the precision choice, not the plugin. So the reference is
// built the same way and the comparison isolates the wiring — and the float-versus-double gap is a separate
// measurement, deliberately not taken here.
//
// WHAT DIFFERS EVEN THEN, AND WHY THE THRESHOLD IS NOT ZERO: our plugin calls process() ONE FRAME AT A TIME
// (it ramps a parameter per sample), while `render` calls it in blocks of 64. For any of these architectures
// that is the same per-sample arithmetic in the same order, so the residual should be float rounding — but
// "should be" is why there is a threshold and a printed number rather than an assertion of equality.
//
// Run:  node scripts/audio-nam-render-check.mjs --plugin <dir> --model <x.nam> --namcore <checkout> \
//         --clap-include <dir> --work <dir>
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWavMono, encodeWav } from '../server/src/lib/audio/wav.js';
import { logSweep, withFades } from '../server/src/lib/audio/signals.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The same CLAP headers `scripts/audio-testbench.mjs` builds against, pinned to the same commit. */
export const CLAP_REPO = 'https://github.com/free-audio/clap.git';
export const CLAP_REF = 'a47f6badb49d948fd009998f28309cdab78979c9';

/**
 * Where the CLAP headers are, fetching them if they are nowhere.
 *
 * An explicit `--clap-include` or `CLAP_INCLUDE` wins; then the cache; then a pinned clone. Header-only and
 * pinned for the same reason the test bench pins it: these are compiled into a binary that decides whether a
 * plugin is correct, so the headers should be a constant rather than whatever main is today.
 */
export function clapIncludes({ explicit = null, cache = join(ROOT, '.cache', 'clap') } = {}) {
  const given = explicit || process.env.CLAP_INCLUDE;
  if (given) {
    if (!existsSync(join(given, 'clap', 'clap.h'))) {
      console.error(`[nam-render] --clap-include ${given} does not contain clap/clap.h`);
      process.exit(2);
    }
    return given;
  }
  if (existsSync(join(cache, 'include', 'clap', 'clap.h'))) return join(cache, 'include');
  mkdirSync(dirname(cache), { recursive: true });
  log(`fetching the CLAP headers (pinned ${CLAP_REF.slice(0, 8)}) into ${cache} …`);
  const clone = spawnSync('git', ['clone', '--quiet', CLAP_REPO, cache], { stdio: 'inherit' });
  const co = clone.status === 0 ? spawnSync('git', ['-C', cache, 'checkout', '--quiet', CLAP_REF], { stdio: 'inherit' }) : clone;
  if (co.status !== 0) {
    console.error(`[nam-render] could not fetch the CLAP headers — pass --clap-include <dir>`);
    process.exit(2);
  }
  return join(cache, 'include');
}

/** The host's block size, and it is 64 BECAUSE THAT IS WHAT NAMCORE'S `render` USES. Matching it removes the
 *  one difference between the two signal paths that has nothing to do with the plugin's correctness. */
export const REFERENCE_BLOCK_SIZE = 64;

// ── MRAW: the container `tools/clap-offline` speaks. Same layout the test bench writes (see audio-testbench). ─
export function writeMraw(path, sampleRate, channels, interleaved) {
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

export function readMraw(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'MRAW') throw new Error(`${path} is not MRAW`);
  const sampleRate = buf.readUInt32LE(8);
  const channels = buf.readUInt32LE(12);
  const frames = buf.readUInt32LE(16);
  const data = Array.from({ length: channels }, () => new Float64Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) data[c][f] = buf.readFloatLE(20 + (f * channels + c) * 4);
  }
  return { sampleRate, channels, frames, data };
}

/**
 * How far apart two signals are, in dB below the reference — the number this whole file exists to produce.
 *
 * Pure, so it is unit-tested by the guard rather than only exercised on a runner: a comparison that cannot
 * tell two different signals apart would make every run green.
 */
export function compareToReference(reference, candidate) {
  const frames = Math.min(reference.length, candidate.length);
  let err = 0;
  let sig = 0;
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    const d = reference[i] - candidate[i];
    err += d * d;
    sig += reference[i] * reference[i];
    const a = Math.abs(d);
    if (a > peak) peak = a;
  }
  const refRms = Math.sqrt(sig / Math.max(frames, 1));
  const errRms = Math.sqrt(err / Math.max(frames, 1));
  const nullDb = err === 0 ? -Infinity : 20 * Math.log10(Math.max(errRms, 1e-300) / Math.max(refRms, 1e-30));
  return {
    frames,
    lengthMismatch: reference.length !== candidate.length,
    refRms,
    errRms,
    peakError: peak,
    nullDb,
    identical: err === 0,
  };
}

const log = (m) => console.log(`[nam-render] ${m}`);

function compile(args, label) {
  const cxx = process.env.CXX ?? 'c++';
  const run = spawnSync(cxx, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) {
    console.error(`[nam-render] x ${label} failed to compile:\n${(run.stderr || run.stdout || '').slice(-4000)}`);
    process.exit(1);
  }
}

/** Every C++ source under the engine's NAM directory, the way its own CMakeLists globs them. */
function namSources(namcore) {
  const out = [];
  for (const sub of ['NAM', 'NAM/wavenet']) {
    const dir = join(namcore, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith('.cpp')) out.push(join(dir, f));
  }
  if (!out.length) {
    console.error(`[nam-render] no NAM sources under ${namcore}/NAM — is this a NeuralAmpModelerCore checkout?`);
    process.exit(1);
  }
  return out;
}

/**
 * Render the same dry signal through the plugin and through the reference engine, and say how far apart they
 * are. Returns the numbers rather than asserting them, so the caller decides what is good enough and can
 * print everything either way.
 */
export function namRenderCheck({ pluginDir, modelPath, namcore, clapInclude = null, work, seconds = 0.25, sampleRate = 48000 }) {
  mkdirSync(work, { recursive: true });
  const clap = clapInclude || clapIncludes();
  const nam = namSources(namcore);
  const namIncludes = [
    `-I${namcore}`,
    `-I${join(namcore, 'NAM')}`,
    `-I${join(namcore, 'Dependencies', 'eigen')}`,
    `-I${join(namcore, 'Dependencies', 'nlohmann')}`,
  ];

  // ── 1. The dry signal, written TWICE from one buffer ──────────────────────────────────────────────────
  // One array of samples, two files: a mono WAV for the reference tool and a stereo MRAW for the host. Writing
  // them from the same Float64Array is what guarantees the two renders are of the same input — generating the
  // same signal twice from a formula would be one more place for the comparison to be wrong.
  const dry = withFades(logSweep({ f1: 40, f2: 10000, sampleRate, seconds, amplitude: 0.25 }), { samples: 64 });
  const dryWav = join(work, 'dry.wav');
  const dryMraw = join(work, 'dry.mraw');
  writeFileSync(dryWav, encodeWav({ sampleRate, data: dry, format: 'float32' }));
  const stereo = new Float32Array(dry.length * 2);
  for (let i = 0; i < dry.length; i++) { stereo[i * 2] = dry[i]; stereo[i * 2 + 1] = dry[i]; }
  writeMraw(dryMraw, sampleRate, 2, stereo);
  log(`dry signal: ${dry.length} frames at ${sampleRate} Hz (${seconds}s log sweep 40 Hz–10 kHz)`);

  // ── 2. The host, built against the plugin's own sources ───────────────────────────────────────────────
  // Against the SOURCES rather than the packaged .clap, for the reason the host documents: it tests the CLAP
  // core — the part the plugin actually implements — without a wrapper, a DAW or an audio device. The .clap
  // that ships beside it is the same object file.
  const hostBin = join(work, 'clap_offline');
  compile([
    '-std=c++20', '-O2', '-w', '-DNAM_SAMPLE_FLOAT',
    `-I${clap}`, `-I${join(pluginDir, 'Source')}`, ...namIncludes,
    join(ROOT, 'tools', 'clap-offline', 'clap_offline.cpp'),
    join(pluginDir, 'Source', 'Plugin.cpp'),
    join(pluginDir, 'Source', 'PluginEntry.cpp'),
    join(pluginDir, 'Source', 'ModelData.cpp'),
    ...nam,
    '-o', hostBin,
  ], 'the offline host + the plugin + the engine');
  log('built the offline host against the plugin\'s own CLAP sources');

  // ── 3. The reference, built from the same engine checkout ─────────────────────────────────────────────
  const refBin = join(work, 'nam_render');
  compile([
    '-std=c++20', '-O2', '-w', '-DNAM_SAMPLE_FLOAT',
    ...namIncludes,
    `-I${join(namcore, 'Dependencies', 'AudioDSPTools', 'dsp')}`,
    join(namcore, 'tools', 'render.cpp'),
    join(namcore, 'Dependencies', 'AudioDSPTools', 'dsp', 'wav.cpp'),
    ...nam,
    '-o', refBin,
  ], 'the reference renderer');
  log('built the reference renderer from the same engine checkout');

  // ── 4. Two renders of one signal ──────────────────────────────────────────────────────────────────────
  const refWav = join(work, 'reference.wav');
  const refRun = spawnSync(refBin, [modelPath, dryWav, refWav], { encoding: 'utf8' });
  if (refRun.status !== 0) {
    console.error(`[nam-render] x the reference renderer failed:\n${(refRun.stderr || refRun.stdout || '').slice(-2000)}`);
    process.exit(1);
  }
  const oursMraw = join(work, 'ours.mraw');
  const oursRun = spawnSync(hostBin, ['--in', dryMraw, '--out', oursMraw, '--blocksize', String(REFERENCE_BLOCK_SIZE)], { encoding: 'utf8' });
  if (oursRun.status !== 0) {
    console.error(`[nam-render] x the plugin render failed:\n${(oursRun.stderr || oursRun.stdout || '').slice(-2000)}`);
    process.exit(1);
  }
  const ref = decodeWavMono(readFileSync(refWav));
  const ours = readMraw(oursMraw);
  log(`reference ${ref.samples.length} frames (${ref.format}) · plugin ${ours.frames} frames × ${ours.channels}ch`);

  // ── 5. The numbers ────────────────────────────────────────────────────────────────────────────────────
  const left = ours.data[0];
  const right = ours.data[1] || ours.data[0];
  const vsReference = compareToReference(ref.samples, left);
  const dryVsReference = compareToReference(dry, ref.samples);
  const leftVsRight = compareToReference(left, right);
  return { vsReference, dryVsReference, leftVsRight, sampleRate, frames: dry.length };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────
function arg(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`);
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const pluginDir = arg('plugin');
  const modelPath = arg('model');
  const namcore = arg('namcore');
  const clapInclude = arg('clap-include');
  const work = arg('work', join(ROOT, '.cache', 'nam-render'));
  const maxNullDb = Number(arg('max-null-db', '-60'));
  for (const [what, v] of [['--plugin', pluginDir], ['--model', modelPath], ['--namcore', namcore]]) {
    if (!v) { console.error(`[nam-render] ${what} is required`); process.exit(2); }
  }
  const r = namRenderCheck({ pluginDir, modelPath, namcore, clapInclude, work, seconds: Number(arg('seconds', '0.25')) });
  const fmt = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} dB` : 'identical (exact)');
  console.log(`[nam-render] plugin vs reference : ${fmt(r.vsReference.nullDb)}  (peak error ${r.vsReference.peakError.toExponential(2)}, ${r.vsReference.frames} frames)`);
  console.log(`[nam-render] dry vs reference    : ${fmt(r.dryVsReference.nullDb)}  (what the model does to the signal)`);
  console.log(`[nam-render] left vs right       : ${fmt(r.leftVsRight.nullDb)}  (the two model instances must agree)`);
  console.log(JSON.stringify({ ok: true, ...r }));
  const worst = Math.max(
    Number.isFinite(r.vsReference.nullDb) ? r.vsReference.nullDb : -Infinity,
    Number.isFinite(r.leftVsRight.nullDb) ? r.leftVsRight.nullDb : -Infinity,
  );
  if (r.vsReference.lengthMismatch) {
    console.error('[nam-render] x the plugin produced a different number of frames than the reference');
    process.exit(1);
  }
  if (worst > maxNullDb) {
    console.error(`[nam-render] x the plugin is ${worst.toFixed(1)} dB from the reference, worse than the ${maxNullDb} dB this check requires`);
    process.exit(1);
  }
  console.log('[nam-render] the plugin plays the model the reference engine plays\n');
}
