// Behavioural verification for the stale-deploy chunk recovery, plus the wiring that uses it.
//
// Dependency-free (imports the pure module only), so it runs in CI's no-install guards job.
// Run:  node scripts/verify-stale-chunk.mjs
//
// Rob, 2026-09-28: "Im also getting this alot in the first stages of morpheus — Something broke on
// this screen. Failed to fetch dynamically imported module:
// https://morpheus.nz/assets/Workspace-Dp8wM2AG.js". Every route is a `lazy()` import and Vite
// hashes each chunk name, so a page left open across a deploy asks the CDN for a file that has been
// replaced; the import 404s and the ErrorBoundary reports a crash. The two things that must hold:
// the common case reloads itself ONCE, and a genuine failure (or an offline device) can never become
// a reload loop.
import { readFileSync } from 'node:fs';
import {
  isStaleChunkError, shouldReloadForStaleChunk, markStaleChunkReload, clearStaleChunkMark,
  recoverFromStaleChunk, STALE_CHUNK_KEY, RELOAD_COOLDOWN_MS,
} from '../src/lib/staleChunk.js';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

// A minimal sessionStorage stand-in; `broken` models Safari private mode, where any access throws.
function fakeStorage(broken = false) {
  const map = new Map();
  return {
    getItem: (k) => { if (broken) throw new Error('denied'); return map.has(k) ? map.get(k) : null; },
    setItem: (k, v) => { if (broken) throw new Error('denied'); map.set(k, String(v)); },
    removeItem: (k) => { if (broken) throw new Error('denied'); map.delete(k); },
  };
}

console.log('\n1. a stale deploy is recognised, and a real bug is not');
check('the exact message Rob saw', isStaleChunkError(new Error('Failed to fetch dynamically imported module: https://morpheus.nz/assets/Workspace-Dp8wM2AG.js')), true);
check('Safari names it differently', isStaleChunkError(new Error('Importing a module script failed.')), true);
check('Firefox names it differently again', isStaleChunkError(new Error('error loading dynamically imported module')), true);
check('a plain render bug is NOT treated as a deploy', isStaleChunkError(new Error('Cannot read properties of undefined (reading \'name\')')), false);
check('a network failure on an API call is not treated as a deploy', isStaleChunkError(new Error('Failed to fetch')), false);
check('nothing at all does not crash the classifier', isStaleChunkError(undefined), false);

console.log('\n2. it reloads once, and cannot loop');
check('the first occurrence reloads', shouldReloadForStaleChunk(1_000_000, fakeStorage()), true);
{
  const s = fakeStorage();
  markStaleChunkReload(1_000_000, s);
  check('a second occurrence inside the cooldown does NOT', shouldReloadForStaleChunk(1_000_000 + RELOAD_COOLDOWN_MS - 1, s), false);
  check('…and after the cooldown it does again', shouldReloadForStaleChunk(1_000_000 + RELOAD_COOLDOWN_MS, s), true);
  check('the marker is what is stored', s.getItem(STALE_CHUNK_KEY), '1000000');
  clearStaleChunkMark(s);
  check('clearing it (the app came up) allows the next deploy its own recovery', shouldReloadForStaleChunk(1_000_001, s), true);
}

console.log('\n3. storage being unavailable cannot break the recovery, or the app');
{
  const broken = fakeStorage(true);
  check('a denied read still decides to reload', shouldReloadForStaleChunk(5, broken), true);
  check('a denied write does not throw', (() => { markStaleChunkReload(5, broken); return 'no throw'; })(), 'no throw');
  check('a denied clear does not throw', (() => { clearStaleChunkMark(broken); return 'no throw'; })(), 'no throw');
  check('missing storage entirely does not throw', (() => { recoverFromStaleChunk({ storage: undefined, reload: () => {}, now: 5 }); return 'no throw'; })(), 'no throw');
}
{
  let reloads = 0;
  const s = fakeStorage();
  const first = recoverFromStaleChunk({ storage: s, reload: () => { reloads++; }, now: 7 });
  const second = recoverFromStaleChunk({ storage: s, reload: () => { reloads++; }, now: 7 + 10 });
  check('one recovery performs exactly one reload', reloads, 1);
  check('…and reports which call reloaded', [first, second], [true, false]);
}

console.log('\n4. both call sites use it rather than deciding for themselves');
const main = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const boundary = readFileSync(new URL('../src/components/RootErrorBoundary.jsx', import.meta.url), 'utf8');
check('the entry point listens for Vite\'s preload error', /addEventListener\('vite:preloadError'/.test(main), true);
check('…and stops Vite also rejecting the import', /event\.preventDefault\?\.\(\)/.test(main), true);
check('…and clears the marker once the app is up', /clearStaleChunkMark\(window\.sessionStorage\)/.test(main), true);
check('the boundary classifies the error instead of only printing it',
  /static getDerivedStateFromError\(error\) \{[\s\S]{0,120}?isStaleChunkError\(error\)/.test(boundary), true);
check('…and attempts the same one-shot recovery', /recoverFromStaleChunk\(\{ storage: window\.sessionStorage/.test(boundary), true);
check('…and tells the operator it was a deploy, not a fault',
  /Morpheus was updated while this page was open\./.test(boundary) && /Something broke on this screen\./.test(boundary), true);
check('neither call site reimplements the cooldown',
  /RELOAD_COOLDOWN_MS/.test(main) || /RELOAD_COOLDOWN_MS/.test(boundary), false);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('all good\n');
