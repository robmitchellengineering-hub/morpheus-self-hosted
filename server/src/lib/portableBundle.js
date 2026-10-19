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
//
// `base44/shared/` IS SHIPPED, NARROWLY, AND IT IS NOT A CONTRADICTION of the exclusion below. The
// pre-port `base44/functions/` tree is what must never ship — it was superseded, and the old mirror
// shipped it for a month. But `src/components/matrix/BackendPanel.jsx` still imports
// `base44/shared/infrastructureComponents` directly, so a bundle without it cannot build at all —
// measured 2026-10-12 on the published download: `Could not resolve
// "../../../base44/shared/infrastructureComponents"`. Most of `base44/shared/` HAS been ported into
// `server/src/lib/` (each file carries a "Ported from …" header); this one module has not. The rule now
// ships the directory that holds it instead of the tree that was replaced. A rule that ships an importer
// has to ship the import.

// `hosted-broker/` SHIPS FOR THE SAME REASON, MEASURED ONE TREE OVER. The bundle ships `scripts/` in
// full — "the point of self-hosting is being able to check" — and one of those scripts,
// `scripts/verify-cloud-metering.mjs`, imports `../hosted-broker/src/metering.js` and reads the broker's
// `server.js`, `.env.example` and `README.md`; `scripts/verify-license-terms.mjs` reads its
// `package.json`. With the broker excluded, the suite the bundle advertises died at module load before
// it could check anything. Excluding the importer instead is not an option: the bundle's `scripts/verify.mjs`
// runs every guard by name, so a shipped gate missing a guard fails outright, and hiding it behind an
// "only if present" check is H17 exactly — a check that never ran reading as a pass. So the broker's
// SOURCE ships (it holds no credential — its secrets come from the environment at deploy time, and
// `.env` is excluded below); the service itself remains separately deployed, as its README says.
//
// `hosted-broker/` and `portable-architect/` are the two separately-deployed services. Neither is
// needed to run Morpheus or the Deck locally, which is why they were left out — but the shipped suite
// grew a dependency on the broker's source, and a rule that ships an importer has to ship the import.

/**
 * Roots (directory prefixes) that ship, taken verbatim from the repository.
 * Every one of these is needed to run Morpheus or the Deck locally — except `hosted-broker/`, which is
 * needed by the verification suite that ships beside them (see the note above).
 */
export const PORTABLE_INCLUDE_ROOTS = [
  'src/',                    // the whole frontend, including the Command Deck and its widgets
  'base44/shared/',          // the one pre-port directory still imported by the shipped frontend — see above
  'server/src/',             // every backend function, route and library
  'server/prisma/',          // the schema a local Postgres is built from
  'server/scripts/',         // dev-db.mjs — the local Postgres cluster a self-host actually runs
  'public/',                 // deck.html + manifests + icons the local server must serve
  'wp-plugin/',              // the WordPress plugin source, so a self-hoster can build it too
  'scripts/',                // the verification suite: the point of self-hosting is being able to check
  'hosted-broker/',          // …and the broker that suite imports and reads — see above
];

/**
 * Individual root files that ship. Deliberately a whitelist: a bundle built from "everything not
 * excluded" would grow whatever someone drops in the repository root, and nobody would notice.
 */
