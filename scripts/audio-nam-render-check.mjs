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
 * Can this CPU run this model in real time? THE number a device needs, and the one nothing had measured.
 *
 * `realTimeFactor` is wall time over audio time: **below 1 is faster than real time**, and the headroom is
 * `1 / rtf`. It is computed here rather than in the C++ so the arithmetic is unit-tested — a factor reported
 * upside down would read as a comfortable pass on a machine that cannot actually keep up.
 *
 * ⚠️ WHAT THIS DOES *NOT* MEASURE, said rather than implied: the audio device, its buffer, its driver and its
 * xruns. This is the plugin's own DSP throughput through its real `process()`, at 48 kHz and 64-frame blocks,
 * which is the part that decides whether a Pi CAN — hardware I/O is the part that decides whether it does.
 */
/**
 * The host's timing line out of its stdout, or null.
 *
 * The host prints its plugin identity and then the timing, both as JSON, one per line. Exported so the parse
 * is TESTED rather than trusted: it returns null on failure, and a caller that treated null as "no timing" and
 * carried on would report a throughput of nothing as a pass.
 */
export function parseHostTiming(stdout) {
  return String(stdout || '').split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{') && l.includes('processSeconds'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .pop() || null;
}

export function realTimeFactor({ processSeconds, audioSeconds }) {
  if (!(audioSeconds > 0)) return null;
  return { realTimeFactor: processSeconds / audioSeconds, timesFaster: audioSeconds / processSeconds };
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

function compile(args, label, cwd = ROOT) {
  const cxx = process.env.CXX ?? 'c++';
  const run = spawnSync(cxx, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) {
    console.error(`[nam-render] x ${label} failed to compile:\n${(run.stderr || run.stdout || '').slice(-4000)}`);
    process.exit(1);
  }
}

/**
 * Every C++ compile in this file carries these. One definition, spread into each invocation.
 *
 * ⚠️ THE STANDARD AND THE SAMPLE TYPE BELONG TOGETHER HERE, and leaving them out of the shared list is a
 * mistake this file already made: the two-step compile for the reference tool was written with only the
 * sample flag, so the engine's sources were compiled as C++17 and clang answered `no template named
 * 'optional' in namespace 'std'` seventeen times. Found by running the check locally rather than on a runner.
 */
const COMPILE_FLAGS = ['-std=c++20', '-O2', '-w', '-DNAM_SAMPLE_FLOAT'];

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
export function namRenderCheck({ pluginDir, modelPath, namcore, clapInclude = null, work, seconds = 0.25, timingSeconds = 4, sampleRate = 48000 }) {
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
    ...COMPILE_FLAGS,
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
  // ⚠️ COMPILED IN TWO STEPS, AND THE INCLUDE ORDER IS WHY. TWO FILES IN THIS TREE ARE CALLED `wav.h`:
  // `NAM/wav.h` (namespace `nam::detail`, used by the engine) and `AudioDSPTools/dsp/wav.h` (namespace
  // `dsp::wav`, used by the tool). One `-I` order cannot serve both — the first version of this compiled
  // render.cpp in the same invocation as the engine sources and the reference failed with
  // "`dsp` has not been declared", because `#include "wav.h"` had resolved to the engine's. So the engine's
  // translation units are compiled with the engine's include order, the tool's with the tool's, and the
  // objects are linked after.
  // ⚠️ AND IN SEPARATE OBJECT DIRECTORIES, which is the second half of the same problem: BOTH GROUPS CONTAIN
  // A FILE CALLED wav.cpp, so one `-c` run would write `wav.o` over the other's and the link would fail on
  // `nam::detail::load_wav_ir` — a missing engine symbol caused by an object filename collision. Also found
  // by running this locally rather than on a runner.
  const objNam = join(work, 'obj-nam');
  const objTool = join(work, 'obj-tool');
  mkdirSync(objNam, { recursive: true });
  mkdirSync(objTool, { recursive: true });
  const adt = join(namcore, 'Dependencies', 'AudioDSPTools', 'dsp');
  compile([...COMPILE_FLAGS, ...namIncludes, '-c', ...nam], 'the engine sources', objNam);
  compile([...COMPILE_FLAGS, `-I${adt}`, ...namIncludes, '-c',
    join(namcore, 'tools', 'render.cpp'), join(adt, 'wav.cpp')], 'the reference tool', objTool);
  const refBin = join(work, 'nam_render');
  const objects = [objNam, objTool].flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.o')).map((f) => join(dir, f)));
  if (!objects.length) {
    console.error(`[nam-render] nothing was compiled into ${objNam} or ${objTool}`);
    process.exit(1);
  }
  compile([...objects, '-o', refBin], 'the reference renderer');
  log(`built the reference renderer from the same engine checkout (${objects.length} objects)`);

  // ── 4. Two renders of one signal ──────────────────────────────────────────────────────────────────────
  const refWav = join(work, 'reference.wav');
  const refRun = spawnSync(refBin, [modelPath, dryWav, refWav], { encoding: 'utf8' });
  if (refRun.status !== 0) {
    console.error(`[nam-render] x the reference renderer failed:\n${(refRun.stderr || refRun.stdout || '').slice(-2000)}`);
    process.exit(1);
  }
  // ONE PLACE THAT INVOKES THE HOST, because both renders below must use the SAME block size and there being
  // two call sites is how a block size drifts between them — which is precisely what one of the guard's
  // mutations does on purpose, and it cannot be a mutation if the two call sites are one.
  const runHost = (label, inPath, outPath) => {
    const run = spawnSync(hostBin, ['--in', inPath, '--out', outPath, '--blocksize', String(REFERENCE_BLOCK_SIZE)], { encoding: 'utf8' });
    if (run.status !== 0) {
      console.error(`[nam-render] x ${label} failed:\n${(run.stderr || run.stdout || '').slice(-2000)}`);
      process.exit(1);
    }
    return String(run.stdout || '');
  };

  const oursMraw = join(work, 'ours.mraw');
  runHost('the plugin render', dryMraw, oursMraw);
  // ── 4b. The throughput render, on its own longer signal ───────────────────────────────────────────────
  // ⚠️ NOT THE SAME RENDER AS THE NULL. 0.25 s at 64-frame blocks is ~190 blocks, which is long enough to
  // compare two signals and not long enough to report a rate — the first blocks of a WaveNet carry whatever
  // the caches did, and on a runner the scheduler is still settling. The host binary is already built, so a
  // second signal costs one more process and makes the number about the model rather than about the startup.
  const timingDry = withFades(logSweep({ f1: 40, f2: 10000, sampleRate, seconds: timingSeconds, amplitude: 0.25 }), { samples: 64 });
  const timingMraw = join(work, 'timing.mraw');
  writeMraw(timingMraw, sampleRate, 1, timingDry);
  const timingStdout = runHost('the throughput render', timingMraw, join(work, 'timing-out.mraw'));
  // Read out of the host's own stdout rather than timed from JS: a `spawnSync` around the whole process would
  // mostly measure process startup and file I/O. The host times its process loop and prints that.
  const timing = parseHostTiming(timingStdout);
  if (!timing) {
    console.error('[nam-render] the host printed no timing line — a render that reports no throughput cannot '
      + 'answer whether this CPU keeps up');
    process.exit(1);
  }
  const rtf = realTimeFactor(timing);
  const ref = decodeWavMono(readFileSync(refWav));
  const ours = readMraw(oursMraw);
  log(`reference ${ref.samples.length} frames (${ref.format}) · plugin ${ours.frames} frames × ${ours.channels}ch`);

  // ── 5. The numbers ────────────────────────────────────────────────────────────────────────────────────
  const left = ours.data[0];
  const right = ours.data[1] || ours.data[0];
  const vsReference = compareToReference(ref.samples, left);
  const dryVsReference = compareToReference(dry, ref.samples);
  const leftVsRight = compareToReference(left, right);
  return { vsReference, dryVsReference, leftVsRight, sampleRate, frames: dry.length, timing, ...rtf };
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
  const r = namRenderCheck({
    pluginDir, modelPath, namcore, clapInclude, work,
    seconds: Number(arg('seconds', '0.25')),
    // The rate wants a longer signal than the null does; see 4b in namRenderCheck.
    timingSeconds: Number(arg('timing-seconds', '4')),
  });
  const maxRtf = Number(arg('max-rtf', '1'));
  const fmt = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} dB` : 'identical (exact)');
  console.log(`[nam-render] plugin vs reference : ${fmt(r.vsReference.nullDb)}  (peak error ${r.vsReference.peakError.toExponential(2)}, ${r.vsReference.frames} frames)`);
  console.log(`[nam-render] dry vs reference    : ${fmt(r.dryVsReference.nullDb)}  (what the model does to the signal)`);
  console.log(`[nam-render] left vs right       : ${fmt(r.leftVsRight.nullDb)}  (the two model instances must agree)`);
  console.log(`[nam-render] throughput          : ${r.timesFaster.toFixed(2)}x faster than real time `
    + `(${r.timing.processSeconds.toFixed(3)} s of CPU for ${r.timing.audioSeconds.toFixed(3)} s of audio at `
    + `${r.timing.sampleRate} Hz, ${r.timing.blockSize}-frame blocks) — real-time factor ${r.realTimeFactor.toFixed(3)}`);
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
  // ⭐ THE DEVICE QUESTION, AS AN ASSERTION. "A Pi you plug in and play" needs the DSP to fit inside real time
  // with room for the audio thread to be scheduled; a model that only just keeps up on a runner does not keep
  // up on a Pi. This is the plugin's own process() and nothing else, so it is the floor rather than the whole
  // story — the device, its buffer and its driver are the rest, and they can only make it worse.
  if (r.realTimeFactor >= maxRtf) {
    console.error(`[nam-render] x this CPU renders at ${r.realTimeFactor.toFixed(3)}x real time, at or over the `
      + `${maxRtf}x this check allows — a model that cannot beat real time here cannot run on a device`);
    process.exit(1);
  }
  console.log('[nam-render] the plugin plays the model the reference engine plays, and this CPU keeps up in real time\n');
}
