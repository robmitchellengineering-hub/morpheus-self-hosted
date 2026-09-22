// Runtime verification for the TRAFFIC tab — the IndexNow workflow and, more
// importantly, the contracts that cross a boundary no compiler checks.
//
// Dependency-free on purpose, so it runs in CI's no-install guards job: the only
// import is the pure lib, and everything else is read from source.
//
// Three groups, and the third is the one that rots silently:
//
//   1. the pure decisions — payload shape, key rule, batching, backfill
//      selection, ledger bounding and its summary
//   2. honesty — 200 and 202 are different states, nothing claims a page was
//      INDEXED, and the parts of the plan that are not built are named
//   3. THE CROSS-BOUNDARY CONTRACTS — the app's action list against the plugin's
//      switch, the widget scope against what the tab actually invokes, the caps
//      on both sides, and the tab being mounted by BOTH surfaces. Each of these
//      fails at runtime on a customer's site as a silent 400 or a missing tab,
//      which is exactly the kind of failure a guard exists to move earlier.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  INDEXNOW_ENDPOINT, MAX_URLS_PER_REQUEST, LEDGER_LIMIT, MAX_BACKFILL, TRAFFIC_ACTIONS,
  isValidKey, hostFromSiteUrl, keyLocation, buildPayload, chunkUrls,
  selectBackfillUrls, normalizeLedgerRow, boundLedger, isAccepted, summarizeLedger, NOT_BUILT,
} from '../server/src/lib/indexNow.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

let checks = 0;
let failures = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`);
    failures++;
  }
}

const has = (haystack, needle) => String(haystack).includes(needle);
const uniq = (list) => [...new Set(list)].sort();

console.log('\nTraffic — IndexNow submission and its contracts\n');

// ── 1. the pure decisions ───────────────────────────────────────────────────
console.log('1. the payload, the key rule, and the bounds');

check('the endpoint is IndexNow\'s own', INDEXNOW_ENDPOINT, 'https://api.indexnow.org/indexnow');
check('a host is taken from the site URL', hostFromSiteUrl('https://valiantmusic.com.au'), 'valiantmusic.com.au');
check('a scheme-less site URL still yields a host', hostFromSiteUrl('valiantmusic.com.au'), 'valiantmusic.com.au');
check('a URL with a path still yields just the host', hostFromSiteUrl('https://shop.test/wp/'), 'shop.test');
check('an unusable site URL yields nothing', hostFromSiteUrl(''), '');

const KEY = 'a'.repeat(32);
check('our generated key shape is valid', isValidKey(KEY), true);
check('a too-short key is refused', isValidKey('abc'), false);
check('a non-hex key is refused (our rule, see the lib comment)', isValidKey('myIndexNowKey63638'), false);
check('the key location is on the site itself', keyLocation('https://shop.test', KEY), `https://shop.test/${KEY}.txt`);

const payload = buildPayload({ siteUrl: 'https://shop.test', key: KEY, urls: ['https://shop.test/a', 'https://shop.test/b'] });
check('the payload carries the host, key and location', [payload.host, payload.key, payload.keyLocation], ['shop.test', KEY, `https://shop.test/${KEY}.txt`]);
check('the payload carries the URLs', payload.urlList, ['https://shop.test/a', 'https://shop.test/b']);
check('duplicate URLs are collapsed', buildPayload({ siteUrl: 'https://shop.test', key: KEY, urls: ['https://shop.test/a', 'https://shop.test/a'] }).urlList, ['https://shop.test/a']);

let threw = null;
try { buildPayload({ siteUrl: 'https://shop.test', key: KEY, urls: ['https://other.test/a'] }); } catch (e) { threw = e.message; }
check('a URL from another host is refused locally, not sent to be rejected', has(threw, 'own host'), true);
threw = null;
try { buildPayload({ siteUrl: 'https://shop.test', key: 'nope', urls: ['https://shop.test/a'] }); } catch (e) { threw = e.message; }
check('an invalid key refuses to build a payload at all', has(threw, 'valid key'), true);
threw = null;
try { buildPayload({ siteUrl: '', key: KEY, urls: ['https://shop.test/a'] }); } catch (e) { threw = e.message; }
check('no site URL refuses to build a payload', has(threw, 'site URL'), true);

// Batching and the backfill's idempotence.
check('269 URLs split into 3 batches of at most 100', chunkUrls(Array.from({ length: 269 }, (_, i) => `https://s.test/${i}`)).map((b) => b.length), [100, 100, 69]);
check('an empty list asks for no batches', chunkUrls([]).length, 0);