export const PORTABLE_INCLUDE_FILES = [
  'package.json',
  // The server's OWN manifest, and the lock beside it. MEASURED 2026-10-12 by installing the published
  // zip on a real machine: the bundle shipped `server/src/`, `server/prisma/` and `server/scripts/` but
  // not this file, so the installer's third step (`npm install` in `server/`) installed NOTHING — the
  // root manifest does not declare `embedded-postgres`; only this one does. Step 4 then died with
  // "Postgres binaries not found", on every platform, because the missing file is platform-independent.
  // The downloaded product could not be installed by the one command it tells you to run. Its own
  // remedy ("Run: cd server && npm install") could not work either, for the same reason.
  'server/package.json',
  // NOT `server/package-lock.json`, and the reason is the point of everything above: it is GITIGNORED
  // (.gitignore:47), so it exists only in a local working tree and can never be in a deployed checkout.
  // Listing it was a promise the download could not keep — this change's own mistake, caught by
  // downloading the zip the merge produced and finding the lock absent while the rule said yes. The
  // installer runs `npm install`, not `npm ci`, so the manifest is what the install path actually needs;
  // the guard below now refuses any included path that git ignores. If a reproducible install is ever
  // wanted, the fix is to stop ignoring the lock, not to list it here.
  'index.html',
  // The Command Deck's OWN entry point, and the second input in vite.config.js. The bundle shipped
  // `public/deck.html` — a different file — and not this one, so `vite build` died at step 6 of the
  // install with `Could not resolve entry module "deck.html"` on a freshly downloaded bundle. Found the
  // same way as the manifest above: by installing the download instead of reading the rule.
  'deck.html',
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
 *   * `hosted-broker/.env*` — the SAME rule for the broker, which now ships as source. This one is not
 *     hypothetical: the bundle is built from a walk of the WORKING TREE (not `git ls-files`), the
 *     generic dotfile check below only refuses dotfiles at the repository ROOT, and the broker's own
 *     deploy steps tell the operator to copy `.env.example` to `.env` in that directory — so on the
 *     machine of anyone who has deployed a broker, `npm run build` would have zipped the live
 *     `BROKER_JWT_SECRET` and upstream AI key and published them with the download.
 *   * `public/morpheus-wordpress-plugin.zip` — a build product of `pack-wp-plugin.mjs`, regenerated
 *     from `wp-plugin/` which IS included. Shipping both invites them to diverge.
 *   * `node_modules/`, `dist/` — never source.
 */
export const PORTABLE_EXCLUDE = [
  'public/portable-morpheus/',
  'server/.env',
  'hosted-broker/.env',
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

> ## ⚠️ This is published source, not open source
>
> You may **read** this code, and you may **run** it as we provide it. You may not copy, modify,
> redistribute, sublicense or sell it, or use it to train a model, without our written permission.
> Commercial licensing — including OEM and white-label terms — is available on request.
>
> **Your own projects are not covered by this.** The applications Morpheus writes for you are yours,
> with no obligation to us. This notice covers the tool, not what the tool makes for you.
>
> Third-party components keep their own (more permissive) licences — CLAP, the VST3 SDK,
> NeuralAmpModelerCore, clap-wrapper, RtAudio/RtMidi, AudioUnitSDK, Eigen and others. See the
> \`LICENSE\` file in this bundle for the full notice.

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
- \`hosted-broker/\` — the source of the optional shared OAuth/AI broker. It ships because the shipped
  verification suite imports and reads it; the service is separate and is not started by the installer.
- \`README.md\` and \`AGENTS.md\` — what the project is, and how it is built.

## What is in here, and what is still missing

- **One command sets it up.** \`npm run portable:setup\` checks your machine, generates the secrets an
  install cannot invent (including the key it signs AI gateway tokens with), starts a local Postgres
  for you, applies the schema and builds the frontend — then \`npm run portable:start\` (or the
  double-click launcher that ships here) opens it. What is still NOT one-click: no signed native app,
  so macOS quarantines a downloaded \`.command\` and Windows SmartScreen warns once.
- **No AI configured until you choose one.** \`npm run portable:ai\` sets it: a model on this machine
  (private, free), or your own provider key. The Morpheus Cloud paid default is decided and its broker
  exists in \`hosted-broker/\`, but that service is **not deployed**, so it cannot complete a call today
  — and the wizard refuses to write the inert placeholder URL that would look like it did.
- **Remote access needs Tailscale, which you install.** \`npm run portable:remote\` exposes this
  server to your own tailnet — end-to-end encrypted, no ports opened — but it does not install Tailscale
  or create the account for you, and nothing is exposed until you run it. A Morpheus-hosted relay, for
  anyone who would rather install nothing, is decided as the paid-tier successor and is not built.

## Install it — the same one command on all three

Unzip this folder, open a terminal or command prompt **in it**, and run:

\`\`\`
node scripts/portable-setup.mjs
\`\`\`

That is the whole install. Not sure what your machine needs first? Ask it without changing anything —
and it will print the steps for any platform, so the Windows ones can be read from a Mac:

\`\`\`
node scripts/portable-setup.mjs --check --platform win32
\`\`\`

| | What to install first | How to start it afterwards |
|---|---|---|
| **macOS** | Node 20+ (https://nodejs.org, or \`brew install node\`); Xcode command line tools (\`xcode-select --install\`). No database — the setup runs its own. | Double-click \`Portable-Morpheus.command\`. If macOS refuses it: right-click → Open, or \`xattr -d com.apple.quarantine "Portable-Morpheus.command"\` |
| **Linux** | Node 20+ and npm (\`sudo apt install nodejs npm\`, or \`sudo dnf install nodejs npm\`); a toolchain (\`sudo apt install build-essential\`). No database. | \`chmod +x Portable-Morpheus.desktop\` then double-click it — or \`npm run portable:start\` |
| **Windows** | Node 20+ — the LTS \`.msi\` from https://nodejs.org, then a **new** Command Prompt so PATH updates. No toolchain, no database. | Double-click \`Portable-Morpheus.bat\`. If SmartScreen warns: More info → Run anyway |

A working install looks like this: \`npm run portable:start\` opens http://localhost:4500 by itself and
the browser shows the Morpheus sign-in page. Nothing opens before the server answers, so a browser that
appears is a server that is genuinely up.

## Why the source and not a re-implementation

An earlier portable download shipped a hand-written stand-in server (Node/Express + a file store) and
a mirror of the pre-port \`base44/\` tree. It could only ever be a slice of the product, and because
nothing regenerated it, it described a codebase a month out of date. This bundle is generated from the
tree that was just built, so the two cannot disagree.
`;
}
