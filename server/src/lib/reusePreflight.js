// What the existing-implementation pre-flight is SHOWN.
//
// WHY THIS EXISTS
//
// The pre-flight (chatWithMorpheus) asks a model whether any existing file already
// does the job of a file the plan is about to create. It was handed ~907 bare PATHS
// and a strict instruction that naming a wrong file is worse than naming nothing.
//
// Measured 2026-09-25 with the truncation fixed (`edf90bc`..`edf90fc`), n=2 per arm:
// asked for a new `getContainerMemory.js` whose job `server/src/lib/containerMemory.js`
// already does — the least subtle duplication available — it named NOTHING, 4 runs out
// of 4, at both pro @ 0.7 and flash @ 0.4. Meanwhile the coder found and imported the
// right module unaided in all four. So the failure was recall, and the input, not the
// model, was the reason: `containerMemory` next to a planned `getContainerMemory` is
// unmissable; `lib/containerMemory.js` in a list of 907 paths is not.
//
// WHAT THIS DOES
//
// Shortlists, deterministically and for free, the existing files whose NAME or EXPORTED
// SYMBOLS overlap the planned file — then shows the model just those, with their exports.
// An export named `containerMemory` is the signal a path list cannot carry.
//
// Name overlap is used as a RETRIEVER here, not as a verdict, and that distinction is
// the whole reason this is allowed: the same rule was measured and rejected as a gate
// (158 false-positive pairs across the tree, because this repo names a guard after the
// module it guards). A false positive in a shortlist costs the model one line to read;
// a false positive as a verdict sends the coder to the wrong module.
//
// The shortlist is recall-oriented on purpose: a miss here is a silent 0 from the model,
// which is exactly the bug being fixed. Precision is the model's job, and the prompt
// still tells it to omit rather than guess.
//
// Pure: imports only a sibling pure module, reads no files, does no I/O, no network.

import { parseExports } from './importGraph.js';

// Tokens that carry no information about what a file DOES. Without this, every planned
// path would "overlap" a hundred files on `get`/`index`/`src`.
const STOP = new Set([
  'get', 'set', 'list', 'index', 'new', 'the', 'and', 'for', 'from', 'with', 'into',
  'src', 'server', 'lib', 'app', 'api', 'main', 'data', 'util', 'utils', 'helper',
  'helpers', 'types', 'type', 'test', 'tests', 'function', 'functions', 'page', 'pages',
  'component', 'components', 'card', 'cards',
]);

/** The distinctive words in a path's basename: `getContainerMemory.js` -> [container, memory]. */
export function nameTokens(value) {
  return String(value || '')
    .replace(/\.[a-z]+$/i, '')
    .split('/')
    .pop()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

/**
 * Existing files worth showing the model, for the files a plan is about to create.
 *
 * @param {string[]} plannedNew                       paths the plan would CREATE
 * @param {{path:string, content?:string}[]} files    everything the project already has
 * @param {{limit?:number}} [opts]                    cap on the shortlist size
 * @returns {{path:string, symbols:string[], score:number}[]}
 */
export function reuseCandidates(plannedNew, files, { limit = 60 } = {}) {
  const planned = (Array.isArray(plannedNew) ? plannedNew : []).filter((p) => typeof p === 'string' && p.trim());
  const existing = (Array.isArray(files) ? files : []).filter((f) => f && typeof f.path === 'string');
  if (planned.length === 0 || existing.length === 0) return [];

  const plannedTokens = planned.map((p) => new Set(nameTokens(p)));

  const scored = [];
  for (const f of existing) {
    const { names } = parseExports(f.content || '');
    const symbols = [...names];
    // A file is described by its path AND its exports — the export list is the part
    // that says what the file DOES rather than where it lives.
    const fileTokens = new Set([...nameTokens(f.path), ...symbols.flatMap(nameTokens)]);
    let score = 0;
    for (const want of plannedTokens) {
      for (const t of want) if (fileTokens.has(t)) score++;
    }
    if (score > 0) scored.push({ path: f.path, symbols, score });
  }

  scored.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
  return scored.slice(0, Math.max(0, limit));
}

/** The pre-flight prompt, given a shortlist instead of the whole tree. */
export function buildReusePreflightPrompt({ systemPrompt, plannedNew, plan, candidates }) {
  const listed = candidates.map((c) => {
    const syms = c.symbols.length ? `  — exports: ${c.symbols.slice(0, 12).join(', ')}` : '';
    return `  ${c.path}${syms}`;
  }).join('\n');
  return `${systemPrompt}

A build plan is about to CREATE these files:
${plannedNew.join('\n')}

THE PLAN:
${plan}

THESE EXISTING FILES LOOK RELATED (shortlisted by name and by the symbols they export —
this is a shortlist, not an answer, and it may contain files that do NOT do the job):
${listed}

For each file above, does an EXISTING file already do that job? Name it. Omit a file
entirely if nothing existing does the job. Be strict — naming a file that does not
actually do the job is worse than naming nothing, because the coder will be told to use
it. A file that exports what the new file would have to implement is exactly the case
this is looking for.`;
}

/** The response shape, unchanged from when the pre-flight was added. */
export const reuseSchema = {
  type: 'object',
  properties: {
    reuse: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          planned: { type: 'string', description: 'the new file path from the list above' },
          existing: { type: 'string', description: 'an existing path that already does this job' },
          why: { type: 'string', description: 'one short sentence: what it already provides' },
        },
      },
    },
  },
};

/** Keep only well-formed matches. */
export function parseReuseMatches(result) {
  return (Array.isArray(result?.reuse) ? result.reuse : [])
    .filter((r) => r && typeof r.planned === 'string' && typeof r.existing === 'string' && r.existing.trim());
}