const allUrls = Array.from({ length: 250 }, (_, i) => `https://s.test/${i}`);
const accepted = new Set(['https://s.test/0', 'https://s.test/1']);
const todo = selectBackfillUrls({ urls: allUrls, accepted, limit: MAX_BACKFILL });
check('an already-accepted URL is not submitted again', todo.includes('https://s.test/0'), false);
check('the rest are, up to the per-run cap', todo.length, MAX_BACKFILL);
check('so pressing backfill twice does nothing the second time', selectBackfillUrls({ urls: allUrls, accepted: new Set(allUrls), limit: MAX_BACKFILL }).length, 0);

// The ledger: bounded, and summarised without inventing a number.
const rows = [
  { at: '2026-09-22T10:00:00Z', url: 'https://s.test/a', action: 'publish', status: 200, note: 'submitted' },
  { at: '2026-09-22T09:00:00Z', url: 'https://s.test/b', action: 'publish', status: 202, note: 'received — key validation pending' },
  { at: '2026-09-22T08:00:00Z', url: 'https://s.test/c', action: 'backfill', status: 403, note: 'forbidden' },
  { url: '', status: 200 },
];
check('a row with no URL is dropped, not guessed at', boundLedger(rows).length, 3);
check('a non-numeric status becomes 0, never a made-up code', boundLedger([{ url: 'https://s.test/x', status: 'ok' }])[0].status, 0);
check('a long note is truncated', boundLedger([{ url: 'https://s.test/x', status: 200, note: 'z'.repeat(500) }])[0].note.length, 120);
check('the ledger is capped', boundLedger(Array.from({ length: 900 }, (_, i) => ({ url: `https://s.test/${i}`, status: 200 })), LEDGER_LIMIT).length, LEDGER_LIMIT);
const sum = summarizeLedger(rows);
check('the summary counts what was submitted', sum.submitted, 3);
check('200 and 202 both count as accepted', sum.accepted, 2);
check('a 403 counts as failed', sum.failed, 1);
check('the most recent accepted submission is reported', sum.lastOk, '2026-09-22T10:00:00Z');
check('an empty ledger summarises to nothing, not to a zero rate', summarizeLedger([]), { submitted: 0, accepted: 0, failed: 0, lastOk: null });

// ── 2. honesty ──────────────────────────────────────────────────────────────
console.log('\n2. what this feature is allowed to claim');

// Comments are stripped before asserting on source. TrafficTab's own header
// explains this rule in prose — "…was indexed, so this tab never says 'indexed'"
// — and an unstripped scan counted that sentence as the violation it warns
// against. verify-seo.mjs documents the same trap after a comment was collected
// as if it were code. The parser-sanity checks below fail if this strip ever eats
// the code instead, so the check keeps its teeth either way.
const stripComments = (src) => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const tab = stripComments(read('src/components/matrix/website/TrafficTab.jsx'));
const plugin = stripComments(read('wp-plugin/morpheus/includes/class-traffic.php'));

// These assert the LIVE branch, not merely that the words exist somewhere in the
// file. The first version of this check passed with the 202 branch made dead
// (`if ( false )`) because the note string was still present — a check that
// passes for the wrong reason is worse than no check, so it now matches the
// condition and its return together.
check('200 has its own live branch', /if \( 200 === \$status \) \{\s*return '[^']*';/.test(plugin), true);
check('202 has its own live branch, and says key validation is pending', /if \( 202 === \$status \) \{\s*return '[^']*key validation pending/.test(plugin), true);
check('the status note for 403 blames the key file', /if \( 403 === \$status \) \{\s*return '[^']*key file was not found/.test(plugin), true);
check('nothing in the tab claims a page was indexed', /was indexed|is indexed|indexed successfully/i.test(tab), false);
check('the tab says what a 2xx actually means', has(tab, 'the submission was accepted'), true);
check('the tab shows the real status code per row', has(tab, '{row.status ||'), true);
check('every unbuilt part of the plan is named in the lib', Object.keys(NOT_BUILT).sort(), ['areas', 'gbp', 'orphans', 'sitemap']);
check('the tab renders the not-built list rather than omitting it', has(tab, 'not_built'), true);
check('the plugin names them too, so the tab cannot invent the list', has(plugin, "'not_built'"), true);

// ── 3. the cross-boundary contracts ─────────────────────────────────────────
console.log('\n3. the contracts across the boundary');

// 3a. the actions the app sends must be the actions the plugin answers.
const switchBlock = (plugin.match(/switch \( \$action \)[\s\S]*?\n\t\t\}/) || [''])[0];
const pluginActions = uniq([...switchBlock.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]));
check('the plugin answers exactly the actions the app can send', pluginActions, [...TRAFFIC_ACTIONS].sort());
check('the app refuses an action the plugin does not have', TRAFFIC_ACTIONS.includes('delete_everything'), false);

