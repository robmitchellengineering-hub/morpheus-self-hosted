// Search Console integration: the rules that make its numbers trustworthy.
//
// WHY THIS EXISTS
//
// This feature puts numbers in front of someone who will act on them, so the
// failure mode is not a crash — it is a plausible wrong number, or a real number
// presented as something it is not. Three rules carry that weight and none of
// them is visible in a screenshot:
//
//   1. every figure comes from Google for the account's OWN property, and the
//      payload has no field for an estimate (no volume, difficulty, CPC,
//      backlinks — the same discipline as keyword research);
//   2. "low CTR" is judged against the SITE'S OWN data at that position, not an
//      industry benchmark, because a generic CTR-by-position table is fabricated
//      precision the operator cannot check;
//   3. an aggregate position is impression-weighted, so a site ranking #1 for a
//      term nobody searches cannot make a #40 term look average.
//
// Plus one security rule with nothing to do with SEO: the OAuth callback's
// `returnTo` is attacker-supplied and ends up in a Location header.
//
// Both imported modules are pure and dependency-free, which is what lets this run
// in the no-install guards job — lib/searchConsole.js itself reaches Prisma
// through db.js (hazard H4), so nothing here may import it.
//
// Run:  node scripts/verify-search-console.mjs
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  positionBand, totals, positionalBaseline, strikingDistance, lowCtr, topRows,
  bandsWithoutBaseline, buildOverview, describeGoogleError,
  POSITION_BANDS, STRIKING_MIN_POSITION, STRIKING_MAX_POSITION, STRIKING_MIN_IMPRESSIONS,
} from '../server/src/lib/searchConsoleInsights.js';
import { safeReturnTo, DEFAULT_RETURN_TO } from '../server/src/lib/safeRedirect.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

let pass = 0;
let fail = 0;
const problems = [];

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log(`          expected ${JSON.stringify(want)}\n          got      ${JSON.stringify(got)}`);
    problems.push(name);
  }
  ok ? pass++ : fail++;
}

// A fixture with the shapes that matter: a brand term at #1, a real near-miss
// with a lot of impressions, a one-row band, and a query with almost no data.
const ROWS = [
  { keys: ['brand term'], clicks: 100, impressions: 1000, ctr: 0.1, position: 1.5 },
  { keys: ['near miss'], clicks: 5, impressions: 2000, ctr: 0.0025, position: 11.2 },
  { keys: ['too far'], clicks: 1, impressions: 500, ctr: 0.002, position: 45 },
  { keys: ['barely seen'], clicks: 0, impressions: 3, ctr: 0, position: 12 },
];

console.log('\n1. aggregates are the quantities Search Console itself reports')

const t = totals(ROWS);
check('clicks sum', t.clicks, 106);
check('impressions sum', t.impressions, 3503);
// CTR from the totals (clicks ÷ impressions), NOT the mean of the rows' CTRs —
// averaging ratios weights a 3-impression row the same as a 2,000-impression one.
check('ctr is derived from the totals', t.ctr, 106 / 3503);
check('ctr is not the mean of the row CTRs', t.ctr === (0.1 + 0.0025 + 0.002 + 0) / 4, false);
// Position weighted by impressions: (1.5×1000 + 11.2×2000 + 45×500 + 12×3) / 3503
check('position is impression-weighted', t.position, (1.5 * 1000 + 11.2 * 2000 + 45 * 500 + 12 * 3) / 3503);
check('position is not the plain mean', t.position === (1.5 + 11.2 + 45 + 12) / 4, false);

console.log('\n2. an empty result is not a zero')

const empty = totals([]);
check('no clicks', empty.clicks, 0);
check('ctr is null, not 0% — "no data" must not read as "nobody clicked"', empty.ctr, null);
check('position is null, not 0', empty.position, null);

console.log('\n3. striking distance is page one\'s tail, and only that')

