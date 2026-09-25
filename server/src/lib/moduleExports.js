// What a JavaScript module actually exports — the one definition, used by BOTH the CI
// import guard (scripts/verify-server-imports.mjs) and the reviewer's context
// (lib/reviewContext.js).
//
// WHY THIS IS ITS OWN MODULE
//
// On 2026-09-25 `runAiAction.js` shipped an import of `REVIEW_STEP_MAX_TOKENS` from a
// module that exported only `REVIEW_SCHEMA`. **ESM fails at LINK time**, so the whole
// handler threw on import and every task on it 500'd in production for ~30 minutes —
// including the deployed Wikidata uploader's AI mapping. Every gate was green:
// `node --check` validates syntax and never links, lint does not resolve imports, and
// `verify-server-imports.mjs` resolved the import PATH and stopped there. The path was
// fine; the NAME was missing.
//
// The guard was fixed to check names. Then the reviewer's own mutation test showed the
// SAME class of bug slipping past the reviewer: a proposed file importing a symbol its
// (real, present) module does not export was approved by both the old and the new
// reviewer context. The reviewer is the only thing checking code BEFORE it is committed,
// so it needed the same check the guard does — which means both need the same parser.
//
// Deliberately conservative: a module that re-exports (`export * from`) or is CommonJS is
// reported as OPAQUE and callers must skip it. A name checker that cries wolf gets
// switched off, and a false "this export does not exist" would make the reviewer block
// good code.
//
// Pure by design: imports nothing, no I/O, so both a build-time script and a guard can use it.

/** Whole-line `//` comments only. Block comments are NOT stripped — see verify-ai-roles.mjs
 *  for why that is unsafe on a large file (a `/*` inside a string can swallow real code). */
const codeOnly = (s) => String(s).replace(/^[ \t]*\/\/.*$/gm, ' ');

/**
 * @param {string} source  the module's source text
 * @returns {{names: Set<string>, opaque: boolean}} opaque means "cannot be checked"
 */
export function exportedNames(source) {
  const src = codeOnly(source);
  const names = new Set();

  // export [async] function|const|let|var|class Name
  for (const m of src.matchAll(/^[ \t]*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  // export { a, b as c }
  for (const m of src.matchAll(/^[ \t]*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  // export const { a, b } = ...
  for (const m of src.matchAll(/^[ \t]*export\s+(?:const|let|var)\s*\{([^}]*)\}/gm)) {
    for (const p of m[1].split(',')) {
      const t = p.trim().split(':').pop().trim();
      if (t) names.add(t);
    }
  }
  // export default / export default function Name
  if (/^[ \t]*export\s+default\b/m.test(src)) names.add('default');
  for (const m of src.matchAll(/^[ \t]*export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }

  const opaque = /^[ \t]*export\s+\*/m.test(src)
    || /\bmodule\.exports\b|^[ \t]*exports\./m.test(src);
  return { names, opaque };
}

/** The named bindings an import statement pulls in, ignoring inline `type` specifiers. */
export function namedImportsFrom(clause) {
  return String(clause)
    .split(',')
    .map((part) => part.trim())
    .filter((t) => t && !t.startsWith('type '))
    .map((t) => t.split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
}
