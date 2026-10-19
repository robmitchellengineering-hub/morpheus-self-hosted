// Lightweight ESM import/export graph over the self-dev workspace
// (SELF-DEV-V2 A3).
//
// Two jobs:
//   1. findBrokenImports() — a deterministic check that no file imports a
//      NAMED binding that its target local file doesn't export. This is the
//      exact failure the 2026-09-06 github.js rewrite shipped ("does not
//      provide an export named X" across a dozen importers). Run in
//      verifySelfDev.js.
//   2. buildReverseImports() — "who imports this file, and what do they pull
//      from it" — fed to the reviewer in chatWithMorpheus.js when a self-dev
//      change touches a shared module, so it can check the change against
//      every caller instead of only the files in front of it.
//
// Regex-based, not a real parser (no parser dep in the backend). The codebase
// is uniformly plain ESM with a consistent style, so this is good enough; it
// errs toward NOT flagging (skips a target that has `export *`, skips bare
// npm specifiers, skips namespace imports).

const CODE_EXT = /\.(jsx?|tsx?|mjs|cjs)$/;

// ── parsing ────────────────────────────────────────────────────────────────

// Every import/re-export in a file. Each: { spec, names, kind, namespace }
// kind ∈ 'named' | 'default' | 'namespace' | 'side-effect' | 'dynamic' | 'reexport'
export function parseImports(content) {
  const out = [];
  const src = String(content || '');

  // static: import ... from 'spec'   /   export ... from 'spec'
  // The clause never contains ; ' " — bounding it that way stops the lazy
  // match from spanning two statements (e.g. a preceding `import 'x';`).
  const RE = /(?:^|\n)\s*(import|export)\s+([^;'"]*?)\s+from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = RE.exec(src))) {
    const [, kw, clause, spec] = m;
    const names = [];
    const br = clause.match(/\{([^}]*)\}/);
    const star = /\*/.test(clause.replace(/\{[^}]*\}/, ''));
    let kind = kw === 'export' ? 'reexport' : star ? 'namespace' : br ? 'named' : 'default';

    // For BOTH import and re-export, the names consumed FROM the target are the
    // left-hand (original) names — `import { a as b }` / `export { a as b } from`
    // both pull `a` from the target.
    if (br) for (const n of splitImportedNames(br[1])) names.push(n);

    if (kw === 'import') {
      // a bare leading identifier (before any `{` or `* as`) is a default import
      const lead = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, '').replace(/,/g, ' ').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(lead)) names.push('default');
      else if (!br && !star && !lead) kind = 'side-effect';
    }
    out.push({ spec, names, kind, namespace: star });
  }

  // side-effect: import 'spec'
  const SIDE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  while ((m = SIDE.exec(src))) out.push({ spec: m[1], names: [], kind: 'side-effect', namespace: false });

  // dynamic: import('spec')  /  await import("spec")
  const DYN = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = DYN.exec(src))) out.push({ spec: m[1], names: [], kind: 'dynamic', namespace: false });

  return out;
}

// The set of names a file exports, plus flags for the cases we can't enumerate.
export function parseExports(content) {
  const src = String(content || '');
  const names = new Set();
  let hasStarExport = false;
  let hasDefault = false;

  if (/(?:^|\n)\s*export\s+default\b/.test(src)) hasDefault = true;
  if (/(?:^|\n)\s*export\s+\*\s+from/.test(src)) hasStarExport = true;

  // export function/const/let/var/class NAME
  const DECL = /(?:^|\n)\s*export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = DECL.exec(src))) names.add(m[1]);

  // export const { a, b } = ...   /   export const [a, b] = ...
  const DESTR = /(?:^|\n)\s*export\s+(?:const|let|var)\s+[[{]([^}\]]+)[}\]]\s*=/g;
  while ((m = DESTR.exec(src))) for (const n of splitNames(m[1])) names.add(n);

  // export { a, b as c }   (with or without `from` — the alias is what's exported)
  const LIST = /(?:^|\n)\s*export\s*\{([^}]*)\}/g;
  while ((m = LIST.exec(src))) for (const n of splitNames(m[1])) names.add(n);

  return { names, hasStarExport, hasDefault };
}

// Exported name: RIGHT of `as`. "a, b as c" -> ["a", "c"]
function splitNames(clause) {
  return splitEntries(clause).map((s) => {
    const as = s.match(/\bas\s+([A-Za-z_$][\w$]*)/);
    return as ? as[1] : s;
  }).filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
}

