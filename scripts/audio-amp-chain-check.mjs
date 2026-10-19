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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logSweep, withFades } from '../server/src/lib/audio/signals.js';
// The one rule for what a generated plugin compiles and links with — see generatedSources() there for the two
// failures that put it in one place rather than three.
import { generatedLinkFlags, generatedSources } from './audio-nam-render-check.mjs';
import { toneDesign, toneProcess, toneResponseDb } from '../server/src/lib/audio/toneStack.js';
import { convolveDirect, rms } from '../server/src/lib/audio/dsp.js';
import { decodeWav } from '../server/src/lib/audio/wav.js';
import { cabTapGain, MAX_CAB_TAPS } from '../server/src/lib/cabIr.js';
import { AMP_CHAIN, GATE_OFF_DB, chainParams } from '../server/src/lib/ampChain.js';
import { scaffoldPlugin } from '../server/src/lib/audioPluginProject.js';
import { clapIncludes, compareToReference, readMraw, writeMraw } from './audio-nam-render-check.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** How much of the rendered signal is skipped before the comparison: the parameter ramp lives here. */
export const SETTLE_FRACTION = 0.75;

/**
 * The settings this check renders, chosen so that each band is exercised on its own and then together. A
 * single "all bands up" case would pass with two of the three filters wired to the wrong band.
 */
// ⚠️ THE IDS COME FROM THE PARAMETER TABLE, NOT FROM MEMORY. They were hardcoded as 2/3/4 until the GATE was
// inserted at position 2, at which point every one of these cases silently addressed the wrong control — the
// bass case became the gate. A number copied from a table is a number that goes stale the moment the table
// moves; this reads it.
// ⚠️ AND IT WENT STALE ANYWAY, WHICH IS WHY THE RUNNER FOUND IT AND NOTHING ELSE DID. When a chain became a
// list of STAGES, `AMP_CHAIN.params` stopped existing — the parameters are DERIVED now — so this file threw on
// import and the ARM chain proof had been dead since that day. No guard caught it: it is a script that needs a
// BUILT plugin, so the only thing that runs it is the runner, and the runner had not been dispatched since.
// The parameter list comes from the accessor that replaced the property, in the order the host will see it.
const paramId = (key) => {
  const at = chainParams(AMP_CHAIN).findIndex((p) => p.key === key);
  if (at === -1) throw new Error(`the amp chain has no "${key}" parameter — the cases below are stale`);
  return at + 1;
};

export const TONE_CASES = [
  { label: 'flat', params: [], gains: {} },
  { label: 'bass +12', params: [`${paramId('bass')}=12`], gains: { bass: 12 } },
  { label: 'bass -12', params: [`${paramId('bass')}=-12`], gains: { bass: -12 } },
  { label: 'mid -12', params: [`${paramId('mid')}=-12`], gains: { mid: -12 } },
  { label: 'treble +12', params: [`${paramId('treble')}=12`], gains: { treble: 12 } },
  {
    label: 'all +6',
    params: [`${paramId('bass')}=6`, `${paramId('mid')}=6`, `${paramId('treble')}=6`],
    gains: { bass: 6, mid: 6, treble: 6 },
  },
];

