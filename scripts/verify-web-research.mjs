// Our own web search: the filtering, the ranking, the cache, and the wiring.
//
// Dependency-free, so it runs in CI's no-install guards job. Run:
//   node scripts/verify-web-research.mjs
//
// WHY THIS EXISTS. Morpheus runs its own search (2026-10-04) because every hosted grounding option was
// closed to this account. That search parses a public HTML page with no contract, and the raw list it
// returns is not safe to use directly — measured, not theorised:
//
//   · the top TWO results for "2008 RAV4 idle squeal cause" were adverts (`duckduckgo.com/y.js?ad_domain=`)
//     ahead of the real answer, so fetching in order would spend the turn on a shop listing;
//   · one question returns several pages from a single host;
//   · and for a jurisdiction-specific fact the tax office's own page is the answer whatever the ranking
//     says — the searches that mattered both put a `.gov.au` page first, which is the whole reason this
//     replaced grounding rather than merely being cheaper than it.
//
// Every rule below is a decision that fails silently if it rots: an ad that stops being filtered just
// looks like a result, and a cache with no freshness check serves a stale rate as current.
import { readFileSync } from 'node:fs';
import {
  hostOf, isAdOrTracker, isOfficial, dedupeByHost, rankResults, searchCacheKey, isCacheFresh,
  parseDuckDuckGoResults,
} from '../server/src/lib/searchResults.js';

let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`);
    failures++;
  }
}

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

console.log('\n1. ads and trackers are never treated as results');
check('the exact ad shape measured in production', isAdOrTracker('https://duckduckgo.com/y.js?ad_domain=emanualonline.com&ad_provider=bingv7aa'), true);
check('…and the eBay one beside it', isAdOrTracker('https://duckduckgo.com/y.js?ad_domain=ebay.com.au&ad_provider=bingv7aa'), true);
check('an ad_domain on any host', isAdOrTracker('https://example.com/click?ad_domain=x'), true);
check('a doubleclick tracker', isAdOrTracker('https://ad.doubleclick.net/click/x'), true);
check('an unresolved search redirector', isAdOrTracker('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fx.com'), true);
check('a plain result is NOT an ad', isAdOrTracker('https://www.revenue.nsw.gov.au/taxes/land-tax'), false);
check('…nor is a duckduckgo-free gov page with a query string', isAdOrTracker('https://www.environment.nsw.gov.au/licences?x=1'), false);
check('junk is not a result', [isAdOrTracker('not a url'), isAdOrTracker(''), isAdOrTracker(null)].join(), 'true,true,true');

console.log('\n2. official sources are recognised, and only preferred');
check('a state government page', isOfficial('https://www.revenue.nsw.gov.au/taxes'), true);
check('a national .gov', isOfficial('https://www.ato.gov.au/x'), true);
check('a university', isOfficial('https://www.unsw.edu.au/x'), true);
check('…and a .com is not official', isOfficial('https://mortgageworldaustralia.com.au/x'), false);
check('…nor is a .org, however respectable', isOfficial('https://dingofoundation.org/x'), false);
check('host parsing strips www and lowercases', hostOf('https://WWW.Example.COM.AU/a'), 'example.com.au');

console.log('\n3. one page per host, and the engine\u2019s order survives inside each group');
const mixed = [
  { url: 'https://mortgageworldaustralia.com.au/a', title: 'broker' },
  { url: 'https://www.revenue.nsw.gov.au/taxes', title: 'the tax office' },
  { url: 'https://mortgageworldaustralia.com.au/b', title: 'same broker again' },
  { url: 'https://duckduckgo.com/y.js?ad_domain=shop.com', title: 'an advert' },
  { url: 'https://realestatecalc.com.au/x', title: 'a calculator' },
];
const ranked = rankResults(mixed, { max: 3 });
check('the advert is gone', ranked.some((r) => /y\.js/.test(r.url)), false);
check('the repeated host appears once', ranked.filter((r) => /mortgageworldaustralia/.test(r.url)).length, 1);
check('the official page is FIRST even though it was second', ranked[0].url, 'https://www.revenue.nsw.gov.au/taxes');
check('…and the rest keep the engine\u2019s order', ranked.slice(1).map((r) => hostOf(r.url)), ['mortgageworldaustralia.com.au', 'realestatecalc.com.au']);
check('the cap is respected', rankResults(mixed, { max: 1 }).length, 1);
check('an empty or junk list yields nothing', [rankResults([]).length, rankResults(null).length, rankResults([null, 7, {}]).length].join(), '0,0,0');
check('dedupe keeps the first page of a host', dedupeByHost([{ url: 'https://a.com/1' }, { url: 'https://www.a.com/2' }]).map((r) => r.url), ['https://a.com/1']);

console.log('\n4. the cache cannot serve a stale answer as current');
check('the key ignores case and spacing', searchCacheKey('  NSW   Land Tax ') === searchCacheKey('nsw land tax'), true);
check('a fresh entry is fresh', isCacheFresh({ at: 1000, results: [] }, 1500, 1000), true);
check('an expired entry is NOT', isCacheFresh({ at: 1000, results: [] }, 2500, 1000), false);
check('…on the boundary it is expired, not fresh', isCacheFresh({ at: 1000 }, 2000, 1000), false);
check('an entry with no timestamp is never fresh', [isCacheFresh({}, 2000, 1000), isCacheFresh({ at: 'x' }, 2000, 1000)].join(), 'false,false');
check('no clock is never fresh', isCacheFresh({ at: 1000 }, NaN, 1000), false);

console.log('\n5. parsing real markup — the fragile part, pinned to a fixture');
// A trimmed copy of the actual response shape: the href is a redirector carrying the real URL, and the
// title is HTML-escaped. If the endpoint changes shape, this fails rather than silently returning none.
const FIXTURE = `
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.revenue.nsw.gov.au%2Ftaxes-duties-levies-royalties%2Fland-tax&amp;rut=abc">Land tax &amp; thresholds | Revenue NSW</a>
  <a class="result__snippet" href="x">The threshold and rates for the current land tax year.</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fmortgageworldaustralia.com.au%2Fland-tax-nsw-complete-guide%2F">Land Tax NSW: A Complete Guide</a>
  <a class="result__snippet" href="x">A broker&#x27;s summary.</a>