// 3b. the widget scope must be exactly what the tab invokes — no free privilege.
const tokenSrc = read('server/src/lib/widgetToken.js');
const scopeBlock = (tokenSrc.match(/traffic: \[([^\]]*)\]/) || ['', ''])[1];
const scopeFns = uniq([...scopeBlock.matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
const invoked = uniq([...tab.matchAll(/functions\.invoke\(\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
check('the tab invokes exactly one function (parser sanity)', invoked, ['trafficAction']);
check('the traffic scope lists exactly what the tab invokes', scopeFns, invoked);
check('the traffic scope does not borrow the SEO scope\'s functions', scopeFns.includes('wordPressSeoAction'), false);

// 3c. the caps on both sides are one fact in two files.
const num = (src, re) => { const m = src.match(re); return m ? Number(m[1]) : null; };
check('the ledger cap agrees across the boundary', [num(plugin, /MAX_LEDGER\s*=\s*(\d+)/), LEDGER_LIMIT], [LEDGER_LIMIT, LEDGER_LIMIT]);
check('the batch cap agrees across the boundary', [num(plugin, /MAX_BATCH\s*=\s*(\d+)/), MAX_URLS_PER_REQUEST], [MAX_URLS_PER_REQUEST, MAX_URLS_PER_REQUEST]);
check('the backfill cap agrees across the boundary', [num(plugin, /MAX_BACKFILL\s*=\s*(\d+)/), MAX_BACKFILL], [MAX_BACKFILL, MAX_BACKFILL]);
check('our batch cap is not claimed to be the spec\'s (it documents 10,000)', has(plugin, '10,000 URLs per post'), true);
check('the lib does not claim 100 is the spec ceiling either', has(read('server/src/lib/indexNow.js'), 'NOT IndexNow\'s'), true);

// 3d. one component, mounted by both surfaces — the dock must not fork a tab.
const panel = read('src/components/matrix/WebsitePanel.jsx');
const embed = read('src/pages/Embed.jsx');
const embedTab = read('src/components/matrix/website/EmbedTab.jsx');
check('the app panel mounts the shared TrafficTab', has(panel, "import TrafficTab from './website/TrafficTab'") && has(panel, '<TrafficTab'), true);
check('the app panel has a TRAFFIC tab', has(panel, "id: 'traffic'"), true);
check('the dock mounts the SAME component', has(embed, "import TrafficTab from '@/components/matrix/website/TrafficTab'") && has(embed, '<TrafficTab'), true);
check('the dock has a traffic tab gated on the traffic scope', has(embed, "scope: 'traffic', id: 'traffic'"), true);
check('a widget token can carry the traffic scope', has(embedTab, "id: 'traffic'"), true);

// 3e. the plugin is wired, not merely present on disk.
const bootstrap = read('wp-plugin/morpheus/morpheus.php');
check('the plugin includes the module', has(bootstrap, "require_once MORPHEUS_DIR . 'includes/class-traffic.php'"), true);
check('the plugin initialises it', has(bootstrap, 'Morpheus_Traffic::init()'), true);
check('the plugin registers its route', has(bootstrap, "array( 'Morpheus_Traffic', 'register_routes' )"), true);
check('activation creates the key and flushes the rewrite', has(bootstrap, 'Morpheus_Traffic::activate()'), true);
check('the publish hook is wired', has(plugin, "add_action( 'transition_post_status'"), true);
check('the submission runs on cron, so publishing never waits on IndexNow', has(plugin, 'wp_schedule_single_event'), true);
check('the feature is off until the operator turns it on', has(plugin, "'enabled' => ! empty( \$o['enabled'] )"), true);

// The version is bumped in all three places verify-pairing also checks.
const readme = read('wp-plugin/morpheus/readme.txt');
const version = (bootstrap.match(/MORPHEUS_VERSION',\s*'([\d.]+)'/) || [, ''])[1];
check('the plugin version is 0.7.0 for this capability', version, '0.7.0');
check('the readme stable tag matches', (readme.match(/Stable tag:\s*([\d.]+)/) || [, ''])[1], '0.7.0');
check('the changelog has a 0.7.0 entry describing the feature', has(readme, '= 0.7.0 =') && has(readme, 'IndexNow'), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\nThe traffic contracts do not hold. Fix before merging.\n');
  process.exit(1);
}
console.log('traffic (IndexNow) holds.\n');