/** Build the offline host against the plugin's own sources — the same harness the model check uses. */
function buildHost({ pluginDir, clapInclude, work }) {
  const bin = join(work, 'host');
  const cxx = process.env.CXX ?? 'c++';
  // ⚠️ THE SOURCES AND THE LINK FLAGS COME FROM ONE PLACE, NOT FROM THIS FILE. This listed four generated
  // files by hand — with a good comment explaining why CabIr.cpp had to be in it — and that list was still a
  // list: when the generator grew a fifth file (the panel) the link failed on the ARM runner with
  //
  //   Plugin.cpp:(.text+0x9b0): undefined reference to `morpheus_gui_extension'
  //
  // which is the same failure, from the same cause, as the one in audio-nam-render-check.mjs an hour earlier.
  // `generatedSources` also picks the platform's panel and `generatedLinkFlags` links what it draws with.
  const run = spawnSync(cxx, [
    '-std=c++20', '-O2', '-w', '-DNAM_SAMPLE_FLOAT',
    `-I${clapInclude}`, `-I${join(pluginDir, 'Source')}`,
    join(ROOT, 'tools', 'clap-offline', 'clap_offline.cpp'),
    ...generatedSources(pluginDir), ...generatedLinkFlags(), '-o', bin,
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
export function ampChainCheck({ pluginDir, clapInclude = null, work, sampleRate = 48000, seconds = 0.5, cab = null, gateCase = false }) {
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

  // The cabinet's taps, decoded once. When a cabinet is baked in, THE EXPECTATION IS THE WHOLE CHAIN — tone
  // stack then speaker — because that is what the plugin under test is. Comparing the tone rows against the
  // tone stack alone measured +22 dB "errors" that were the cabinet doing its job, which is the check telling
  // the truth about a wrong expectation.
  const cabTaps = (() => {
    if (!cab) return null;
    const wav = decodeWav(readFileSync(cab));
    const raw = wav.data[0];
    // ⚠️ THE SAME NORMALISATION THE BAKE USES, FROM THE ONE FUNCTION THAT DEFINES IT. This divided by the
    // peak as well, so the expectation and the plugin would have gone on agreeing with each other at +15 dB —
    // two implementations of one level rule, both wrong together, which is exactly what a shared function is
    // for. `cabTapGain` sums the squares across the channels that get BAKED, so the slice matches resolveCab.
    const gain = cabTapGain(wav.data.slice(0, Math.min(wav.channels ?? 1, 2)), MAX_CAB_TAPS);
    return Float64Array.from(raw.subarray(0, MAX_CAB_TAPS), (v) => v / gain);
  })();
  const throughChain = (x) => (cabTaps ? convolveDirect(cabTaps, x).subarray(0, dry.length) : x);

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
    const expected = throughChain(toneProcess(design, dry));
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
  // ── the cabinet, when one was baked in ────────────────────────────────────────────────────────────────
  // Compared against `convolveDirect` on the SAME normalised taps the scaffold baked, which is the same
  // two-implementations-must-agree shape as the tone stack: the JS convolution is the design and the plugin's
  // ring buffer is what runs. With every parameter at 0 dB the cabinet is the only thing in the path.
  let cabRow = null;
  let gateRow = null;
  if (cab) {
    const taps = cabTaps;
    const outPath = join(work, 'out-cabinet.mraw');
    const run = spawnSync(bin, ['--in', dryPath, '--out', outPath, '--blocksize', '64'], { encoding: 'utf8' });
    if (run.status !== 0) {
      console.error(`[amp-chain] x the cabinet render failed:\n${(run.stderr || '').slice(-1000)}`);
      process.exit(1);
    }
    const actual = readMraw(outPath).data[0];
    // A STREAMING convolution drops the tail: the plugin emits as many frames as it was given, so the
    // reference is truncated to match rather than the comparison being off by the length of the IR.
    const expected = convolveDirect(taps, dry).subarray(0, dry.length);
    cabRow = {
      label: 'cabinet',
      taps: taps.length,
      null: compareToReference(expected.subarray(from), actual.subarray(from)),
      changedDb: compareToReference(dry.subarray(from), actual.subarray(from)).nullDb,
    };
  }
  // ── the gate ──────────────────────────────────────────────────────────────────────────────────────────
  // A GATE IS PROVEN BY A SIGNAL THAT GOES QUIET, not by a null test: with the threshold at its lowest the
  // gate is bypassed and the tone rows above already prove that exactly, but that says nothing about whether
  // it works. Three seconds: loud, quiet, loud. The quiet part must come out far below where it went in, and
  // the loud parts must come out where they went in — a gate that attenuates everything passes the first half
  // of that and fails the second.
  if (gateCase) {
    // ⚠️ 1.5 SECONDS A SECTION, and the first version used 0.5 — which made the gate look broken. A gate with a
    // 120 ms release takes ~440 ms just to decide to close, and then another 120 ms time constant to actually
    // get down, so a half-second quiet section never gets quiet and the measurement read 0.0 dB of attenuation
    // on a gate that was working perfectly. The window has to be longer than the thing being measured.
    const seg = Math.floor(sampleRate * 1.5);
    const long = new Float64Array(seg * 3);
    const tone = logSweep({ f1: 100, f2: 4000, sampleRate, seconds: 1.5, amplitude: 0.4 });
    for (let i = 0; i < seg; i++) {
      long[i] = tone[i];                    // loud
      long[seg + i] = tone[i] * 0.002;      // -54 dB: below a -40 dB threshold
      long[2 * seg + i] = tone[i];          // loud again
    }
    const stereoLong = new Float32Array(long.length * 2);
    for (let i = 0; i < long.length; i++) { stereoLong[i * 2] = long[i]; stereoLong[i * 2 + 1] = long[i]; }
    const longPath = join(work, 'gate-dry.mraw');
    writeMraw(longPath, sampleRate, 2, stereoLong);
    const outPath = join(work, 'gate-out.mraw');
    const thresholdDb = -40;
    const run = spawnSync(bin, ['--in', longPath, '--out', outPath, '--blocksize', '64',
      '--param', `${paramId('gate')}=${thresholdDb}`], { encoding: 'utf8' });
    if (run.status !== 0) {
      console.error(`[amp-chain] x the gate render failed:\n${(run.stderr || '').slice(-1000)}`);
      process.exit(1);
    }
    const actual = readMraw(outPath).data[0];
    // Compared over the SETTLED part of each section: the gate's release is 120 ms, so the first tenth of a
    // section is the transition rather than the state.
    const section = (x, n) => x.subarray(n * seg + Math.floor(seg * 0.7), (n + 1) * seg);
    // ⚠️ THE LEVEL CHANGE, NOT THE NULL DEPTH. `compareToReference` measures how SIMILAR two signals are, so a
    // gate that closes completely makes the output maximally DIFFERENT from the dry signal and reads as 0 dB —
    // which is how a working gate measured as doing nothing. What a gate does to a section is a level, so the
    // number here is a level: 20·log10(out/in).
    const levelDb = (n) => 20 * Math.log10(rms(section(actual, n)) / rms(section(long, n)));
    const loudChangeDb = levelDb(2);
    const quietChangeDb = levelDb(1);
    // ⚠️ MEASURED RELATIVE TO THE LOUD SECTION, not against the dry signal. Everything else in the chain
    // changes the level — a cabinet does, and so does a tone setting — so an absolute comparison reports the
    // SPEAKER as a gate failure. What is the gate's is the difference between how much the quiet part moved
    // and how much the loud part did. Found by running this with a cabinet in the chain, where the loud
    // section read +21 dB — back when a cabinet was peak-normalised and really did add that much — and the
    // check called a working gate a volume control. The cabinet is level-matched now (see lib/cabIr.js), so
    // that particular number is gone, but the reason the comparison is RELATIVE has not changed: any stage
    // with gain in it moves the loud section, and the gate's job is the difference between the two sections.
    gateRow = { thresholdDb, loudChangeDb, quietChangeDb, relativeDb: quietChangeDb - loudChangeDb };
  }
  return { rows, cabRow, gateRow, sampleRate, frames: dry.length, settledFrom: from };
}

/**
 * ⭐ THE BLOCKS' ON/OFF SWITCHES, PROVEN AS AUDIO RATHER THAN AS TEXT.
 *
 * WHAT THIS EXISTS FOR. On/off used to be a BUILD decision — a block that was switched off emitted no DSP at
 * all — and it is a runtime parameter now, so the block's code is always emitted and a crossfade is what makes
 * it inert. That is a much easier thing to get subtly wrong, and every wrong version of it still BUILDS and
 * still SOUNDS like a plugin:
 *
 *   • a switch that does nothing (`if (on)` instead of a blend) — the control moves, the host stores it, the
 *     audio never changes, and every default is untouched so every other null still lands where it did;
 *   • a bypass that is a hard cut rather than a fade — audible as a click, which no null test can see;
 *   • a blend that is not exactly `dry` at zero — a switched-off block that colours the sound very slightly,
 *     which is the worst version, because it sounds almost right.
 *
 * So the comparison is between three builds of the SAME block, and it is a bit-exact one:
 *
 *   off      the block is in the board and its own switch is OFF (the saved default)
 *   gone     a different plugin, with no such block at all
 *   on       the block is in the board and engaged
 *
 * `off` must be IDENTICAL to `gone` — a switched-off block is a true bypass, not a quiet one — and `on` must
 * NOT be, or the switch is going nowhere. The drive and the delay are the two shapes worth proving: one is a
 * handful of arithmetic on the sample, the other holds state across samples and allocates.
 *
 * Returns the rows rather than asserting them, so the caller decides what is good enough.
 */
export function toggleCheck({ work, clapInclude = null, sampleRate = 48000, seconds = 0.5 }) {
  mkdirSync(work, { recursive: true });
  const clap = clapInclude || clapIncludes();
  const dry = withFades(logSweep({ f1: 40, f2: 10000, sampleRate, seconds, amplitude: 0.25 }), { samples: 64 });
  const stereo = new Float32Array(dry.length * 2);
  for (let i = 0; i < dry.length; i++) { stereo[i * 2] = dry[i]; stereo[i * 2 + 1] = dry[i]; }
  const dryPath = join(work, 'dry.mraw');
  writeMraw(dryPath, sampleRate, 2, stereo);

  const itemsFor = (kind, enabled) => [
    { instanceId: 1, kind: 'input', enabled: true, values: {} },
    ...(kind ? [{ instanceId: 2, kind, enabled, values: {} }] : []),
    // The output is pinned last and cannot be switched off — see board.js. It is only here so the plugin has
    // a chain the generator will emit at all.
    { instanceId: 9, kind: 'output', enabled: true, values: {} },
  ];

  const renderBoard = (label, items) => {
    const dir = join(work, label);
    const seed = [
      { path: 'README.md', content: '# toggle check\n' },
      { path: 'morpheus.plugin.json', content: JSON.stringify({ name: 'Toggle', board: { nextInstanceId: 99, items } }) },
    ];
    const { files } = scaffoldPlugin(seed);
    for (const f of files) {
      const dest = join(dir, f.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.content);
    }
    const bin = buildHost({ pluginDir: dir, clapInclude: clap, work: dir });
    const outPath = join(work, `out-${label}.mraw`);
    const run = spawnSync(bin, ['--in', dryPath, '--out', outPath, '--blocksize', '64'], { encoding: 'utf8' });
    if (run.status !== 0) {
      console.error(`[amp-chain] x the toggle render failed for "${label}":\n${(run.stderr || '').slice(-1000)}`);
      process.exit(1);
    }
    return readMraw(outPath).data[0];
  };

  const rows = [];
  for (const kind of ['drive', 'delay']) {
    const off = renderBoard(`${kind}-off`, itemsFor(kind, false));
    const gone = renderBoard(`${kind}-gone`, itemsFor(null, false));
    const on = renderBoard(`${kind}-on`, itemsFor(kind, true));
    rows.push({
      kind,
      // The block's own switch at its saved default must be the plugin WITHOUT it, sample for sample.
      offVsRemoved: compareToReference(gone, off),
      // …and engaged it must actually be doing something, or the switch is a control that goes nowhere.
      onVsRemoved: compareToReference(gone, on),
    });
  }
  return { rows, sampleRate, frames: dry.length };
}

/**
 * THE CHAIN ORDER AS DATA — saved, loaded, and HEARD.
 *
 * ⭐ WHY THIS EXISTS. "The order is a value now" is a claim about the plugin's behaviour, and every other proof
 * in this file renders the DEFAULT order — so all of them would still pass if the order table were ignored
 * completely. This is the one that cannot: it loads a different order through CLAP's state extension and
 * asserts the render CHANGES, then saves it back and asserts the bytes round-trip.
 *
 * ⚠️ THE DRIVE IS WHAT MAKES A REORDER AUDIBLE, and that is not a detail — a tone stack and a delay are both
 * linear and time invariant, so they COMMUTE and swapping them changes nothing any null test can see. The
 * drive's clipper is the nonlinearity that makes "before" and "after" two different sounds, so the permutation
 * swapped here is the delay and the drive, not two filters.
 */
export function orderCheck({ work, clapInclude = null, sampleRate = 48000, seconds = 0.5 }) {
  mkdirSync(work, { recursive: true });
  const clap = clapInclude || clapIncludes();
  const dry = withFades(logSweep({ f1: 40, f2: 10000, sampleRate, seconds, amplitude: 0.25 }), { samples: 64 });
  const stereo = new Float32Array(dry.length * 2);
  for (let i = 0; i < dry.length; i++) { stereo[i * 2] = dry[i]; stereo[i * 2 + 1] = dry[i]; }
  const dryPath = join(work, 'dry-order.mraw');
  writeMraw(dryPath, sampleRate, 2, stereo);

  // ⚠️ THE BOARD HAS A MODEL, AND IT IS THERE FOR THE PIVOT. Without a pinned block, the "refuses to move the
  // amp" half of this proof would have nothing to refuse — and a rule with no case that exercises it is a rule
  // nobody has tested. It needs no `.nam`: the model STAGE is in the chain whether or not a capture is
  // embedded, and the pivot is about that stage's POSITION.
  const items = [
    { instanceId: 1, kind: 'input', enabled: true, values: {} },
    { instanceId: 2, kind: 'drive', enabled: true, values: {} },
    { instanceId: 3, kind: 'model', enabled: true, values: {} },
    { instanceId: 4, kind: 'delay', enabled: true, values: { delay_mix: 60, delay_feedback: 40 } },
    { instanceId: 5, kind: 'output', enabled: true, values: {} },
  ];
  const dir = join(work, 'order');
  const { files } = scaffoldPlugin([
    { path: 'README.md', content: '# order check\n' },
    { path: 'morpheus.plugin.json', content: JSON.stringify({ name: 'Order', board: { nextInstanceId: 99, items } }) },
  ]);
  for (const f of files) {
    const dest = join(dir, f.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.content);
  }
  const src = files.find((f) => f.path === 'Source/Plugin.cpp').content;
  const bin = buildHost({ pluginDir: dir, clapInclude: clap, work: dir });

  // THE STAGE IDS COME FROM THE PLUGIN'S OWN TABLE, never from a guess about what the generator emitted: an
  // order addresses stages BY ID, so a test that invented the ids would be testing its own arithmetic.
  const ids = (/#define MORPHEUS_NUM_STAGES \d+\nenum \{\n([\s\S]*?)\n\};/.exec(src)?.[1] || '')
    .split(',').map((l) => l.trim()).filter(Boolean).map((l) => l.split('=')[0].trim());
  const kinds = (src.match(/static const char \*const kMorpheusStageKinds\[MORPHEUS_NUM_STAGES\] = \{([\s\S]*?)\};/)?.[1] || '')
    .split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);

  const render = (label, statePath = null, savePath = null) => {
    const outPath = join(work, `order-${label}.mraw`);
    const args = ['--in', dryPath, '--out', outPath, '--blocksize', '64'];
    if (statePath) args.push('--load-state', statePath);
    if (savePath) args.push('--save-state', savePath);
    const run = spawnSync(bin, args, { encoding: 'utf8' });
    if (run.status !== 0) {
      console.error(`[amp-chain] x the order render failed for "${label}":\n${(run.stderr || '').slice(-1000)}`);
      process.exit(1);
    }
    return readMraw(outPath).data[0];
  };

  // The state blob, built HERE rather than by the plugin — see Source/Plugin.cpp for the format: a magic, a
  // version, a count, then one byte per stage. Writing it by hand is the point: a plugin that only ever read
  // its own output would round-trip a bug perfectly.
  const blobFor = (permutation) => {
    const b = Buffer.alloc(12 + permutation.length);
    b.writeUInt32LE(0x4D4F5250, 0);
    b.writeUInt32LE(1, 4);
    b.writeUInt32LE(permutation.length, 8);
    Buffer.from(permutation).copy(b, 12);
    return b;
  };

  // ⭐ THE PANEL'S OWN DOOR, and it is a different door from `--load-state`: this calls the function a DRAG
  // calls. A refusal is a RESULT here rather than an error — the plugin answers in the JSON, because a test
  // that asserts a refusal has to be able to see one.
  const orderRun = (label, order) => {
    const outPath = join(work, `order-${label}.mraw`);
    const run = spawnSync(bin, ['--in', dryPath, '--out', outPath, '--blocksize', '64', '--set-order', order.join(',')], { encoding: 'utf8' });
    if (run.status !== 0) {
      console.error(`[amp-chain] x the order render failed for "${label}":\n${(run.stderr || '').slice(-800)}`);
      process.exit(1);
    }
    // ⚠️ THE LAST JSON LINE, NOT THE FIRST. The host reports the plugin's DESCRIPTOR as JSON before it renders
    // anything, so taking the first one reads the descriptor and finds no verdict in it — which looks exactly
    // like a refusal. That mistake is already recorded in this repo against the test bench, which is why it is
    // spelled out here: the host's last object is the report.
    const line = (run.stdout || '').split('\n').filter((l) => l.trim().startsWith('{')).pop();
    return { data: readMraw(outPath).data[0], accepted: line ? JSON.parse(line).orderAccepted === true : null };
  };

  const identity = ids.map((_, i) => i);
  const driveAt = kinds.indexOf('drive');
  const delayAt = kinds.indexOf('delay');
  const swapped = identity.slice();
  swapped[driveAt] = identity[delayAt];
  swapped[delayAt] = identity[driveAt];

  const defaultRender = render('default');
  const savedDefault = join(work, 'state-default.bin');
  render('default-save', null, savedDefault);

  const swapPath = join(work, 'state-swap.bin');
  writeFileSync(swapPath, blobFor(swapped));
  const permutedRender = render('permuted', swapPath);

  const savedAfter = join(work, 'state-after.bin');
  render('permuted-save', swapPath, savedAfter);

  // A DUPLICATE IS NOT A PERMUTATION, and the plugin must refuse it rather than run one block twice and drop
  // another — a wrong SOUND with no error is what a corrupted file would otherwise produce. The blob is the
  // length of THIS chain, because a wrong length is refused earlier and would exercise a different check.
  const badOrder = identity.slice();
  badOrder[1] = badOrder[0];
  const badPath = join(work, 'state-bad.bin');
  writeFileSync(badPath, blobFor(badOrder));
  const badRun = spawnSync(bin, ['--in', dryPath, '--out', join(work, 'order-bad.mraw'), '--load-state', badPath], { encoding: 'utf8' });

  // ⭐ AND THE PIVOT, AS BEHAVIOUR RATHER THAN AS TEXT. These two ask the plugin the question a MOUSE would:
  // one reorders two movable blocks, and one swaps the amp model with the delay — a legal PERMUTATION and an
  // illegal rearrangement of the amplifier. Rob's decision: "amp and cab pivot point".
  const legal = orderRun('drag-legal', swapped);
  const modelAt = kinds.indexOf('model');
  const pivotMoved = identity.slice();
  pivotMoved[modelAt] = identity[modelAt + 1];
  pivotMoved[modelAt + 1] = identity[modelAt];
  const illegal = orderRun('drag-pivot', pivotMoved);

  return {
    ids, kinds, identity, swapped, pivotMoved,
    // The compiled default, saved: it must be the identity, not a special case that only works when unset.
    defaultSavedIsIdentity: readFileSync(savedDefault).equals(blobFor(identity)),
    // The reorder has to CHANGE the sound, or the order is a table nobody walks.
    reorderChangesTheSound: compareToReference(defaultRender, permutedRender),
    // …and it has to survive a save/load cycle EXACTLY.
    roundTrip: readFileSync(savedAfter).equals(blobFor(swapped)),
    malformedRefused: badRun.status !== 0,
    // ⚠️ THE SECOND HALF OF EACH IS THE ONE THAT MATTERS. "It returned false" is not enough: a plugin that
    // refuses a pivot move and applies it anyway is worse than one that accepts, because the refusal is what
    // the panel draws and the sound would contradict it.
    drag: { accepted: legal.accepted, unchanged: compareToReference(defaultRender, legal.data).identical },
    pivot: { accepted: illegal.accepted, unchanged: compareToReference(defaultRender, illegal.data).identical },
    sampleRate, frames: dry.length,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────
function arg(name, fallback = null) {
  const at = process.argv.indexOf(`--${name}`);
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const pluginDir = arg('plugin');
  const work = arg('work', join(ROOT, '.cache', 'amp-chain'));
  // ── the blocks' switches, which scaffold their own projects and need no prebuilt plugin ────────────────
  if (process.argv.includes('--toggle')) {
    const t = toggleCheck({
      work: join(work, 'toggle'),
      clapInclude: arg('clap-include'),
      seconds: Number(arg('seconds', '0.5')),
    });
    const f = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} dB` : 'identical');
    console.log('[amp-chain] the blocks\' own On/Off switches, as audio:');
    let bad = 0;
    for (const row of t.rows) {
      console.log(`[amp-chain]   ${row.kind.padEnd(6)} off vs the block removed: ${f(row.offVsRemoved.nullDb).padStart(13)}   engaged vs removed: ${f(row.onVsRemoved.nullDb)}`);
      // A SWITCHED-OFF BLOCK MUST BE ITS OWN BYPASS, exactly — not close, not -200 dB, the same samples.
      if (!(row.offVsRemoved.identical || row.offVsRemoved.nullDb <= -200)) {
        console.error(`[amp-chain] x a ${row.kind} switched off is not the plugin without it (${f(row.offVsRemoved.nullDb)})`);
        bad++;
      }
      // …AND AN ENGAGED ONE MUST ACTUALLY DO SOMETHING, or the switch is a control that goes nowhere.
      if (row.onVsRemoved.identical || !(row.onVsRemoved.nullDb > -60)) {
        console.error(`[amp-chain] x a ${row.kind} switched on changes nothing (${f(row.onVsRemoved.nullDb)})`);
        bad++;
      }
    }
    console.log(JSON.stringify({ ok: bad === 0, ...t }));
    if (bad) process.exit(1);
    console.log('[amp-chain] every block\'s switch is a true bypass, and every switch does something\n');
    process.exit(0);
  }
  // ── the chain order as data: saved, loaded and heard ───────────────────────────────────────────────────
  if (process.argv.includes('--order')) {
    const o = orderCheck({ work: join(work, 'order'), clapInclude: arg('clap-include'), seconds: Number(arg('seconds', '0.5')) });
    console.log('[amp-chain] the chain order, as data — saved, loaded, and heard:');
    console.log(`[amp-chain]   stages          ${o.kinds.join(' · ')}`);
    console.log(`[amp-chain]   default order   ${o.identity.join(',')}`);
    console.log(`[amp-chain]   loaded order    ${o.swapped.join(',')}  (delay and drive exchanged)`);
    const f = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} dB` : 'identical');
    console.log(`[amp-chain]   a saved default IS the identity order:   ${o.defaultSavedIsIdentity ? 'yes' : 'NO'}`);
    console.log(`[amp-chain]   the reorder changes the sound by:        ${f(o.reorderChangesTheSound.nullDb)}`);
    console.log(`[amp-chain]   the loaded order saves back byte for byte: ${o.roundTrip ? 'yes' : 'NO'}`);
    console.log(`[amp-chain]   a malformed order is refused, not applied:  ${o.malformedRefused ? 'yes' : 'NO'}`);
    console.log(`[amp-chain]   a DRAG is accepted, and heard:             ${o.drag.accepted ? 'accepted' : 'REFUSED'}, ${o.drag.unchanged ? 'BUT CHANGED NOTHING' : `moved the sound by ${o.reorderChangesTheSound.nullDb === null ? 'a different amount' : `${(o.reorderChangesTheSound.nullDb).toFixed(1)} dB`}`}`);
    console.log(`[amp-chain]   a drag that moves the AMP is refused:      ${o.pivot.accepted ? 'ACCEPTED' : 'refused'}, and left the sound ${o.pivot.unchanged ? 'exactly as it was' : 'CHANGED'}`);
    console.log(JSON.stringify({
      ok: o.defaultSavedIsIdentity && o.roundTrip && o.malformedRefused && !o.reorderChangesTheSound.identical
        && o.drag.accepted && !o.drag.unchanged && !o.pivot.accepted && o.pivot.unchanged,
      ...o,
    }));
    let bad = 0;
    if (!o.defaultSavedIsIdentity) { console.error('[amp-chain] x a fresh plugin does not save the compiled order'); bad++; }
    if (o.reorderChangesTheSound.identical) { console.error('[amp-chain] x a loaded order changed nothing — the order is a table nobody walks'); bad++; }
    if (!o.roundTrip) { console.error('[amp-chain] x the order did not survive a save/load cycle'); bad++; }
    if (!o.malformedRefused) { console.error('[amp-chain] x a malformed order was applied instead of refused'); bad++; }
    // ⭐ THE PANEL'S OWN DOOR. A drag has to be accepted AND heard; a drag that moves the pivot has to be
    // refused AND leave the sound untouched — the refusal is what the panel draws, so a plugin that refused and
    // applied it anyway would put the panel and the audio in disagreement with no error anywhere.
    if (!o.drag.accepted) { console.error('[amp-chain] x a legal drag was refused'); bad++; }
    if (o.drag.unchanged) { console.error('[amp-chain] x a legal drag was accepted and changed nothing'); bad++; }
    if (o.pivot.accepted) { console.error('[amp-chain] x a drag that moves the amp model or the cabinet was ACCEPTED'); bad++; }
    if (!o.pivot.unchanged) { console.error('[amp-chain] x a refused drag changed the sound anyway'); bad++; }
    if (bad) process.exit(1);
    console.log('[amp-chain] the order is data: it saves, it loads, it is heard, a bad one is refused, and the pivot does not move\n');
    process.exit(0);
  }
  if (!pluginDir) { console.error('[amp-chain] --plugin is required (or --toggle/--order, which need no plugin)'); process.exit(2); }
  const maxNullDb = Number(arg('max-null-db', '-120'));
  const r = ampChainCheck({
    pluginDir,
    clapInclude: arg('clap-include'),
    work,
    seconds: Number(arg('seconds', '0.5')),
    cab: arg('cab'),
    gateCase: process.argv.includes('--gate'),
  });
  console.log('[amp-chain] plugin vs the JS design, over the settled tail:');
  let worst = -Infinity;
  for (const row of r.rows) {
    const v = Number.isFinite(row.null.nullDb) ? row.null.nullDb : -Infinity;
    if (v > worst) worst = v;
    const d = row.designDb;
    console.log(`[amp-chain]   ${row.label.padEnd(11)} ${(Number.isFinite(row.null.nullDb) ? `${row.null.nullDb.toFixed(1)} dB` : 'identical').padStart(13)}   design: 50Hz ${d[50].toFixed(2)} · 800Hz ${d[800].toFixed(2)} · 6kHz ${d[6000].toFixed(2)} dB`);
  }
  if (r.gateRow) {
    const f = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} dB` : 'identical');
    console.log(`[amp-chain]   ${'gate'.padEnd(11)} at ${r.gateRow.thresholdDb} dB: the quiet section is ${f(r.gateRow.relativeDb)} below the loud one (loud moved ${f(r.gateRow.loudChangeDb)}, the chain's own level)`);
    // ⚠️ AND THE ABSOLUTE LEVELS ARE NOT ASSERTED, only the difference. A chain with a cabinet in it moves the
    // loud section at all (a cabinet is level-matched now, but a tone setting or a drive is not), which says
    // nothing about the gate — asserting on it was this check calling a speaker a volume control.
    if (!(r.gateRow.relativeDb < -20)) {
      console.error(`[amp-chain] x the gate did not close on the quiet section (${f(r.gateRow.relativeDb)} below the loud one)`);
      process.exit(1);
    }
  }
  if (r.cabRow) {
    const f = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} dB` : 'identical');
    console.log(`[amp-chain]   ${'cabinet'.padEnd(11)} ${f(r.cabRow.null.nullDb).padStart(13)}   ${r.cabRow.taps} taps, and it changes the signal by ${f(r.cabRow.changedDb)}`);
    worst = Math.max(worst, Number.isFinite(r.cabRow.null.nullDb) ? r.cabRow.null.nullDb : -Infinity);
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
