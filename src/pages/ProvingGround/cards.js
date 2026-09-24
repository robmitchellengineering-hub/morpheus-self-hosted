// The proving-ground registry — the single source of truth for which cards
// exist on /proving-ground, and what each one is for.
//
// WHAT THIS PAGE IS
//
// An admin-only surface that exists so a change shipped through **self-dev** can
// be looked at by a human before it goes anywhere near a customer. Self-dev's
// two verification tiers cannot see rendering: engine/verify.js parses and
// bundles with esbuild, and smokeCheckSelfDev probes live URLs over HTTP, where
// an SPA answers 200 for every path. So "it shipped" and "it works" are
// different claims, and this page is where the second one gets tested cheaply.
//
// It is also the target for the first self-dev dogfood run — which is why the
// harness itself is built by the reliable path (a normal DSH change with the
// full guard suite) and only the CARDS are built through self-dev. A proving
// ground you cannot trust to exist is not a proving ground.
//
// THE RULE FOR ADDING A CARD — this is what a self-dev run is asked to follow
//
//   1. Add ONE file: `src/pages/ProvingGround/cards/<key>.jsx`, default-
//      exporting a component. The key is the filename without the extension.
//   2. Add ONE entry to PROVING_GROUND_CARDS below, in the same change:
//      `key`, `title`, `what` (what a reader should be able to see working),
//      `addedBy` and `ref` (who and which change shipped it).
//   3. Nothing else. No route, no nav entry, no import in App.jsx — the loader
//      below discovers the file by its filename, the same `import.meta.glob`
//      trick DeckHome.jsx uses for Deck widgets.
//
// A card is NOT expected to be polished or permanent. It is expected to be
// visibly working: something a person can look at and say yes or no about.
// Anything that outgrows the proving ground graduates to a real surface as its
// own reviewed change.
//
// DIFFERENCE FROM deckWidgets.js, ON PURPOSE: that registry is a list of keys
// and DeckHome renders `null` for a key with no module, so a widget can vanish
// with no build error and no CI signal. Here a registry entry with no file
// renders a loud red row naming the key, because on THIS page a silent
// disappearance is the exact failure the page exists to catch.
export const PROVING_GROUND_CARDS = [
  {
    key: 'pipeline_canary',
    title: 'Pipeline canary',
    what: 'Proves the page itself renders and can reach the backend: a fixed marker, the API URL the browser actually talked to, and the live result of GET /api/health (status plus a short body excerpt).',
    addedBy: 'DSH session',
    ref: 'the proving-ground harness itself',
  },
  {
    key: 'selfdev_hello',
    title: 'Self-dev hello',
    what: 'Renders a fixed marker and a live UTC clock that ticks once a second.',
    addedBy: 'self-dev (first dogfood run)',
    ref: 'first dogfood run',
  },
  {
    key: 'selfdev_runs',
    title: 'Self-dev runs',
    what: 'Reads the durable run record back through the API: every stage of the last few self-dev runs, with its status, duration and detail.',
    addedBy: 'self-dev',
    ref: 'run-record dogfood',
  },
  {
    key: 'selfdev_drift',
    title: 'Workspace drift',
    what: 'Shows how many self-dev workspace files differ from the last synced commit, with a one-line verdict.',
    addedBy: 'self-dev',
    ref: 'drift card',
  },
  {
    key: 'viewport_report',
    title: 'Viewport report',
    what: 'Shows the live viewport size and route, so a layout that only breaks at phone width is visible here.',
    addedBy: 'self-dev',
    ref: 'rework verification run',
  },
  {
    key: 'stopwatch',
    title: 'Stopwatch',
    what: 'A start/stop/reset timer, used to check that stateful interaction and effect cleanup actually work on this page.',
    addedBy: 'self-dev',
    ref: 'coder model test',
  },
  {
    key: 'theme_report',
    title: 'Theme report',
    what: 'Shows which theme and colour scheme this browser is actually being served, so a theme that fails to apply is visible here.',
    addedBy: 'self-dev',
    ref: 'instrument verification run',
  },
];
