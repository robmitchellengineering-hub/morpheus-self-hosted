// Did the coder honour the existing-implementation pre-flight?
//
// WHY THIS EXISTS
//
// chatWithMorpheus runs a pre-flight before the coder writes: it asks the planner
// whether any planned-new file is a job the repo already does, and appends a
// `DO NOT REINVENT` block naming the existing module. That block is ADVICE, and
// the pipeline recorded nothing about whether the advice was taken.
//
// Proved by experiment on 2026-09-24/25 (the model/temperature A/B): on an
// identical task the v4-pro coder called the existing drift machinery, while the
// flash coder re-implemented it — `createHash` for git blob hashing and direct
// `synced_sha` reads — *while naming the existing module in its own comment*.
// Both passed all three CI gates and both reported `rework: 0/0/0/0`. The gates
// ask whether the new code works; none of them asks whether it should exist.
//
// WHAT THIS IS, AND WHAT IT IS NOT
//
// This is the cheap half: a deterministic, zero-token detector that answers "the
// pre-flight named an existing module for a file, and the coder created that file
// without importing it". It is recorded, not enforced — it is a measurement, and
// the run record is where it becomes visible.
//
// It is deliberately NOT the name-overlap check ("flag a new module whose
// distinctive name tokens sit inside an existing module's"). That was measured
// against the real tree before being built and is unusable: 595 files give 158
// subset-overlap pairs, because this repo deliberately names a guard after the
// module it guards (`verify-prose-ink.mjs` / `lib/proseInk.js`). The naming
// carries no information about duplication.
//
// A real content-level gate ("does this new module re-implement something the
// existing one already exports") is a harder and different problem than this one.
//
// WHY COMMENTS ARE MASKED
//
// The flash case named the module it duplicated in a comment. A detector that
// greps for the module's name would have called that a pass — the exact way the
// first version of verify-reuse-preflight.mjs matched its own explanatory prose.
// Only an import counts as use here; a mention is prose.
//
// Pure: imports nothing, reads no files, does no I/O, no network. That is what
// lets it run inside the API container and in CI's no-install job.

const CODE_EXT = /\.(jsx?|tsx?|mjs|cjs)$/i;

// `from '…'` covers `import … from`, `export … from`; the call forms cover
// `import('…')` and `require('…')`. A bare `import '…'` (side-effect only) is
// matched separately because it has no `from`.
const FROM_SPEC = /\bfrom\s*['"]([^'"]+)['"]/g;
const CALL_SPEC = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g;
const BARE_SPEC = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;

/** Path normalised for comparison: no `./`, one kind of slash. */
function normalise(p) {
  return String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

/**
 * Blank the interior of every comment, keeping newlines and offsets.
 *
 * Deliberately NOT lib/proseInk.js's `maskSource`: that one is JSX-aware but also
 * blanks REGEX LITERALS, and a regex literal is exactly what a path looks like —
 * `require('../lib/drift.js')` came back as `require('..     drift.js')`, which
 * silently broke basename matching on the first version of this module. This
 * scanner only ever blanks comments, and it tracks string/template literals so a
 * `//` inside one is not mistaken for a comment.
 */
function maskComments(src) {
  const out = [...src];
  const blank = (i) => { if (out[i] !== '\n') out[i] = ' '; };
  let mode = 'code'; // code | line | block | ' | " | `
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; blank(i); blank(i + 1); i += 2; continue; }
      if (c === '/' && d === '*') { mode = 'block'; blank(i); blank(i + 1); i += 2; continue; }
      if (c === "'") mode = "'";
      else if (c === '"') mode = '"';
      else if (c === '`') mode = '`';
      i++; continue;
    }
    if (mode === 'line') { if (c === '\n') mode = 'code'; else blank(i); i++; continue; }
    if (mode === 'block') {
      if (c === '*' && d === '/') { blank(i); blank(i + 1); i += 2; mode = 'code'; continue; }
      blank(i); i++; continue;
    }
    // Inside a string or template — copied through, escapes honoured.
    if (c === '\\') { i += 2; continue; }
    if (c === mode) mode = 'code';
    i++;
  }
  return out.join('');
}

/**
 * A module's identity for comparison: its basename without a code extension.
 *
 * Basenames, not resolved paths, on purpose. The coder writes `./drift.js`,
 * `../lib/drift.js` or `@/lib/drift.js` for the same module, and resolving every
 * alias correctly is a job the bundler already does. The trade is stated rather
 * than hidden: two different files with the same basename compare equal, so this
 * errs toward NOT flagging (a miss, not a false accusation).
 */
export function moduleStem(spec) {
  const clean = String(spec ?? '').split(/[?#]/)[0].trim();
  const base = clean.split('/').pop() || '';
  return base.replace(CODE_EXT, '');
}

/** Every local-or-bare import specifier in a source file, comments masked out. */
export function importedSpecifiers(source) {
  if (typeof source !== 'string' || !source) return [];
  const masked = maskComments(source);
  const out = [];
  for (const re of [FROM_SPEC, CALL_SPEC, BARE_SPEC]) {
    for (const m of masked.matchAll(re)) out.push(m[1]);
  }
  return out;
}

/** Does this source import the module at `existing` (by basename)? */
export function usesExisting(source, existing) {
  const want = moduleStem(existing);
  if (!want) return false;
  return importedSpecifiers(source).some((s) => moduleStem(s) === want);
}

/**
 * The pre-flight matches this change ignored.
 *
 * @param {{path:string, content:string}[]} changedFiles  files the turn wrote (content only)
 * @param {{planned:string, existing:string, why?:string}[]} matches  the pre-flight's answer
 * @returns {{phase:string, file:string, line:null, text:string}[]}  one entry per ignored match
 */
export function reuseMisses(changedFiles, matches) {
  const files = (Array.isArray(changedFiles) ? changedFiles : [])
    .filter((f) => f && typeof f.path === 'string' && typeof f.content === 'string');
  const named = Array.isArray(matches) ? matches : [];
  if (files.length === 0 || named.length === 0) return [];

  const out = [];
  const seen = new Set();
  for (const m of named) {
    const planned = normalise(m?.planned);
    const existing = normalise(m?.existing);
    if (!planned || !existing) continue;

    // The plan's new file, as the coder actually wrote it. If it was never
    // created, nothing was reinvented — that is the pro-coder outcome, and it is
    // also what happens when the coder correctly chose to extend the existing
    // module instead.
    const created = files.find((f) => normalise(f.path) === planned);
    if (!created) continue;

    // An import of the named module is the behaviour the pre-flight asked for.
    if (usesExisting(created.content, existing)) continue;

    if (seen.has(planned)) continue;
    seen.add(planned);
    out.push({
      phase: 'reuse',
      file: created.path,
      line: null,
      text: `created ${created.path} without importing ${existing}`
        + `${m.why ? ` (${m.why})` : ''} — the existing-implementation pre-flight named ${existing} as already doing this job`,
    });
  }
  return out;
}
