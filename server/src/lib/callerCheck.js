// Does this change break a caller? — answered deterministically, before commit.
//
// WHY THIS EXISTS
//
// KNOWN-HAZARDS.md H1 is the incident this repo has actually suffered: a change reshaped
// `server/src/lib/github.js` and every other importer died at import time with "does not
// provide an export named X" — undetected until the NEXT compile/deploy hit it, not when it
// was introduced. The same shape recurred on 2026-09-25 in production, when `runAiAction.js`
// imported a name `reviewer.js` never exported.
//
// `findBrokenImports` (lib/importGraph.js) is this repo's own cross-file named-export check,
// and it is exact — pure string analysis, no bundling, no model. It already guards self-dev:
// `chatWithMorpheus.js` runs it inside a deep-verify gate, but that gate is **`isSelfDev`
// only**, because its other half bundles from self-dev-specific entry points. So a regular
// build turn checked each changed file's syntax in isolation and asked the REVIEWER, by
// judgement, whether a caller was broken.
//
// That is the wrong tool for a decidable question. This module runs the caller half on every
// build, over the PROPOSED state, and reports only what the change INTRODUCED — a pre-existing
// broken import is not this turn's problem and must not be blamed on it.
//
// What is deliberately NOT here: auto-fixing. When the broken import is in a file the turn
// never touched, there is nothing to hand the coder a "current content" for, and asking it to
// rewrite a file it was never shown is how a fix pass makes things worse. The deep-verify gate
// already learned that and reports it instead; this does the same.
//
// Pure by design: one sibling import, no I/O, no DB.

import { findBrokenImports, buildReverseImports } from './importGraph.js';

/** The project as it would be if every operation were applied. */
export function applyFileOps(files, fileOps) {
  const byPath = new Map((files || []).map((f) => [f.path, f.content]));
  for (const op of fileOps || []) {
    if (!op || typeof op.path !== 'string') continue;
    if (op.action === 'delete') byPath.delete(op.path);
    else if (typeof op.content === 'string') byPath.set(op.path, op.content);
  }
  return Array.from(byPath, ([path, content]) => ({ path, content }));
}

const keyOf = (b) => `${b.importer}|${b.target}|${b.name}`;

/**
 * Named imports this change breaks, minus any that were already broken.
 *
 * @param {{path: string, content: string}[]} files  the project as it is now
 * @param {{path: string, content?: string, action?: string}[]} fileOps  the proposed change
 * @returns {{importer: string, target: string, name: string, touched: boolean}[]}
 *          `touched` says whether the broken importer is a file this change rewrote — if it
 *          is, the coder still has it in context and a fix attempt is meaningful; if it is
 *          not, the break is reported rather than auto-fixed.
 */
export function findCallerBreaks(files, fileOps) {
  if (!Array.isArray(fileOps) || fileOps.length === 0) return [];
  const before = new Set(findBrokenImports(files || []).map(keyOf));
  const touched = new Set(
    (fileOps || []).filter((op) => op && typeof op.path === 'string').map((op) => op.path)
  );
  const breaks = findBrokenImports(applyFileOps(files, fileOps))
    .filter((b) => !before.has(keyOf(b)))
    .map((b) => ({ ...b, touched: touched.has(b.importer) }));

  // A DELETED module is invisible to findBrokenImports: it only reports a missing NAME on a
  // target that still resolves, and a delete removes the target entirely, so the import is
  // skipped rather than reported. That is a real break — every importer dies at load — so it
  // is derived here from the reverse-import graph instead.
  const rev = buildReverseImports(files || []);
  for (const op of fileOps) {
    if (!op || op.action !== 'delete' || typeof op.path !== 'string') continue;
    for (const caller of rev.get(op.path) || []) {
      if (caller.kind === 'side-effect' || caller.kind === 'dynamic') continue;
      const name = caller.namespace ? '(namespace import)' : (caller.names[0] || '(whole module)');
      breaks.push({ importer: caller.importer, target: op.path, name, touched: touched.has(caller.importer), deleted: true });
    }
  }

  return breaks;
}

/** One line per break, in the shape the chat's critical list already renders. */
export function describeCallerBreaks(breaks) {
  return (breaks || []).map((b) => {
    if (b.deleted) return `${b.target} is deleted, but ${b.importer} still imports it (${b.name})`;
    return b.touched
      ? `${b.importer} imports { ${b.name} } from ${b.target}, which this change no longer exports`
      : `${b.target} no longer exports ${b.name}, but ${b.importer} still imports it`;
  });
}
