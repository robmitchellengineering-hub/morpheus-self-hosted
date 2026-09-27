// What the REVIEWER is shown — deliberately not what the Coder is shown.
//
// WHY THIS IS ITS OWN MODULE
//
// Until now the reviewer was handed the Coder's own context block verbatim
// (`let reviewContext = contextBlock` in chatWithMorpheus.js). Measured over 30
// days of production (`usage_events`), the reviewer is 1,254 calls averaging
// **26,138 input tokens** each — 30.6% of all AI spend, the single largest line
// item in the product, all of it deepseek-v4-pro. Almost none of that is the
// change under review: `REVIEW_CHUNK_SIZE` caps the files under review at 3,
// while the shared block carries the whole repo tree (984 paths in self-dev,
// ~8.7k tokens) plus every orientation file — `server/prisma/schema.prisma`
// alone is ~15.1k tokens, `README.md` ~2.8k, `src/App.jsx` ~3.1k.
//
// The Coder needs breadth: it has to decide what to write and reuse. The
// reviewer does not — it has the operations in front of it and four questions:
// does this obey the house rules, does this repeat a known hazard, does this
// break a caller (added by the caller-impact block at the call site), and does
// the file it imports actually exist. So this emits exactly what answers those:
//
//   1. KNOWN-HAZARDS.md and AGENTS.md — the reviewer's own prompt tells it to
//      check against both, so they are never optional.
//   2. A BOUNDED view of the tree. `buildScopedFilesContext`'s tree is not
//      counted against its byte budget at all (it charges `f.content.length`
//      only), so the path list is unbounded by construction. Small projects get
//      the full tree unchanged; past `maxTreeBytes` it degrades to a directory
//      index plus the paths in the directories the change actually touches,
//      which is the part that answers "does this import resolve".
//   3. `server/prisma/schema.prisma` ONLY when the change touches the schema.
//      It is the largest orientation file and it is dead weight in a review of,
//      say, a React component.
//
// Pure by design: one sibling pure module and nothing else — no DB, no I/O — so a guard
// can assert its composition directly (`scripts/verify-review-context.mjs`) and the export
// parser is shared with `scripts/verify-server-imports.mjs` rather than copied.
import { exportedNames } from './moduleExports.js';
import { modelFieldIndex } from './prismaFields.js';

/** The files the reviewer's own prompt instructs it to check a change against. */
const RULE_FILES = ['KNOWN-HAZARDS.md', 'AGENTS.md'];

/** Included only when the change under review is actually about it. */
const CONDITIONAL_FILES = [
  { path: 'server/prisma/schema.prisma', whenTouchedPrefix: 'server/prisma/' },
];

function directoriesOf(paths) {
  const dirs = new Set();
  for (const p of paths) {
    const i = p.lastIndexOf('/');
    dirs.add(i === -1 ? '.' : p.slice(0, i));
  }
  return Array.from(dirs).sort();
}

const dirOf = (p) => {
  const i = p.lastIndexOf('/');
  return i === -1 ? '.' : p.slice(0, i);
};

// The file's own name within its directory. Derived from the last '/' rather than from
// `p.slice(dirOf(p).length + 1)`, which is wrong for a root-level path: `dirOf('app.js')`
// is `'.'`, so `'.'.length + 1` is 2 and `app.js` came out as `p.js` (and `index.html` as
// `dex.html`). A web-app project keeps its entry file, `index.html` and `styles.css` at the
// root, so that is the common case — and the section below is the evidence that answers
// "does this import resolve", so a reviewer shown `p.js` can conclude the `app.js` it is
// asking about does not exist and raise a false NO SUCH FILE.
const baseOf = (p) => {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
};