const striking = strikingDistance(ROWS);
check('the near-miss at 11.2 is included', striking.map((r) => r.key), ['near miss']);
check('a position past the band is excluded', striking.some((r) => r.key === 'too far'), false);
check('a position inside the band but with almost no impressions is excluded', striking.some((r) => r.key === 'barely seen'), false);
check('the band starts at 8', STRIKING_MIN_POSITION, 8);
check('the band ends at 20', STRIKING_MAX_POSITION, 20);
check('position 8 is in the band', positionBand(8), '8-20');
check('position 7 is not', positionBand(7), '4-7');
check('position 20 is in the band', positionBand(20), '8-20');
check('position 21 is not', positionBand(21), '21-50');
check('every band is reachable', POSITION_BANDS.length, 5);
// Sorted by impressions: the honest proxy for "do this first" when there is no
// volume data to rank by.
const byImpressions = strikingDistance([
  { keys: ['small'], clicks: 0, impressions: STRIKING_MIN_IMPRESSIONS, ctr: 0.01, position: 10 },
  { keys: ['big'], clicks: 1, impressions: 900, ctr: 0.001, position: 12 },
]);
check('sorted by impressions, biggest first', byImpressions.map((r) => r.key), ['big', 'small']);

console.log('\n4. "low CTR" compares a query to this site, at this position')

// Band 4-7 with the site's own median at 0.10, so "half the site's median" is
// 0.05. The fixture is chosen so the rule CANNOT be confused with a fixed
// threshold: 'weak' (0.03) sits below the site's half-median but ABOVE a 2%
// threshold, and 'near' (0.06) sits above the half-median but below an 8% one.
// The first version of this fixture used a 0.04 median, which made half the
// median exactly 0.02 — the same as the fixed threshold it was meant to rule
// out, so both rules agreed on every row and the check proved nothing.
const bandRows = [
  { keys: ['a'], clicks: 10, impressions: 100, ctr: 0.1, position: 5 },
  { keys: ['b'], clicks: 10, impressions: 100, ctr: 0.1, position: 5.5 },
  { keys: ['c'], clicks: 10, impressions: 100, ctr: 0.1, position: 6 },
  { keys: ['weak'], clicks: 9, impressions: 300, ctr: 0.03, position: 5 },     // below the site's own bar
  { keys: ['near'], clicks: 12, impressions: 200, ctr: 0.06, position: 5 },    // above it — must NOT be flagged
  { keys: ['strong'], clicks: 40, impressions: 100, ctr: 0.4, position: 5 },   // far above
];
const flagged = lowCtr(bandRows);
check('only the row under this site\'s own bar is flagged', flagged.map((r) => r.key), ['weak']);
check('a row merely below a generic CTR threshold is not flagged', flagged.some((r) => r.key === 'near'), false);
check('the strong row is not', flagged.some((r) => r.key === 'strong'), false);
check('the flagged row carries the band it was judged in', flagged[0]?.band, '4-7');
check('…and the site\'s own median for that band', flagged[0]?.bandMedianCtr, 0.1);
check('…and how many rows that baseline rests on', flagged[0]?.bandRows, 6);

// A band with too little data must flag nothing: two rows make a median that is
// really just one of them, and every "finding" from it would be noise.
const thinBand = [
  { keys: ['x'], clicks: 4, impressions: 100, ctr: 0.5, position: 25 },
  { keys: ['y'], clicks: 0, impressions: 100, ctr: 0.001, position: 26 },
];
check('a band with fewer than three rows flags nothing', lowCtr(thinBand), []);
check('…and is reported as thin, so the UI can say why', bandsWithoutBaseline(thinBand), ['21-50']);

const baseline = positionalBaseline(bandRows);
check('the baseline counts the rows it rests on', baseline['4-7'].rows, 6);
check('…and its median is that band\'s own', baseline['4-7'].medianCtr, 0.1);
// "Per band" is the property that makes the comparison meaningful, so assert it
// directly: a second band with a wildly different CTR gets its own median, and
// the first band's is unchanged by it. (Subtracting rows here instead — the first
// version of this check just counted the first band's rows, which says nothing
// about whether the medians are separate.)
const twoBands = [
  ...bandRows,
  { keys: ['deep1'], clicks: 0, impressions: 100, ctr: 0.005, position: 30 },
  { keys: ['deep2'], clicks: 0, impressions: 100, ctr: 0.005, position: 31 },
  { keys: ['deep3'], clicks: 0, impressions: 100, ctr: 0.005, position: 32 },
];
const twoBaseline = positionalBaseline(twoBands);
check('a second band keeps its own median', twoBaseline['21-50'].medianCtr, 0.005);
check('…and does not move the first band\'s', twoBaseline['4-7'].medianCtr, 0.1);
check('bands with no rows are reported as unmeasured, not guessed', baseline['51+'].medianCtr, null);
check('…with a zero count behind them', baseline['51+'].rows, 0);

