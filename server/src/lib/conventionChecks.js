// House conventions, checked in-loop instead of by a red CI gate.
//
// WHY THIS EXISTS
//
// The build turn verified syntax, bundling and cross-file exports — nothing else.
// The gate that decides whether a change actually lands runs 33 guards on top of
// that, so a change could pass every in-loop check and fail CI on a house rule.
// That is exactly what happened: three consecutive self-dev changes reported
// `rework: {syntax:0, bundle:0, reviewer:0}` and then failed CI on one step,
// `prose-ink rule`. The loop was honest and blind at the same time.
//
// The fix is to run the rules the gate enforces inside the turn, where the model
// can still see them, fix them and re-check — no red run, no extra pull request,
// no operator reading logs.
//
// WHY IT READS THE RULE FROM server/src/lib AND NOT FROM scripts/
//
// scripts/ is inside the AI-editable self-dev workspace. Running the workspace's
// copy of a guard would mean executing model-written code inside the API container,
// which holds DATABASE_URL, ENCRYPTION_KEY and the GitHub token. This module is the
// server's own trusted copy, and scripts/lib/*.mjs re-export from it, so there is
// still exactly ONE definition of each rule — a second copy would be a rule that
// drifts from the one CI enforces.
//
// Pure: imports only sibling pure modules, reads no files, does no I/O, no network.

import { scanLadder } from './inkLadder.js';
import { maskSource, isDeckFile } from './proseInk.js';

// An ink token carrying an opacity modifier — `text-ink/60`, `hover:text-ink-strong/50`.
// Lives here rather than in the guard so the guard and this check cannot disagree
// about what the rule is.
export const OPACITY_INK = /text-ink(?:-strong|-max)?\/\d+/g;

const lineAt = (src, index) => src.slice(0, index).split('\n').length;

/**
 * The ink ladder, over a project's own source.
 *
 * Scoped exactly as scripts/verify-prose-ink.mjs scopes it: `src/**` JSX/JS, with
 * the Command Deck excluded because it is deliberately its own theme. If those
 * scopes ever diverge, the loop and the gate disagree and one of them is wrong.
 *
 * @param {{path: string, content: string}[]} files
 * @returns {{phase: string, file: string, line: number, text: string}[]}
 */
export function inkViolations(files) {
  const out = [];
  for (const f of Array.isArray(files) ? files : []) {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') continue;
    if (!/^src\/.*\.(jsx|js)$/.test(f.path)) continue;
    if (isDeckFile(f.path)) continue;
    const src = f.content;

    // The size of the text decides the rung. `o.to` is what the resolved size
    // requires; anything else is the violation this whole path exists to catch.
    for (const o of scanLadder(src).occurrences) {
      if (o.token === o.to) continue;
      const size = o.px === null ? 'no size of its own, so it takes the floor' : `${o.px}px`;
      out.push({
        phase: 'convention:ink-band',
        file: f.path,
        line: lineAt(src, o.offset),
        text: `<${o.tag}> uses ${o.token}, but its text resolves to ${size}, which requires ${o.to}`,
      });
    }

    // A comment may document the rule (`text-ink/60` in src/index.css is prose,
    // not a violation), so comments are masked — the same exemption the guard makes.
    const commentMasked = maskSource(src, { commentsOnly: true });
    for (const m of src.matchAll(OPACITY_INK)) {
      if (commentMasked[m.index] === ' ' && src[m.index] !== ' ') continue;
      out.push({
        phase: 'convention:ink-opacity',
        file: f.path,
        line: lineAt(src, m.index),
        text: `an ink token never takes an opacity modifier — "${m[0]}". Dim prose with the rung, not with opacity.`,
      });
    }
  }
  return out;
}

/** Named checks a caller can ask for, so a target can enable only what applies. */
export const CONVENTION_CHECKS = { ink: inkViolations };

/**
 * Run the named convention checks over a file set.
 *
 * @param {{path: string, content: string}[]} files
 * @param {string[]} checks  names from CONVENTION_CHECKS; unknown names are ignored
 * @returns {{phase: string, file: string, line: number, text: string}[]}
 */
export function conventionViolations(files, checks) {
  const out = [];
  for (const name of Array.isArray(checks) ? checks : []) {
    const fn = CONVENTION_CHECKS[name];
    if (fn) out.push(...fn(files));
  }
  return out;
}
