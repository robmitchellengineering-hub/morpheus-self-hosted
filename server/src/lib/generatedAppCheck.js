// Would the app we just generated actually run on the operator's machine?
//
// WHY THIS EXISTS. "It ships" is the whole promise of the self-hosted posture: one command, no account,
// no network. On 2026-09-29 that promise was tested by generating a self-hosted backend and running it,
// and the app failed twice before it answered anything:
//
//   1. it declared `better-sqlite3`, which publishes no prebuilt binary for Node 22 and whose source
//      fails to compile against that V8 — so the FIRST command in the README failed. The registry hint
//      had offered the model "better-sqlite3 or sqlite3" and it picked the one that does not build.
//   2. `server/db.js` exported `{ initialize, getDb }` while `server/routes/tasks.js` called
//      `db.prepare(...)`, so the first request threw. `verify-server-imports.mjs` cannot see this: it
//      checks that imports RESOLVE, not that the shape a module RECEIVES is the shape it USES.
//
// Neither is exotic, and neither needs a model to be clever to avoid — they need the generated output to
// be checked before it is shipped. This module is that check, and it is pure so the guard can hand it the
// exact two broken apps that were produced, rather than describing them in a comment.
//
// WHAT IT CANNOT DO. It cannot prove an app runs — only `scripts/smoke-generated-app.mjs` can, because
// that installs and boots one. This catches the failures that are decidable from the source: a
// dependency that cannot install in the sandbox, and a module contract that cannot hold.
//
// Import-free on purpose, so it runs in CI's no-install job.

/**
 * Dependencies that cannot install on a clean machine running this repo's own Node, with the measured
 * reason. Keyed by package name.
 *
 * `better-sqlite3` is here because it was OBSERVED failing, not because it is generally suspect: on Node
 * 22 it ships no prebuilt binary and `node-gyp` fails in its own source (`macros.lzz: no matching member
 * function for call to 'SetAccessor'`). A generated app that declares it fails on `npm install`, which is
 * the first thing its README tells the operator to run.
 */
export const UNBUILDABLE_DEPS = {
  'better-sqlite3': 'no prebuilt binary for this Node and its source does not compile (measured on Node 22: macros.lzz SetAccessor) — use sqlite3, which ships a prebuilt binary',
};

/**
 * Dependencies that COMPILE NATIVE CODE at install time. Not fatal on a developer machine and fatal on a
 * clean one, which is exactly the machine the self-contained promise is about — so a self-contained app
 * declaring one is reported.
 *
 * `sqlite3` is deliberately NOT here, and that is a measured decision rather than an oversight: it is a
 * native addon, but it ships a prebuilt binary for Node 22 and installed in 4s with no compiler
 * (`prebuild-install` found a binary; the observed failure was `better-sqlite3` finding none). Putting it
 * here made the checker reject the very fixture that proves a two-package self-contained app installs,
 * which is the difference between a checker and an obstacle.
 *
 * `puppeteer` is here even though it is not an addon: it downloads a browser at install time, which fails
 * on a machine with no network — the same class of "installs on mine, not on theirs".
 */
export const NATIVE_BUILD_DEPS = new Set(['bcrypt', 'node-gyp', 'sharp', 'canvas', 'puppeteer']);

/** Parse package.json out of a generated file list. Returns null when there is none or it is unreadable. */
export function packageJsonOf(files) {
  const pkg = (files || []).find((f) => /(^|\/)package\.json$/.test(f.path) && !f.path.includes('node_modules/'));
  if (!pkg || typeof pkg.content !== 'string') return null;
  try {
    return { path: pkg.path, data: JSON.parse(pkg.content) };
  } catch {
    return null;
  }
}

/** Every dependency name the generated package.json declares. */
export function declaredDependencies(pkg) {
  if (!pkg) return [];
  return Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
}

/**
 * Does the generated package.json describe an app that can install without a compiler?
 *
 * Returns the problems, each with the package and a sentence the operator could act on. Empty means the
 * dependency set is installable on a clean machine.
 */
/**
 * Accept either the parsed package.json or `packageJsonOf`'s `{ path, data }` wrapper.
 *
 * The first version took only the parsed data, and the guard passed it the wrapper — so
 * `declaredDependencies` read `wrapper.dependencies`, found nothing, and reported NO problems for a
 * manifest that declared `better-sqlite3`. Three check assertions failed while the checker itself was
 * correct. A function whose argument has two plausible shapes will eventually be given the wrong one, and
 * the failure is silent in the dangerous direction here (no problems found), so it accepts both.
 */
function pkgData(pkg) {
  if (!pkg) return null;
  return pkg.data && typeof pkg.data === 'object' ? pkg.data : pkg;
}

export function dependencyProblems(pkg) {
  const problems = [];
  const manifest = pkgData(pkg);
  if (!manifest) return problems;
  for (const name of declaredDependencies(manifest)) {
    if (UNBUILDABLE_DEPS[name]) {
      problems.push({ kind: 'unbuildable', package: name, detail: UNBUILDABLE_DEPS[name] });
    } else if (NATIVE_BUILD_DEPS.has(name)) {
      problems.push({ kind: 'needs-compiler', package: name, detail: `${name} compiles native code, so an install can fail on a machine with no toolchain — which is the machine a self-contained app is for` });
    }
  }
  return problems;
}

/**
 * The shape checks: does every file that reaches for the database handle reach it in a way that holds?
 *
 * This is deliberately narrow and mechanical, because it is looking for ONE class of bug: a module that
 * exports a factory (`initialize`/`getDb`) being used as if it were the handle itself. That is the exact
 * failure produced on 2026-09-29, and it is decidable from the source without running anything.
 */