console.log('\n5. the payload has nowhere to put an invented number')

const overview = buildOverview({ queryRows: ROWS, pageRows: ROWS, days: 28, property: 'https://example.com/' });
const keys = new Set();
(function walk(node) {
  if (Array.isArray(node)) return node.forEach(walk);
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) { keys.add(k); walk(v); }
  }
})(overview);
const FORBIDDEN = /(volume|difficulty|search_volume|keyword_difficulty|cpc|cost_per_click|backlinks?|domain_authority|authority_score|traffic_value)/i;
check('no field for a metric Google does not give us', [...keys].filter((k) => FORBIDDEN.test(k)), []);
check('the shape is otherwise non-trivial (parser sanity)', keys.size > 12, true);
check('every row carries the signal that produced it', overview.topQueries.every((r) => r.signal === 'google-search-console'), true);
check('the provenance is part of the payload', /Google Search Console/.test(overview.disclosure.source), true);
check('…including what is NOT in it', /no backlinks method/i.test(overview.disclosure.notIncluded), true);
check('…and that nothing is estimated', /no volume, difficulty or ranking estimates/i.test(overview.disclosure.noEstimates), true);
check('a quiet window returns empty lists, not fabricated rows', buildOverview({}).topQueries, []);
check('…and says the window is quiet', buildOverview({ queryRows: [], pageRows: [] }).totals.clicks, 0);

console.log('\n6. Google\'s failures are named, with the fix')

check('a disabled API is called out as such', describeGoogleError(403, { error: { errors: [{ reason: 'accessNotConfigured' }], message: 'Search Console API has not been used in project 1' } }).code, 'API_NOT_ENABLED');
check('…and tells the operator where to enable it', /console\.cloud\.google\.com\/apis\/library\/searchconsole/.test(describeGoogleError(403, { error: { errors: [{ reason: 'accessNotConfigured' }] } }).message), true);
check('a dead token says reconnect', describeGoogleError(401, {}).code, 'TOKEN_REJECTED');
check('a permission refusal is distinguished from a disabled API', describeGoogleError(403, { error: { message: 'insufficient permission' } }).code, 'NO_ACCESS');
check('a vanished property says re-pick it', describeGoogleError(404, {}).code, 'NO_SUCH_PROPERTY');
check('anything else keeps Google\'s own message', describeGoogleError(500, { error: { message: 'backend error' } }).message, 'backend error');

console.log('\n7. the OAuth return path cannot be turned into an open redirect')

check('a normal path is kept', safeReturnTo('/workspace'), '/workspace');
check('a path with a query is kept', safeReturnTo('/workspace?tab=seo'), '/workspace?tab=seo');
check('an absolute URL is refused', safeReturnTo('https://evil.example/'), DEFAULT_RETURN_TO);
check('a protocol-relative URL is refused (a browser reads // as a host)', safeReturnTo('//evil.example'), DEFAULT_RETURN_TO);
check('a backslash path is refused', safeReturnTo('/\\evil.example'), DEFAULT_RETURN_TO);
check('a response-splitting newline is refused', safeReturnTo('/ok\nSet-Cookie: a=b'), DEFAULT_RETURN_TO);
check('a missing value falls back', safeReturnTo(undefined), DEFAULT_RETURN_TO);
check('a non-string falls back', safeReturnTo({ toString: () => '/evil' }), DEFAULT_RETURN_TO);
check('the default is a path, not a URL', DEFAULT_RETURN_TO.startsWith('/'), true);

console.log('\n8. the wiring')