</div>`;
const parsed = parseDuckDuckGoResults(FIXTURE);
check('both results are found', parsed.length, 2);
check('the redirector is unwrapped to the real URL', parsed[0].url, 'https://www.revenue.nsw.gov.au/taxes-duties-levies-royalties/land-tax');
check('entities in the title are decoded', parsed[0].title, 'Land tax & thresholds | Revenue NSW');
check('the snippet is attached to the right result', parsed[1].snippet, "A broker's summary.");
check('a page with no results yields none', parseDuckDuckGoResults('<html>no results</html>').length, 0);

console.log('\n6. the search is wired as a real tier, and reports its own failures');
const researchSrc = read('server/src/lib/webResearch.js');
check('it is called from webSearch', /await duckduckgoSearch\(query/.test(researchSrc), true);
// Order matters: Wikipedia cannot answer a current rate or a permit rule, so our own search must sit
// ahead of it rather than behind.
check('…BEFORE Wikipedia, which cannot answer a current fact',
  researchSrc.indexOf('await duckduckgoSearch(query') < researchSrc.indexOf('await wikipediaSearch(query'), true);
check('a failure is reported rather than swallowed', /warnSearchUnavailable\(/.test(researchSrc), true);
check('…with a reason a human can act on', /searchUnavailableReason/.test(researchSrc), true);
check('…and it degrades to an empty list, never a throw', /catch \(err\) \{[\s\S]{0,200}return \[\];/.test(researchSrc), true);
check('the cache is capped in size, so a long-lived process cannot grow it forever', /SEARCH_CACHE_MAX/.test(researchSrc), true);

// ⚠️ THE BUG ROB FOUND, and it produced a wrong answer about the law. This shipped working in a probe and
// broken in production because the probe used a browser User-Agent and the module sent one calling itself
// a "bot" — which DuckDuckGo answers with `202 Accepted` and a challenge page. 202 is "ok", so the code
// parsed nothing and returned an empty list in silence, Jarvis fell through to Wikipedia, and he answered
// the dingo question from memory with the law the wrong way round.
//
// The UA is read out of the source and tested on its OWN, not searched for in the file: the comment above
// it quotes the refused string, so a whole-file `/bot/i` would fail on its own explanation.
const userAgent = (researchSrc.match(/const UA = '([^']+)'/) || [, ''])[1];
check('the User-Agent is set at all', userAgent.length > 0, true);
check('…and does NOT call itself a bot — the token the endpoint refuses',
  /bot/i.test(userAgent), false);
check('…while still identifying us honestly', /Morpheus/i.test(userAgent) && /https?:\/\//.test(userAgent), true);
check('a 202 challenge page is a FAILURE, not an empty result', /res\.status === 202/.test(researchSrc), true);
check('…and it says why, so a refused agent is diagnosable',
  /challenge page \(HTTP 202\)/.test(researchSrc), true);
check('…and a 200 carrying no results is reported rather than read as "nothing found"',
  /carried no results/.test(researchSrc), true);

const chatSrc = read('server/src/functions/chatWithJarvis.js');
check('the reply actually READS the top result, not just its title',
  /PAGE \(from "\$\{query\}"\)/.test(chatSrc), true);
check('…bounded per TURN, so two searches cannot fetch four pages',
  /pagesRead < RESEARCH_PAGES_PER_TURN/.test(chatSrc) && /let pagesRead = 0;/.test(chatSrc), true);

console.log('\n7. it degrades to no results rather than throwing');
// Asserted from the SOURCE, not by calling it: `webResearch.js` imports Prisma and the AI gateway, so
// importing it here would drag those into CI's no-install job and this guard could never run. The
// parsing — the fragile part — was moved into searchResults.js precisely so it IS testable above.
check('a failed request returns no results instead of throwing',
  /if \(!res\.ok\) \{[\s\S]{0,200}?return \[\];/.test(researchSrc), true);
check('…and a thrown fetch is caught the same way',
  /catch \(err\) \{[\s\S]{0,200}?return \[\];/.test(researchSrc), true);
check('…and an empty query never reaches the network', /if \(!q\) return \[\];/.test(researchSrc), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('all good\n');
