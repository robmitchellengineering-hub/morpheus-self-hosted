// What goes into the downloadable Portable Morpheus bundle.
//
// WHY THIS EXISTS. `public/portable-morpheus/_source/` used to be a hand-run mirror of the codebase,
// produced by `scripts/sync-portable-morpheus.mjs` — whose own header said "Run after dev changes".
// Nothing ran it, nothing checked it, and so it drifted: measured 2026-09-29 it mirrored `base44/`
// (last touched 2026-08-26) while the implementation had moved to `server/src/` (touched that day).
// The download still worked and still handed out the superseded tree. Rob: "I can see we have lost
// the downloadable portable morpheus along the way somewhere."
//
// So the bundle is now GENERATED AT BUILD TIME from the tree being built, and this module is the
// rule for what it contains. Two consequences worth stating, because they are the point:
//
//   * It cannot go stale. There is no mirror to forget to refresh — the zip is written from the
//     working tree during `postbuild`, so it always describes the commit that produced it.
//   * The rule is testable without a build or a dependency. This file is import-free on purpose, so
//     `scripts/verify-portable-bundle.mjs` can assert the selection in CI's no-install guards job —
//     the same reason creditPolicy.js and onrampChecklist.js are import-free.
//
// WHAT IS INCLUDED, and why it is this and not less: Portable Morpheus is the whole product — the
// builder AND the Command Deck — running on the operator's own machine. So the bundle is the source
// that runs it, not a sample of it. The one thing kept out is the portable download machinery
// itself, which would otherwise nest a copy of the bundle inside the bundle on every build.

/**
 * Roots (directory prefixes) that ship, taken verbatim from the repository.
 * Every one of these is needed to run Morpheus or the Deck locally.
 */
export const PORTABLE_INCLUDE_ROOTS = [
  'src/',                    // the whole frontend, including the Command Deck and its widgets
  'server/src/',             // every backend function, route and library
  'server/prisma/',          // the schema a local Postgres is built from
  'server/scripts/',         // dev-db.mjs — the local Postgres cluster a self-host actually runs
  'public/',                 // deck.html + manifests + icons the local server must serve
  'wp-plugin/',              // the WordPress plugin source, so a self-hoster can build it too
  'scripts/',                // the verification suite: the point of self-hosting is being able to check
];

/**
 * Individual root files that ship. Deliberately a whitelist: a bundle built from "everything not
 * excluded" would grow whatever someone drops in the repository root, and nobody would notice.
 */
export const PORTABLE_INCLUDE_FILES = [
  'package.json',
  'index.html',
  'vite.config.js',
  'tailwind.config.js',
  'jsconfig.json',
  'README.md',
  'AGENTS.md',
];

/**
 * Paths that must never ship. Each entry is a real mistake that would otherwise be silent:
 *   * `public/portable-morpheus/` — the download page's own assets. Including it nests the bundle in
 *     itself, once per build, growing every time.
 *   * `server/.env*` — credentials. The self-hoster writes their own.
 *   * `public/morpheus-wordpress-plugin.zip` — a build product of `pack-wp-plugin.mjs`, regenerated
 *     from `wp-plugin/` which IS included. Shipping both invites them to diverge.
 *   * `node_modules/`, `dist/` — never source.
 */
export const PORTABLE_EXCLUDE = [
  'public/portable-morpheus/',
  'server/.env',
  'public/morpheus-wordpress-plugin.zip',
  'node_modules/',
  'dist/',
];

/** Is this repository-relative path part of the portable bundle? */
export function isPortableFile(path) {
  const p = String(path || '').replace(/^\.?\//, '');
  if (!p) return false;
  if (p.startsWith('.git/') || p.startsWith('.')) return false;   // dotfiles are config, not source
  if (PORTABLE_EXCLUDE.some((x) => p === x || p.startsWith(x))) return false;
  if (PORTABLE_INCLUDE_FILES.includes(p)) return true;
  return PORTABLE_INCLUDE_ROOTS.some((root) => p.startsWith(root));
}

/** The files to include, from any list of repository-relative paths, sorted for a stable zip. */
export function selectPortableFiles(paths) {
  return [...new Set((paths || []).map((p) => String(p).replace(/^\.?\//, '')))]
    .filter(isPortableFile)
    .sort();
}

/**
 * The README written INTO the bundle, generated so it cannot describe a build other than the one it
 * ships with. It states what is here and — this is the part that matters — what is NOT, because a
 * download that implies an installer it does not have is the same class of lie as the copy the
 * `reality.mjs` claims check exists to catch.
 */
export function portableBundleReadme({ commit, builtAt, fileCount }) {
  return `# Portable Morpheus

**Generated from the Morpheus repository at build time — not a mirror, and not a snapshot of an
older tree.** Portable Morpheus is the whole product: the builder *and* the Command Deck, running on
your own Mac, PC or Linux machine.

| | |
|---|---|
| Built from commit | \`${commit}\` |
| Built at | ${builtAt} |
| Files | ${fileCount} |

## What is in here

- \`src/\` — the complete frontend, including the Command Deck at \`/deck\` and its widgets.
- \`server/src/\` — every backend function, route and library. This IS the local server.
- \`server/prisma/schema.prisma\` — the database schema (PostgreSQL).
- \`public/\` — the static assets the local server serves, including \`deck.html\`.
- \`wp-plugin/\` and \`scripts/\` — the WordPress plugin source, and the verification suite, so you can
  check the thing you are running.
- \`README.md\` and \`AGENTS.md\` — what the project is, and how it is built.

## What is in here, and what is still missing

- **One command sets it up.** \`npm run portable:setup\` checks your machine, generates the secrets an
  install cannot invent (including the key it signs AI gateway tokens with), starts a local Postgres
  for you, applies the schema and builds the frontend — then \`npm run portable:start\` (or the
  double-click launcher that ships here) opens it. What is still NOT one-click: no signed native app,
  so macOS quarantines a downloaded \`.command\` and Windows SmartScreen warns once.
- **Remote access needs Tailscale, which you install.** \`npm run portable:remote\` exposes this
  server to your own tailnet — end-to-end encrypted, no ports opened — but it does not install Tailscale
  or create the account for you, and nothing is exposed until you run it. A Morpheus-hosted relay, for
  anyone who would rather install nothing, is decided as the paid-tier successor and is not built.
- **No AI configured until you choose one.** \`npm run portable:ai\` sets it: a model on this machine
  (private, free), or your own provider key. The Morpheus Cloud paid default is decided and its broker
  exists in \`hosted-broker/\`, but that service is **not deployed**, so it cannot complete a call today
  — and the wizard refuses to write the inert placeholder URL that would look like it did.

## Why the source and not a re-implementation

An earlier portable download shipped a hand-written stand-in server (Node/Express + a file store) and
a mirror of the pre-port \`base44/\` tree. It could only ever be a slice of the product, and because
nothing regenerated it, it described a codebase a month out of date. This bundle is generated from the
tree that was just built, so the two cannot disagree.
`;
}
