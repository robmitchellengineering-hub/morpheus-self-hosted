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
  selectBackfillUrls, normalizeLedgerRow, boundLedger, isAccepted, summarizeLedger, NOT_BUILT, HANDLED,
} from '../server/src/lib/indexNow.js';
import { isNewer } from '../server/src/lib/version.js';

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
const unescapeSlashes = (s) => String(s).replace(/\\/g, '');

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
check('every unbuilt part of the plan is named in the lib', Object.keys(NOT_BUILT).sort(), ['areas', 'gbp', 'orphans']);
check('the tab renders the not-built list rather than omitting it', has(tab, 'not_built'), true);
check('the plugin names them too, so the tab cannot invent the list', has(plugin, "'not_built'"), true);
// ⚠️ THIS CHECK USED TO ASSERT THE OPPOSITE, AND IT WAS THE REASON A FALSE CLAIM SURVIVED.
//
// It read `['areas','gbp','orphans','sitemap']` — so a guard whose whole job is "the panel
// must not imply something exists when it does not" was pinning "Sitemap hygiene is not
// built yet." in place while the plugin was doing exactly that (robots.txt pointed at the
// live sitemap, dead paths replaced, eight harness assertions behind it). A guard can
// enforce a LIE as faithfully as a truth; only reading it against the code catches that.
//
// The lists are now paired: what is not built, and what is — and the plugin must ship the
// same words for both, because the tab renders whatever the plugin sends.
check('…and what IS built is named too, so the panel cannot under-claim', Object.keys(HANDLED).sort(), ['sitemap']);
check('…and the tab renders that list as well', has(tab, 'handled'), true);
check('…and the plugin names it, not the tab', has(plugin, "'handled'"), true);
for (const [key, words] of Object.entries({ ...NOT_BUILT, ...HANDLED })) {
  // Compared with backslashes removed: the lib is JS and writes `Google\'s` for the
  // apostrophe, the plugin is PHP and writes the same escape — but only the VALUE is
  // the claim. Comparing the escaped source text would fail on the quoting, not the words.
  check(`…and the plugin ships the same words for '${key}'`, has(unescapeSlashes(plugin), unescapeSlashes(words)), true);
}

// ── 3. the cross-boundary contracts ─────────────────────────────────────────
console.log('\n3. the contracts across the boundary');

// 3a. the actions the app sends must be the actions the plugin answers.
const switchBlock = (plugin.match(/switch \( \$action \)[\s\S]*?\n\t\t\}/) || [''])[0];
const pluginActions = uniq([...switchBlock.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]));
check('the plugin answers exactly the actions the app can send', pluginActions, [...TRAFFIC_ACTIONS].sort());
check('the app refuses an action the plugin does not have', TRAFFIC_ACTIONS.includes('delete_everything'), false);