/**
 * Source with comments removed.
 *
 * The generated-output check must never be satisfied — or tripped — by PROSE. The fixture app's own
 * comment explains the defect it demonstrates ("calling db.prepare() here is the defect"), and the first
 * version of this check flagged that comment as the defect. That is the seventh time in this repo's guard
 * suite that an assertion has matched its own explanation, so the same discipline applies to the checker
 * itself: strip comments before looking for code.
 *
 * Deliberately crude — it is looking for call sites, not parsing JavaScript. A real call cannot hide in a
 * comment, and a regex that mis-handles an exotic string literal can only cause a miss, not a false report.
 */
export function withoutComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

export function moduleContractProblems(files) {
  const problems = [];
  const list = files || [];

  for (const file of list) {
    if (typeof file.content !== 'string') continue;
    const source = withoutComments(file.content);
    // Only files that require a sibling db module are in scope, and only when that module is present —
    // a generated app that has no db module at all is a different problem, reported elsewhere.
    const requiresDb = /require\(\s*['"][./]*db['"]\s*\)|from\s+['"][./]*db(\.js)?['"]/.exec(source);
    if (!requiresDb) continue;

    const dbModule = list.find((f) => /(^|\/)db\.js$/.test(f.path) || /(^|\/)db\.ts$/.test(f.path));
    if (!dbModule || typeof dbModule.content !== 'string') continue;

    const dbSource = withoutComments(dbModule.content);
    const exportsFactory = /module\.exports\s*=\s*\{[^}]*\bgetDb\b/.test(dbSource)
      || /export\s+(async\s+)?function\s+getDb\b/.test(dbSource)
      || /export\s+const\s+getDb\b/.test(dbSource);
    if (!exportsFactory) continue;

    // The module exports a factory, so the handle is NOT the module. Any direct call on the module object
    // (`db.prepare(...)`, `db.query(...)`) is a contract break.
    const directCalls = [...source.matchAll(/\bdb\.([A-Za-z_$][\w$]*)\s*\(/g)]
      .map((m) => m[1])
      // `getDb`/`initialize` are the factory's own members and are the CORRECT way to use it.
      .filter((name) => name !== 'getDb' && name !== 'initialize');
    if (directCalls.length === 0) continue;

    problems.push({
      kind: 'module-contract',
      file: file.path,
      detail: `${dbModule.path} exports a factory ({ initialize, getDb }), but ${file.path} calls ${[...new Set(directCalls)].map((c) => `db.${c}()`).join(', ')} on the module — the first request will throw. Import the module and call getDb(), or have db.js export the handle.`,
    });
  }
  return problems;
}

/**
 * Would the entry point start at all? A generated app must name a `start` script that points at a file it
 * actually ships — the README tells the operator to run `npm start`, so a missing or dangling one makes
 * that instruction false.
 */
export function entryPointProblems(files, pkg) {
  const problems = [];
  const manifest = pkgData(pkg);
  if (!manifest) return problems;
  const start = manifest.scripts?.start;
  if (!start) {
    problems.push({ kind: 'no-start-script', detail: 'package.json declares no "start" script, so the one command the README gives cannot work' });
    return problems;
  }
  // Pull the script path out of `node server/index.js` — anything after the runtime, ignoring flags.
  const m = /(?:^|\s)([^\s'"]+\.(?:js|mjs|cjs|ts))/.exec(String(start));
  if (!m) return problems;
  const target = m[1].replace(/^\.\//, '');
  const present = (files || []).some((f) => f.path === target || f.path.endsWith(`/${target}`));
  if (!present) {
    problems.push({ kind: 'missing-entry', detail: `"start" runs ${target}, which is not among the generated files` });
  }
  return problems;
}

/** Everything decidable from the source, in one call — what the generator should be checked against. */
export function generatedAppProblems(files) {
  const pkg = packageJsonOf(files);
  return [
    ...dependencyProblems(pkg),
    ...entryPointProblems(files, pkg),
    ...moduleContractProblems(files),
  ];
}

/**
 * What a runnable self-contained app must contain, as a checklist rather than a promise.
 *
 * `verify` is a predicate over the file list. Kept as data so a guard can assert the checklist is
 * complete and that a known-good app satisfies every item.
 */
export const RUNNABLE_APP_REQUIREMENTS = [
  { id: 'package-json', label: 'a package.json the operator runs npm against', verify: (files) => Boolean(packageJsonOf(files)) },
  { id: 'start-script', label: 'an "npm start" that resolves to a file that ships', verify: (files, pkg) => entryPointProblems(files, pkg).every((p) => p.kind !== 'no-start-script') && Boolean(pkg?.data?.scripts?.start) },
  { id: 'installable-deps', label: 'dependencies that install with no compiler', verify: (files, pkg) => dependencyProblems(pkg).length === 0 },
  { id: 'persistent-store', label: 'a database it creates itself, with no server to install', verify: (files) => (files || []).some((f) => /(^|\/)db\.(js|ts)$/.test(f.path)) || (files || []).some((f) => typeof f.content === 'string' && /node:sqlite|sqlite3|better-sqlite3|\.db['"`]/.test(f.content)) },
  { id: 'gitignore-secrets', label: 'a .gitignore covering .env and the database file', verify: (files) => { const g = (files || []).find((f) => f.path === '.gitignore' || f.path.endsWith('/.gitignore')); return Boolean(g && typeof g.content === 'string' && /\.env/.test(g.content) && /\.db|\/data\//.test(g.content)); } },
  { id: 'readme-one-command', label: 'a README whose first instruction is that one command', verify: (files) => { const r = (files || []).find((f) => /(^|\/)README\.md$/i.test(f.path)); return Boolean(r && typeof r.content === 'string' && /npm (install && )?(npm )?start|npm install && npm start/.test(r.content)); } },
];