// Imported/consumed name: LEFT of `as`. "a, b as c" -> ["a", "b"]
function splitImportedNames(clause) {
  return splitEntries(clause).map((s) => s.replace(/\s+as\s+[A-Za-z_$][\w$]*/, '').trim())
    .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
}

function splitEntries(clause) {
  return clause.split(',').map((s) => s.trim().replace(/^type\s+/, '')).filter(Boolean);
}

// ── resolution ─────────────────────────────────────────────────────────────

function dirname(p) { const i = p.lastIndexOf('/'); return i === -1 ? '' : p.slice(0, i); }

function normalize(p) {
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

// Resolve an import specifier to a workspace path, or null (npm / unresolvable).
// `@/x` -> `src/x`. Relative specifiers resolve against `fromPath`'s dir. Tries
// the literal path, then .js/.jsx/.ts/.tsx, then /index.*.
export function resolveImport(fromPath, spec, pathSet) {
  let base;
  if (spec.startsWith('@/')) base = normalize('src/' + spec.slice(2));
  else if (spec.startsWith('./') || spec.startsWith('../')) base = normalize(dirname(fromPath) + '/' + spec);
  else return null; // bare specifier — npm package

  const candidates = [
    base,
    ...['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].map((e) => base + e),
    ...['/index.js', '/index.jsx', '/index.ts', '/index.tsx'].map((e) => base + e),
  ];
  for (const c of candidates) if (pathSet.has(c)) return c;
  return null;
}

// ── graphs ─────────────────────────────────────────────────────────────────

// Map<targetPath, Array<{ importer, names, kind }>> — only local resolvable
// targets, only importers that pull something (named / default / namespace /
// reexport). Side-effect and dynamic imports are recorded with names: [].
export function buildReverseImports(files) {
  const pathSet = new Set(files.map((f) => f.path));
  const rev = new Map();
  for (const f of files) {
    if (!CODE_EXT.test(f.path)) continue;
    for (const imp of parseImports(f.content)) {
      const target = resolveImport(f.path, imp.spec, pathSet);
      if (!target) continue;
      if (!rev.has(target)) rev.set(target, []);
      rev.get(target).push({ importer: f.path, names: imp.names, kind: imp.kind, namespace: imp.namespace });
    }
  }
  return rev;
}

// Only real first-party app JS is analysed. Excluded:
//   - `.ts`/`.tsx` — this app is plain .js/.jsx; the only TS in the tree is
//     the vendored base44 copy under public/, which leans on `export type` /
//     type re-exports this regex parser can't reason about.
//   - anything under `public/` — vendored / static bundles, not live source.
const ANALYSABLE = /^(src|server\/src)\/(?!.*\.d\.ts$).*\.(jsx?|mjs)$/;
// A target whose exports we can't (or needn't) enumerate — treated as
// "assume the import is fine".
const OPAQUE_TARGET = /\.(json|ts|tsx|css|scss|less|svg|png|jpe?g|gif|webp)$/;

// [{ importer, target, name }] — a NAMED import of a local file that the file
// doesn't (or no longer) exports. Conservative: skips targets with `export *`,
// skips namespace imports, skips `default` unless the target truly has no
// default export, skips .json/.ts/asset targets (implicit or opaque exports).
export function findBrokenImports(files) {
  const pathSet = new Set(files.map((f) => f.path));
  const byPath = new Map(files.map((f) => [f.path, f]));
  const exportCache = new Map();
  const exportsOf = (p) => {
    if (!exportCache.has(p)) exportCache.set(p, parseExports(byPath.get(p)?.content));
    return exportCache.get(p);
  };

  const broken = [];
  for (const f of files) {
    if (!ANALYSABLE.test(f.path)) continue;
    for (const imp of parseImports(f.content)) {
      if (imp.kind === 'side-effect' || imp.kind === 'dynamic' || imp.namespace) continue;
      const target = resolveImport(f.path, imp.spec, pathSet);
      if (!target || OPAQUE_TARGET.test(target)) continue;
      const ex = exportsOf(target);
      if (ex.hasStarExport) continue; // can't be sure what it re-exports
      for (const name of imp.names) {
        if (name === 'default') {
          if (!ex.hasDefault) broken.push({ importer: f.path, target, name: 'default' });
          continue;
        }
        if (!ex.names.has(name)) broken.push({ importer: f.path, target, name });
      }
    }
  }
  return broken;
}