// Resolve a relative specifier against the file that imports it. No node:path, so
// this module stays dependency-free and a guard can import it directly.
function resolveRelative(fromPath, spec) {
  const parts = fromPath.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

// Which directories this change imports OUT of, and what is in them.
//
// This is the targeted fix for a gap the mutation test found: with only a directory
// INDEX, the reviewer could not tell that an import named a module that does not
// exist at all — `server/src/lib` was listed as a directory, but nothing said whether
// `server/src/lib/apiUsage.js` was in it. The full repo tree answered that; the first
// version of this bounded block did not, and the reviewer approved the broken import.
// So the directories the change actually imports from are listed in full, which is a
// few dozen paths rather than nine hundred.
const IMPORT_SPEC = /(?:from|require\(|import\()\s*['"](\.[^'"]+)['"]/g;

// Extensionless specifiers are normal in this repo's frontend and legal in ESM only with a
// resolver, so try the usual candidates before declaring a file missing.
const MODULE_SUFFIXES = ['', '.js', '.jsx', '.mjs', '.ts', '.tsx', '/index.js', '/index.jsx'];

function resolveModulePath(base, byPath) {
  for (const suffix of MODULE_SUFFIXES) {
    if (byPath.has(base + suffix)) return base + suffix;
  }
  return null;
}

// Every relative import the change makes, resolved to a real file in the project, with
// that file's actual exports.
//
// WHY EXPORTS AND NOT JUST PATHS: the mutation test found the reviewer approving a file
// that imported a symbol its module does not export — the same class of bug that shipped a
// 30-minute production outage on 2026-09-25 (`runAiAction.js` importing a name
// `reviewer.js` never exported; ESM fails at LINK time, so the whole handler died). Listing
// the directory a path resolves into answers "does this file exist"; it does not answer
// "does this name exist", and the second one is what actually broke production.
//
// KEYED BY DIRECTORY, BUT THE SPECIFIERS ARE A LIST. Keying by directory with a single
// specifier silently dropped every import but the first into the same folder — including,
// in the very fixture this section exists for, the one naming a file that is not there.
// A guard assertion caught that; without it the fix would not have closed the regression.
function importTargets(fileOps, byPath) {
  const dirs = new Map();
  for (const op of fileOps) {
    if (!op || typeof op.path !== 'string' || typeof op.content !== 'string') continue;
    for (const m of op.content.matchAll(IMPORT_SPEC)) {
      const base = resolveRelative(op.path, m[1]);
      const dir = dirOf(base);
      const target = resolveModulePath(base, byPath);
      const parsed = target ? exportedNames(byPath.get(target).content || '') : null;
      if (!dirs.has(dir)) dirs.set(dir, []);
      const entries = dirs.get(dir);
      if (entries.some((e) => e.spec === m[1] && e.from === op.path)) continue;
      entries.push({
        from: op.path,
        spec: m[1],
        target,
        names: parsed ? Array.from(parsed.names).sort() : [],
        opaque: parsed ? parsed.opaque : false,
      });
    }
  }
  return dirs;
}

/**
 * The `model X { … }` blocks a change actually references.
 *
 * A change reaches a model either through the Prisma client's camelCase property
 * (`prisma.usageEvent`) or by naming it directly (`UsageEvent`, e.g. in a type annotation or
 * a comment). Both are matched, and matching a name in a comment is deliberately accepted:
 * over-including one model costs a few hundred tokens, missing one is the failure this
 * whole section exists to prevent.
 */
export function referencedModels(schemaText, fileOps) {
  const blocks = new Map();
  for (const m of schemaText.matchAll(/^model\s+(\w+)\s*\{[\s\S]*?^\}/gm)) {
    blocks.set(m[1], m[0]);
  }
  const contents = fileOps
    .map((op) => (op && typeof op.content === 'string' ? op.content : ''))
    .join('\n');
  const found = [];
  for (const [name, block] of blocks) {
    const clientProp = name.charAt(0).toLowerCase() + name.slice(1);
    // Built by concatenation, not a template literal: `verify-prisma-models.mjs` scans for
    // `prisma.<name>` usages, and a literal `prisma.${clientProp}` in source reads to it as a
    // model called `$`. That guard is right to be strict, so the fix belongs here rather than
    // as a hole punched in the guard.
    const clientAccess = 'prisma.' + clientProp;
    if (new RegExp('\\b' + clientAccess + '\\b').test(contents) || new RegExp(`\\b${name}\\b`).test(contents)) {
      found.push(`${block}\n// accessed as ${clientAccess}`);
    }
  }
  return found;
}


/**
 * @param {{path: string, content: string}[]} files  every file in the project
 * @param {{path: string, content?: string, action?: string}[]} fileOps  the change under review
 * @param {{maxTreeBytes?: number, maxSiblingPaths?: number, maxImportDirPaths?: number}} [opts]
 * @returns {string} the context block that precedes the operations in the reviewer prompt
 */
export function buildReviewerContext({ files, fileOps, maxTreeBytes = 12000, maxSiblingPaths = 400, maxImportDirPaths = 120 } = {}) {
  const list = Array.isArray(files) ? files : [];
  const ops = Array.isArray(fileOps) ? fileOps : [];
  const byPath = new Map(list.map((f) => [f.path, f]));
  const allPaths = list.map((f) => f.path).sort();
  const opPaths = ops.map((op) => op && op.path).filter((p) => typeof p === 'string' && p);

  const sections = [];

  // 1. The rules first. The reviewer's prompt names both files explicitly, and a
  //    house rule the model may or may not have been shown is not stated at all.
  for (const p of RULE_FILES) {
    const f = byPath.get(p);
    if (f) sections.push(`--- ${f.path} ---\n${f.content}`);
  }

  // 2. The tree — full when it fits, otherwise bounded rather than unbounded.
  if (allPaths.length > 0) {
    const fullTree = allPaths.join('\n');
    if (fullTree.length <= maxTreeBytes) {
      sections.push(`FULL REPO FILE TREE (${allPaths.length} files — every path listed exists):\n${fullTree}`);
    } else {
      // Which paths does the reviewer plausibly need? The ones in the same
      // directories as the change — that is what makes "you import ./x.js but
      // nothing creates it" answerable — plus a directory index for the rest.
      const opDirs = new Set(directoriesOf(opPaths));
      const siblingPaths = allPaths.filter((p) => opDirs.has(dirOf(p)));
      const shownSiblings = siblingPaths.slice(0, maxSiblingPaths);
      const dirs = directoriesOf(allPaths);
      sections.push(
        `REPO FILE TREE (${allPaths.length} files — too large to include in full, so this is a`
        + ` directory index plus the paths that matter most to this change; a path NOT`
        + ` listed here may still exist):\n\nDIRECTORIES (${dirs.length}):\n${dirs.join('\n')}`
        + `\n\nPATHS IN THE TOUCHED DIRECTORIES (${shownSiblings.length} of ${siblingPaths.length}):\n`
        + `${shownSiblings.join('\n') || '(none)'}`
      );
    }
  }

  // 3. Every relative import this change makes, and what is actually in the directory
  //    it resolves into — the one question a directory index cannot answer. Listed
  //    regardless of tree size: it is small, and it is the check most likely to catch
  //    a real break in a proposed file.
  const targets = importTargets(ops, byPath);
  if (targets.size > 0) {
    const blocks = [];
    for (const [dir, entries] of targets) {
      const inDir = allPaths.filter((p) => dirOf(p) === dir).map(baseOf);
      const shown = inDir.slice(0, maxImportDirPaths);
      const lines = entries.map((e) => {
        if (!e.target) {
          return `      ${e.from}: '${e.spec}'  ->  NO SUCH FILE — this import cannot resolve`;
        }
        if (e.opaque) {
          return `      ${e.from}: '${e.spec}'  ->  ${e.target}  (re-exports or CommonJS — its names cannot be checked)`;
        }
        return `      ${e.from}: '${e.spec}'  ->  ${e.target}\n`
          + `          exports: ${e.names.length ? e.names.join(', ') : '(no named exports)'}`;
      }).join('\n');
      blocks.push(
        `  ->  ${dir}/\n${lines}\n`
        + `      files that exist in that directory: ${shown.join(', ') || '(none are in the project file list)'}`
        + (shown.length < inDir.length ? `\n      (…and ${inDir.length - shown.length} more)` : '')
      );
    }
    sections.push(
      'IMPORT TARGETS — every relative import this change makes, the module it resolves to,'
      + ' and that module\'s ACTUAL exports. Check every named binding in the import against'
      + ' that export list. `import { x } from \'./y.js\'` where y.js does not list x is a'
      + ' CRITICAL issue: ESM fails at LINK time, so the whole app stops loading — not just'
      + ' that one function. A binding listed as a re-export or CommonJS cannot be checked, so'
      + ' do not guess about it. An import that resolves to NO SUCH FILE is CRITICAL too:\n'
      + blocks.join('\n')
    );
  }

  // 4. The schema only when the change is about it.
  for (const { path, whenTouchedPrefix } of CONDITIONAL_FILES) {
    const touched = opPaths.some((p) => p.startsWith(whenTouchedPrefix));
    if (!touched) continue;
    const f = byPath.get(path);
    if (f) sections.push(`--- ${f.path} (included because this change touches ${whenTouchedPrefix}) ---\n${f.content}`);
  }

  // 5. The Prisma models the change actually uses — because a change that READS or WRITES a
  //    model needs the schema just as much as one that edits it, and the check above only
  //    fires when the change touches server/prisma/.
  //
  //    This is a regression I introduced and then found. Dropping the schema entirely for
  //    non-schema changes meant the reviewer could no longer answer "does that column
  //    exist", and the mutation test caught it: a fixture reading `row.tokens` — on a model
  //    that has input_tokens/output_tokens — was BLOCKED by the old full context and
  //    APPROVED by the narrowed one. I had recorded that block as a false positive twice.
  //    No other gate can see it: esbuild, lint and the import guard have no idea what the
  //    database looks like.
  //
  //    Only the referenced models, not the whole 16.5k-token file: the reviewer needs the
  //    evidence for the questions it is asked, not every table in the product.
  const schema = byPath.get('server/prisma/schema.prisma');
  if (schema && typeof schema.content === 'string') {
    const models = referencedModels(schema.content, ops);
    const index = modelFieldIndex(schema.content);
    const parts = [];
    if (models.length > 0) {
      parts.push(
        'Definitions for the models this change references:\n\n' + models.join('\n\n')
      );
    }
    if (index.length > 0) {
      parts.push(
        'FIELD INDEX — every model and its field names. Use this when the change handles a row'
        + ' WITHOUT naming the model it came from (a helper that takes `row`, a mapper, a'
        + ' serializer): if a property the change reads is not a field of ANY model listed'
        + ' here, it does not exist and using it is a CRITICAL issue. This is a name index'
        + ' only — consult the definitions above for types, nullability and defaults where a'
        + ' model is referenced:\n\n'
        + index.join('\n')
      );
    }
    if (parts.length > 0) {
      sections.push(
        'PRISMA MODELS AND FIELDS — check every field the change reads or writes against these.'
        + ' A column that is not listed does not exist, and using it is a CRITICAL issue: it'
        + ' fails at runtime, and no other check in this pipeline can see it (esbuild, lint and'
        + ' the import guard have no idea what the database looks like).\n\n'
        + parts.join('\n\n')
      );
    }
  }

  return sections.join('\n\n');
}
