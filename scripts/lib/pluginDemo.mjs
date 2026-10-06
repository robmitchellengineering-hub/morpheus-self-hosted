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
import { demoBoard, boardJson } from '../../server/src/lib/board.js';

/** The demo board, as the manifest's `board` value. Exported so a guard can assert it without a build. */
export const DEMO_BOARD = demoBoard();

/** The blocks the published demo is made of, in signal order. Named so a failure can say what changed. */
export const DEMO_BLOCKS = DEMO_BOARD.items.map((i) => i.kind);

/**
 * The manifest text a runner build writes before the target scaffolds.
 *
 * `name` is the plugin's name, which for the demo is the product's — a user's own project names itself.
 */
export function demoManifest(name = 'Morpheus Plugin') {
  return `${JSON.stringify({ name, board: boardJson(DEMO_BOARD) }, null, 2)}\n`;
}
