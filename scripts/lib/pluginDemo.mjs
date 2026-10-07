// What the free download IS — the manifest the three runner builds seed, in one place.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────────────────────────────────
// The demo manifest used to be written out three times, once per runner script, each saying
// `chain: 'amp'`. Three copies of one decision is three chances to publish three different products under one
// release tag, and it had already happened once in the other direction: macOS and Windows were fixed to carry
// the model (#552) while Linux kept publishing the single-Gain plugin because its copy of the line was in a
// different branch of the script. The release page described all three as "a neural amp model with an input
// trim, a gate and a three-band tone stack" while one of them had one `Gain` knob.
//
// So the manifest is BUILT here, from the board registry, and the scripts seed what this returns.
//
// ⚠️ AND THE BOARD IS THE PRODUCT, NOT THE AMP CHAIN. `chain: 'amp'` is four blocks — trim, gate, tone stack,
// output — and a demo made of four blocks is a demo of an amplifier, not of what Morpheus makes. The board
// carries the drive, the delay and the spring reverb as well, which is the difference between a demo that
// sounds like a DI box and one that sounds like a rig.
//
// ⚠️ AND THE RIG IS THE DEMO'S MATERIAL, NOT ONE CAPTURE OF IT. The build used to carry a single MIT example
// model from NeuralAmpModelerCore and no cabinet at all, because no impulse response could be redistributed.
// That is no longer the shape of the product: the project owner captured his own Marshall JCM 800 2203 in four
// states — crunch, crunch without the pre-amp bass cut, and the high-gain front end with a Tube Screamer and
// with a RAT — through one Marshall G12M 4x12, close-mic'd four ways. He owns those files and has said to ship
// them, so the demo is now that rig: FOUR captures and FOUR impulse responses, switchable in the panel. The
// files live in `assets/demo-rig/` so a runner can build them offline, and they are copied byte for byte — a
// re-encoded `.wav` would make every measurement about this rig describe something else.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { demoBoard, boardJson } from '../../server/src/lib/board.js';

/** The demo board, as the manifest's `board` value. Exported so a guard can assert it without a build. */
export const DEMO_BOARD = demoBoard();

/** The blocks the published demo is made of, in signal order. Named so a failure can say what changed. */
export const DEMO_BLOCKS = DEMO_BOARD.items.map((i) => i.kind);

/** Where the rig's captures live in THIS repository. A runner reads them from here; nothing is downloaded. */
export const DEMO_RIG_DIR = 'assets/demo-rig';

/**
 * The four states of the one amplifier, in the order the selector offers them.
 *
 * `file` is the capture's own filename — kept exactly, because it is the file the owner named — and `name` is
 * what a player reads on the `Capture` control. ⚠️ THE ORDER IS THE CONTRACT: the selector opens on the FIRST
 * entry, so this list is also the demo's default sound. Crunch first, as the amp's own cleanest state.
 */
export const DEMO_CAPTURES = [
  { file: 'JCM800 2203_ Crunch.nam', name: 'Crunch' },
  { file: 'JCM800 2203_ Crunch 2 (No pre-amp bass cut).nam', name: 'Crunch 2' },
  { file: 'JCM800 2203_ Hi Gain (TS boost).nam', name: 'Hi Gain (TS)' },
  { file: 'JCM800 2203_ Hi Gain (RAT boost).nam', name: 'Hi Gain (RAT)' },
];

/**
 * The four mics on the one cabinet, in the order the `Speaker` control offers them.
 *
 * Same contract as the captures, and ⚠️ **THE ORDER IS THE CONTRACT — the selector opens on the first entry.**
 * U87 is first because **Rob chose the demo's opening sound** (2026-10-08): *"for now just open with the crunch
 * and the u87"*, while he decides a permanent default after more audio tests. That is not a ranking of the
 * mics.
 *
 * ⚠️ ORDERING IS THE ONLY MECHANISM THERE IS. The selector's default is index 0 — `rigSelectors` hardcodes
 * `def: 0` — so choosing which member a plugin OPENS on, independently of the order it lists them in, needs a
 * `default` field the manifest does not have yet. It is a real gap rather than a preference: a rig whose best
 * capture is not its first has no way to say so. Recorded in `PLUGIN-GUI-PLAN.md`.
 *
 * `name` is the short label a player reads rather than the microphone's own filename.
 */
export const DEMO_MICS = [
  { file: 'TF MARSH 4x12 G12M 8ohm U87 3 - Top Boost.wav', name: 'U87' },
  { file: 'TF MARSH 4x12 G12M 8ohm 545 3 - Enhanced.wav', name: '545' },
  { file: 'TF MARSH 4x12 G12M 8ohm 017 TUBE 3 - Top Boost.wav', name: '017 Tube' },
  { file: 'TF MARSH 4x12 G12M 8ohm M160 2 - Enhanced.wav', name: 'M160' },
];

/**
 * The rig as the manifest spells it — `{ path, name }`, the escape hatch `rig.js` accepts.
 *
 * ⚠️ THE PATH IS `models/<filename>`, NOT `assets/demo-rig/<filename>`. The path is the one the file has
 * INSIDE the generated plugin project, and `models/` is where both finders look first — the platform that
 * gets this wrong builds a one-capture plugin while the manifest claims four.
 */
export const DEMO_RIG = {
  models: DEMO_CAPTURES.map(({ file, name }) => ({ path: `models/${file}`, name })),
  cabs: DEMO_MICS.map(({ file, name }) => ({ path: `models/${file}`, name })),
};

/** The repository root, so a runner can find the rig without being told where the checkout is. */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The rig's files, as seed entries the scaffold already understands: the `.nam` as its own UTF-8 JSON text,
 * the `.wav` as base64 — the same split every other project file in this repository uses.
 *
 * ⚠️ ONE READER FOR THREE RUNNERS. macOS, Windows and Linux ARM all seed this array; a runner that grew its own
 * copy of the eight filenames is how one platform would ship three captures and call it the demo.
 */
export function demoRigSeed(root = REPO_ROOT) {
  const read = (file) => readFileSync(join(root, DEMO_RIG_DIR, file));
  return [
    ...DEMO_CAPTURES.map(({ file }) => ({ path: `models/${file}`, content: read(file).toString('utf8') })),
    ...DEMO_MICS.map(({ file }) => ({ path: `models/${file}`, content: read(file).toString('base64'), encoding: 'base64' })),
  ];
}

/**
 * The manifest text a runner build writes before the target scaffolds.
 *
 * `name` is the plugin's name, which for the demo is the product's — a user's own project names itself.
 */
export function demoManifest(name = 'Morpheus Plugin') {
  return `${JSON.stringify({
    name, board: boardJson(DEMO_BOARD), models: DEMO_RIG.models, cabs: DEMO_RIG.cabs,
  }, null, 2)}\n`;
}