const lib = read('server/src/lib/searchConsole.js');
check('the API host and version are the documented ones', /const GSC_API = 'https:\/\/www\.googleapis\.com\/webmasters\/v3'/.test(lib), true);
check('properties are listed from /sites', /gscFetch\(accessToken, '\/sites'\)/.test(lib), true);
check('data comes from the searchAnalytics query method', /\/sites\/\$\{encodeURIComponent\(siteUrl\)\}\/searchAnalytics\/query/.test(lib), true);
// The API has no links method (checked against Google's reference). If someone
// "adds" one by guessing, the URL would be wrong and the feature quietly broken.
check('no fabricated links endpoint is called', /gscFetch\([^)]*links/i.test(lib) || /\/links['"`]/.test(lib), false);
check('fresh data is requested, as the Search Console UI shows', /dataState: 'all'/.test(lib), true);

const scopeUses = [...read('server/src/lib/searchConsoleInsights.js'), lib, read('server/src/routes/connections.routes.js')].join('\n')
  .match(/https:\/\/www\.googleapis\.com\/auth\/webmasters\.readonly/g) || [];
check('the read-only scope is used', scopeUses.length >= 1, true);
check('the write scope is never requested', /auth\/webmasters['"]/.test(lib + read('server/src/routes/connections.routes.js')), false);

const routes = read('server/src/routes/connections.routes.js');
check('the connect route is authenticated and not widget-callable', /router\.get\('\/search-console\/start', requireAuth, blockWidget/.test(routes), true);
check('disconnect is authenticated and not widget-callable', /router\.delete\('\/search-console', requireAuth, blockWidget/.test(routes), true);
check('the callback dispatches on the signed purpose', /purpose === 'search_console'/.test(routes), true);
check('the purpose is read from the signed state, not the query', /jwt\.verify\(state, JWT_SECRET\)/.test(routes), true);
// Assert the BEHAVIOUR, not the comment that describes it: the payload handed to
// the upsert must not carry a `property` key. If it did, a reconnect would write
// null over the property the operator picked, and the comment saying otherwise
// would still be sitting there.
const persistAt = routes.indexOf('async function persistSearchConsoleConnection');
const persistBody = routes.slice(persistAt, routes.indexOf("router.get('/search-console/start'", persistAt));
check('reconnecting cannot overwrite the chosen property', /\bproperty\s*:/.test(persistBody), false);

const fn = read('server/src/functions/searchConsoleAction.js');
check('an unknown action is refused, not ignored', /Unknown action/.test(fn), true);
check('every action is handled explicitly', ['status', 'disconnect', 'properties', 'select-property', 'overview'].every((a) => fn.includes(`'${a}'`)), true);
check('a property is required before performance is read', /NO_PROPERTY/.test(fn), true);
check('the chosen property is validated against Google\'s list', /UNKNOWN_PROPERTY/.test(fn), true);

const widget = read('server/src/lib/widgetToken.js');
const seoScope = (widget.match(/seo: \[([^\]]*)\]/) || [])[1] || '';
check('the widget SEO scope can call it', /'searchConsoleAction'/.test(seoScope), true);
check('…and still cannot reach anything that writes to a repo', /createSiteWorkingCopy|pushSelfDevToGithub/.test(seoScope), false);

console.log('\n9. the storage it depends on exists')

const schema = read('server/prisma/schema.prisma');
check('the model exists', /^model SearchConsoleConnection \{/m.test(schema), true);
check('it is one row per account', /model SearchConsoleConnection \{[\s\S]{0,200}created_by_id String\s+@unique/.test(schema), true);
check('the chosen property is stored', /model SearchConsoleConnection \{[\s\S]{0,900}property\s+String\?/.test(schema), true);
check('tokens are not stored in plain text by accident (encrypted in code)', /encrypt\(access_token\)/.test(routes), true);
check('the migration ships with the model', existsSync(join(REPO, 'server/prisma/add-search-console-connections.sql')), true);
check('the caller\'s user relation is declared', /search_console_connection SearchConsoleConnection\?/.test(schema), true);

console.log(`\n${pass}/${pass + fail} checks passed`)
if (fail) {
  console.log('\nThese are the rules that make the numbers usable. A wrong aggregate or an')
  console.log('invented metric here is worse than no feature: it gets acted on.\n')
  process.exit(1)
}
console.log('all good\n')
