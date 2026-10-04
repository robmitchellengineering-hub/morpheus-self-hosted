// Does the tone stack in the plugin do what the tone stack in the design says?
//
// WHY THIS EXISTS. A filter is the easiest thing in audio to get subtly wrong and the hardest to notice: a
// shelf at the wrong corner still sounds like a shelf, and a Q that is 20 % off still sounds like a tone
// control. So the plugin's filters are compared against `lib/audio/toneStack.js` — which is the same RBJ
// design, written twice on purpose — by rendering a sweep through the plugin and subtracting the JS output
// sample by sample. Two implementations that have to agree on a measured number is a proof; one
// implementation checked against itself is a comment.
//
// ⚠️ THE PARAMETERS RAMP, AND THE COMPARISON HAS TO KNOW IT. The plugin steps every parameter one pole per
// sample (τ ≈ 1000 samples, ~21 ms), so for the first fraction of a second its filter is still moving toward
// the setting while the JS design applies the final coefficients to the whole file. Comparing the whole file
// therefore measures the ramp: with the original 0.001 dB coefficient-update threshold that residual was
// −55 dB, and it is why the emitted C++ recomputes on a millionth of a decibel instead. The settled tail is
// what this check reads, and the number it reports is the filters being the same filter.
//
// Run:  node scripts/audio-amp-chain-check.mjs --plugin <dir> [--clap-include <dir>] [--work <dir>]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logSweep, withFades } from '../server/src/lib/audio/signals.js';
import { toneDesign, toneProcess, toneResponseDb } from '../server/src/lib/audio/toneStack.js';
import { clapIncludes, compareToReference, readMraw, writeMraw } from './audio-nam-render-check.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** How much of the rendered signal is skipped before the comparison: the parameter ramp lives here. */
export const SETTLE_FRACTION = 0.75;

/**
 * The settings this check renders, chosen so that each band is exercised on its own and then together. A
 * single "all bands up" case would pass with two of the three filters wired to the wrong band.
 */
export const TONE_CASES = [
  { label: 'flat', params: [], gains: {} },
  { label: 'bass +12', params: ['2=12'], gains: { bass: 12 } },
  { label: 'bass -12', params: ['2=-12'], gains: { bass: -12 } },
  { label: 'mid -12', params: ['3=-12'], gains: { mid: -12 } },
  { label: 'treble +12', params: ['4=12'], gains: { treble: 12 } },
  { label: 'all +6', params: ['2=6', '3=6', '4=6'], gains: { bass: 6, mid: 6, treble: 6 } },
];

/** Build the offline host against the plugin's own sources — the same harness the model check uses. */
function buildHost({ pluginDir, clapInclude, work }) {
  const bin = join(work, 'host');
  const cxx = process.env.CXX ?? 'c++';
  const sources = ['Plugin.cpp', 'PluginEntry.cpp', 'ModelData.cpp']
    .map((f) => join(pluginDir, 'Source', f))
    .filter((f) => existsSync(f));
  const run = spawnSync(cxx, [
    '-std=c++20', '-O2', '-w', '-DNAM_SAMPLE_FLOAT',
    `-I${clapInclude}`, `-I${join(pluginDir, 'Source')}`,
    join(ROOT, 'tools', 'clap-offline', 'clap_offline.cpp'), ...sources, '-o', bin,
  ], { encoding: 'utf8' });
  if (run.status !== 0) {
    console.error(`[amp-chain] x the host failed to build:\n${(run.stderr || run.stdout || '').slice(-3000)}`);
    process.exit(1);
  }
  return bin;
}

/**
 * Render the chain at each setting and compare it against the design. Returns the numbers rather than
 * asserting them, so the caller decides what is good enough and can print everything either way.
 */
export function ampChainCheck({ pluginDir, clapInclude = null, work, sampleRate = 48000, seconds = 0.5 }) {
  mkdirSync(work, { recursive: true });
  const bin = buildHost({ pluginDir, clapInclude: clapInclude || clapIncludes(), work });

  // One dry signal, written once. Every case renders the same input, so a difference between two rows is a
  // difference between two settings and nothing else.
  const dry = withFades(logSweep({ f1: 40, f2: 10000, sampleRate, seconds, amplitude: 0.25 }), { samples: 64 });
  const stereo = new Float32Array(dry.length * 2);
  for (let i = 0; i < dry.length; i++) { stereo[i * 2] = dry[i]; stereo[i * 2 + 1] = dry[i]; }
  const dryPath = join(work, 'dry.mraw');
  writeMraw(dryPath, sampleRate, 2, stereo);
  const from = Math.floor(dry.length * SETTLE_FRACTION);

  const rows = [];
  for (const testCase of TONE_CASES) {
    const outPath = join(work, `out-${testCase.label.replace(/[^a-z0-9]+/gi, '_')}.mraw`);
    const args = ['--in', dryPath, '--out', outPath, '--blocksize', '64'];
    for (const p of testCase.params) args.push('--param', p);
    const run = spawnSync(bin, args, { encoding: 'utf8' });
    if (run.status !== 0) {
      console.error(`[amp-chain] x the plugin render failed for "${testCase.label}":\n${(run.stderr || '').slice(-1000)}`);
      process.exit(1);
    }
    const actual = readMraw(outPath).data[0];
    const design = toneDesign({ gains: testCase.gains, sampleRate });
    const expected = toneProcess(design, dry);
    rows.push({
      label: testCase.label,
      gains: testCase.gains,
      null: compareToReference(expected.subarray(from), actual.subarray(from)),
      designDb: {
        50: toneResponseDb(design, 50, sampleRate),
        800: toneResponseDb(design, 800, sampleRate),
        6000: toneResponseDb(design, 6000, sampleRate),
      },
    });
  }
  return { rows, sampleRate, frames: dry.length, settledFrom: from };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────
function arg(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`);
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const pluginDir = arg('plugin');
  if (!pluginDir) { console.error('[amp-chain] --plugin is required'); process.exit(2); }
  const maxNullDb = Number(arg('max-null-db', '-120'));
  const r = ampChainCheck({
    pluginDir,
    clapInclude: arg('clap-include'),
    work: arg('work', join(ROOT, '.cache', 'amp-chain')),
    seconds: Number(arg('seconds', '0.5')),
  });
  console.log('[amp-chain] plugin vs the JS design, over the settled tail:');
  let worst = -Infinity;
  for (const row of r.rows) {
    const v = Number.isFinite(row.null.nullDb) ? row.null.nullDb : -Infinity;
    if (v > worst) worst = v;
    const d = row.designDb;
    console.log(`[amp-chain]   ${row.label.padEnd(11)} ${(Number.isFinite(row.null.nullDb) ? `${row.null.nullDb.toFixed(1)} dB` : 'identical').padStart(13)}   design: 50Hz ${d[50].toFixed(2)} · 800Hz ${d[800].toFixed(2)} · 6kHz ${d[6000].toFixed(2)} dB`);
  }
  console.log(JSON.stringify({ ok: true, ...r }));
  if (r.rows.some((row) => row.null.lengthMismatch)) {
    console.error('[amp-chain] x the plugin produced a different number of frames than the design');
    process.exit(1);
  }
  if (worst > maxNullDb) {
    console.error(`[amp-chain] x the tone stack is ${worst.toFixed(1)} dB from the design, worse than the ${maxNullDb} dB this check requires`);
    process.exit(1);
  }
  console.log('[amp-chain] the tone stack in the plugin is the tone stack in the design\n');
}