// 3b. the widget scope must be exactly what the tab invokes — no free privilege.
//
// ⚠️ THE TAB IS TWO FILES NOW. Redirects live in their own component (the panel is
// large and the tab was already long), so a check that read only TrafficTab.jsx would
// have gone on passing while the new function's scope entry was unverified — the
// "a check that never ran reads as a check that passed" shape, one file over.
const tokenSrc = read('server/src/lib/widgetToken.js');
const redirectsPanel = read('src/components/matrix/website/RedirectsPanel.jsx');
const scopeBlock = (tokenSrc.match(/traffic: \[([^\]]*)\]/) || ['', ''])[1];
const scopeFns = uniq([...scopeBlock.matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
const invoked = uniq([
  ...[...tab.matchAll(/functions\.invoke\(\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]),
  ...[...redirectsPanel.matchAll(/functions\.invoke\(\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]),
]);
check('the surface invokes exactly the two functions this scope grants (parser sanity)', invoked, ['trafficAction', 'wordPressRedirects']);
check('the traffic scope lists exactly what the surface invokes', scopeFns, invoked);
check('the traffic scope does not borrow the SEO scope\'s functions', scopeFns.includes('wordPressSeoAction'), false);
// The widening is deliberate (see widgetToken.js) — what must NOT creep in is a
// function that writes FILES or applies updates, which is a different power.
check('…and grants nothing that writes files or applies updates',
  scopeFns.filter((f) => /Deploy|Apply|Fix|Maintenance/i.test(f)), []);

// 3c. the caps on both sides are one fact in two files.
const num = (src, re) => { const m = src.match(re); return m ? Number(m[1]) : null; };
check('the ledger cap agrees across the boundary', [num(plugin, /MAX_LEDGER\s*=\s*(\d+)/), LEDGER_LIMIT], [LEDGER_LIMIT, LEDGER_LIMIT]);
check('the batch cap agrees across the boundary', [num(plugin, /MAX_BATCH\s*=\s*(\d+)/), MAX_URLS_PER_REQUEST], [MAX_URLS_PER_REQUEST, MAX_URLS_PER_REQUEST]);
check('the backfill cap agrees across the boundary', [num(plugin, /MAX_BACKFILL\s*=\s*(\d+)/), MAX_BACKFILL], [MAX_BACKFILL, MAX_BACKFILL]);
check('our batch cap is not claimed to be the spec\'s (it documents 10,000)', has(plugin, '10,000 URLs per post'), true);
check('the lib does not claim 100 is the spec ceiling either', has(read('server/src/lib/indexNow.js'), 'NOT IndexNow\'s'), true);

// 3c-ii. WHICH pages get announced is the site's business, not a constant.
//
// The same hard-coded `array( 'post', 'page', 'product' )` lived here as well as
// in the SEO module, so publishing the store's `services` CPT never told IndexNow
// about it — a page that is in the sitemap and reachable, handed to the index by
// nothing. Both modules now read one helper, so the two lists cannot drift apart
// either.
check('the traffic module no longer declares a post-type constant', /const POST_TYPES\s*=/.test(plugin), false);
check('…no call site still reads the old constant', /self::POST_TYPES/.test(plugin), false);
check('…and no hard-coded three-type list survives in it', /array\(\s*'post'\s*,\s*'page'\s*,\s*'product'\s*\)/.test(plugin), false);
check('…it announces the site\'s own public types instead', /morpheus_public_post_types\(\)/.test(plugin), true);

// 3d. one component, mounted by both surfaces — the dock must not fork a tab.
const panel = read('src/components/matrix/WebsitePanel.jsx');
const embed = read('src/pages/Embed.jsx');
const embedTab = read('src/components/matrix/website/EmbedTab.jsx');
check('the app panel mounts the shared TrafficTab', has(panel, "import TrafficTab from './website/TrafficTab'") && has(panel, '<TrafficTab'), true);
check('the app panel has a TRAFFIC tab', has(panel, "id: 'traffic'"), true);
check('the dock mounts the SAME component', has(embed, "import TrafficTab from '@/components/matrix/website/TrafficTab'") && has(embed, '<TrafficTab'), true);
check('the dock has a traffic tab gated on the traffic scope', has(embed, "scope: 'traffic', id: 'traffic'"), true);
check('a widget token can carry the traffic scope', has(embedTab, "id: 'traffic'"), true);
// The tab is served by the plugin, so on a project with no site connected its only
// possible answer is "connect first". It was absent from this list until 2026-10-08,
// so it looked available and then refused — the one tab disagreeing with its siblings.
check('the panel greys TRAFFIC out when no site is connected', /const gated = \[[^\]]*'traffic'[^\]]*\]/.test(panel), true);

// 3e. the capability is visible on /status, not only through a signed call.
// `Morpheus_Traffic::public_status()` documents itself as "the public half: what the
// /status route adds" and was called from NOWHERE, so the module was invisible to the
// one payload that answers "what can this build do?" — while clean, seo, store, export
// and pairing all appear there. Asserted on both halves: the key exists, and it is that
// method rather than a second copy of its two fields.
const restPhp = read('wp-plugin/morpheus/includes/class-rest.php');
check('the status payload carries a traffic key', /'traffic'\s*=>/.test(restPhp), true);
check('…and it comes from the module\'s own public_status()', /Morpheus_Traffic::public_status\(\)/.test(restPhp), true);
check('…guarded, so a build without the module still answers', /class_exists\( 'Morpheus_Traffic' \)/.test(restPhp), true);

// 3e. the plugin is wired, not merely present on disk.
const bootstrap = read('wp-plugin/morpheus/morpheus.php');
check('the plugin includes the module', has(bootstrap, "require_once MORPHEUS_DIR . 'includes/class-traffic.php'"), true);
check('the plugin initialises it', has(bootstrap, 'Morpheus_Traffic::init()'), true);
check('the plugin registers its route', has(bootstrap, "array( 'Morpheus_Traffic', 'register_routes' )"), true);
check('activation creates the key and flushes the rewrite', has(bootstrap, 'Morpheus_Traffic::activate()'), true);
check('the publish hook is wired', has(plugin, "add_action( 'transition_post_status'"), true);
check('the submission runs on cron, so publishing never waits on IndexNow', has(plugin, 'wp_schedule_single_event'), true);
check('the feature is off until the operator turns it on', has(plugin, "'enabled' => ! empty( \$o['enabled'] )"), true);

// The key URL depends on two things source-reading alone would miss, and both were
// wrong on a live site (valiantmusic.com.au, 2026-10-08 — the panel correctly said
// "NOT confirmed served" and the cause was ours, not the host's).
//
// Read through stripComments, like the checks above: this file's own prose quotes
// `flush_rewrite_rules()` while explaining why it is needed, and a raw scan would
// collect the explanation as if it were the code (H19's shape).
const bootstrapCode = stripComments(bootstrap);
//
// 1) Rewrite rules are SERVED FROM AN OPTION. `add_rewrite_rule()` only fills
//    memory; the option is rebuilt by a flush. The activation hook flushes, and
//    WordPress does NOT run activation hooks when it UPDATES a plugin — so a rule
//    added in a new version stayed inert on every site that updated, and the only
//    cure was a manual Settings → Permalinks save. The proof it was the stale
//    option and not the rule: core's own /wp-sitemap.xml answered 200 (the option
//    is present) while a 32-hex .txt answered the theme's 404 with ~121 KB of HTML
//    (the rule is not in it), where this handler's own refusal is a BARE 404.
check('a version change flushes the rewrite rules, so a new rule is not inert',
  /add_action\( 'wp_loaded'/.test(bootstrapCode)
  && /get_option\( 'morpheus_rewrite_version' \) === MORPHEUS_VERSION/.test(bootstrapCode)
  && /flush_rewrite_rules\(\)/.test(bootstrapCode), true);
// 2) `redirect_canonical` is registered on template_redirect at priority 10 by
//    core's default-filters, which load before any plugin — so at the default
//    priority it answered a correct key URL with a 301 to `/<key>.txt/` first, and
//    this handler only ran on the redirected request. The key was served, through
//    a hop nothing asked for; priority 1 serves it directly, as class-redirects.php
//    already does for the same reason.
check('the key handler runs before WordPress\'s canonical redirect',
  /add_action\( 'template_redirect', array\( __CLASS__, 'maybe_serve_key' \), 1 \)/.test(plugin), true);
// 3) A FAILED key check must not be cached like a good one: the operator fixes the
//    rewrite, the panel re-asks, and it has to notice — not keep telling them it is
//    still broken for up to an hour with nothing to say the answer was old.
check('a failed key check is cached briefly, not for an hour',
  /self::KEY_CHECK_MISS_TTL/.test(plugin) && /\$out\['served'\] \? self::KEY_CHECK_TTL : self::KEY_CHECK_MISS_TTL/.test(plugin), true);

// ── a URL is announced only if a search engine should hear about it ─────────
//
// Rob's own ledger, 2026-10-08: 216 URLs submitted, and fifteen of them were builder
// internals — `?elementor_library=default-kit`, `?cms_block=equipment-repair`,
// `woodmart_layout/product-archive-layout/` — plus `/cart/`, `/my-account/` and
// `/wishlist/`. `public => true` is not the question that matters, and no post-type rule
// can ever exclude a shop's utility PAGES.
const helpersIdx = read('wp-plugin/morpheus/includes/helpers.php')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('the post-type question is not `public`', /publicly_queryable/.test(helpersIdx), true);
check('…a type the SITE keeps out of search is skipped', /! empty\( \$type->exclude_from_search \)/.test(helpersIdx), true);
check('…and a type with no rewrite is skipped, because its permalink is a query string',
  /empty\( \$type->rewrite \)/.test(helpersIdx), true);
check('a URL that is nothing but a query string is refused',
  /'' === trim\( \$path, '\/' \)/.test(plugin), true);
check('…and the store\'s own utility pages are refused',
  /if \( function_exists\( 'wc_get_page_id' \) \) \{/.test(plugin), true);
check('…with a FILTER, so another shop is not a guess', /morpheus_announce_url/.test(plugin), true);
// TWO call sites — the publish path and the backfill. Missing one is a half-fix that the
// ledger would show again on the very next backfill.
check('…applied on BOTH paths: publishing and the backfill',
  (plugin.match(/self::announceable\(/g) || []).length >= 2, true);

// The version is bumped in all three places verify-pairing also checks.
//
// Asserted as "at or beyond 0.7.0", NOT equality. This capability SHIPPED in
// 0.7.0; demanding equality made the guard fail the first time any other change
// bumped the plugin (0.7.1), which is a gate failing for a reason that is not the
// code — the worst kind. Same shape as verify-pairing's own threshold check.
const atLeast = (v, floor) => v === floor || isNewer(v, floor);
const readme = read('wp-plugin/morpheus/readme.txt');
const version = (bootstrap.match(/MORPHEUS_VERSION',\s*'([\d.]+)'/) || [, ''])[1];
check('the plugin is at or beyond 0.7.0, the version this capability shipped in', atLeast(version, '0.7.0'), true);
check('the readme stable tag is at or beyond 0.7.0', atLeast((readme.match(/Stable tag:\s*([\d.]+)/) || [, ''])[1], '0.7.0'), true);
check('the changelog has a 0.7.0 entry describing the feature', has(readme, '= 0.7.0 =') && has(readme, 'IndexNow'), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\nThe traffic contracts do not hold. Fix before merging.\n');
  process.exit(1);
}
console.log('traffic (IndexNow) holds.\n');
