// Runtime verification for keyword research.
//
// Dependency-free, so it runs in CI's no-install guards job. Run:
//   node scripts/verify-keywords.mjs
//
// The feature's promise is narrow and testable: every keyword says WHICH signal
// produced it, and the response has nowhere to put a search volume, a difficulty
// score or a ranking. That second half is the important one — a model asked for
// a volume invents a convincing one, and an invented number gets acted on. So
// the output shape is asserted to contain no such field, at any depth, and the
// UI is asserted not to render one.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseSuggest, extractPageSignals, mergeCandidates, normalizePhrase,
  repeatedPhrases, researchDisclosure, isChrome, titleCore, MAX_KEYWORDS,
  MAX_COMPETITORS, MAX_SEEDS, distinctiveTerms, distinctiveMatches,
  gscCandidates, gscSummary, researchSeeds, sourceLabel, provenanceOf, hostOf,
} from '../server/src/lib/keywordResearch.js';

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

console.log('\nKeyword research — runtime verification\n');

console.log('1. Google autocomplete is parsed, not guessed at');
check('the classic payload', parseSuggest('["guitar repairs",["guitar repairs melbourne","guitar repairs near me"]]'),
  ['guitar repairs melbourne', 'guitar repairs near me']);
check('an object payload', parseSuggest({ suggestions: ['a thing', 'another thing'] }), ['a thing', 'another thing']);
check('the XML-ish fallback', parseSuggest('<toplevel><CompleteSuggestion><suggestion data="guitar setup"/></CompleteSuggestion></toplevel>'), ['guitar setup']);
check('rubbish yields nothing rather than throwing', parseSuggest('not json at all'), []);
check('an empty payload yields nothing', parseSuggest(null), []);
check('...and a 200 with an unexpected shape', parseSuggest('{"error":"rate limited"}'), []);

console.log('\n2. a competing page is read for what it says about itself');
const competitorHtml = `
<html><head>
<title>Guitar Repairs Melbourne | Best Guitar Setup</title>
<meta name="description" content="Expert guitar repairs in Melbourne. Book a setup.">
</head><body>
<h1>Guitar Repairs Melbourne</h1>
<h2>Acoustic guitar setup</h2><h2>Electric guitar setup</h2>
<p>${'guitar repairs melbourne done properly. '.repeat(6)}</p>
<p>${'We do acoustic guitar setup and electric guitar setup every day. '.repeat(4)}</p>
<script>var guitar = 'should not be read';</script>
</body></html>`;
const sig = extractPageSignals(competitorHtml, 'https://rival.example/repairs');
check('the title', sig.title, 'Guitar Repairs Melbourne | Best Guitar Setup');
check('the meta description', sig.description, 'Expert guitar repairs in Melbourne. Book a setup.');
check('the h1', sig.h1, ['Guitar Repairs Melbourne']);
check('the h2s', sig.h2, ['Acoustic guitar setup', 'Electric guitar setup']);
check('script contents are not read as page text', has(JSON.stringify(sig), 'should not be read'), false);
check('repeated phrases are found', sig.phrases.some((p) => p.phrase === 'guitar repairs melbourne'), true);
check('a page with no title does not throw', extractPageSignals('<html><body>x</body></html>', 'https://x.test').title, '');

check('n-grams keep real phrases', repeatedPhrases('guitar setup melbourne guitar setup melbourne guitar setup melbourne').some((p) => p.phrase === 'guitar setup'), true);
check('...and drop all-stopword ones', repeatedPhrases('of the and of the and of the and').length, 0);
check('...and do not start or end on a stopword', repeatedPhrases('the guitar setup of the guitar setup of').every((p) => !p.phrase.startsWith('the ')), true);

console.log('\n3. every keyword carries the signal that produced it');
// The page has a BODY here on purpose: the relevance gate (section 7) decides
// what belongs to a page from its title, its target keyword and the words it
// repeats, so a fixture with a bare title would be testing the thin-page
// fallback rather than the merging this section is about.
const merged = mergeCandidates({
  seeds: ['guitar repairs'],
  suggests: { 'guitar repairs': ['guitar repairs melbourne', 'guitar setup near me'] },
  competitors: [{ url: 'https://rival.example', title: 'Guitar Repairs Melbourne', h1: ['Guitar Repairs Melbourne'], h2: ['Acoustic guitar setup'], phrases: [{ phrase: 'guitar repairs melbourne', count: 5 }] }],
  model: ['vintage guitar servicing'],
  page: {
    title: 'Our workshop',
    focus_keyword: 'guitar repairs',
    text: 'guitar repairs and guitar setup in our workshop. guitar setup, guitar repairs, vintage servicing, vintage servicing.',
  },
});
const byPhrase = Object.fromEntries(merged.map((r) => [r.phrase, r]));
check('a phrase in autocomplete AND a competitor heading keeps both sources',
  byPhrase['guitar repairs melbourne'].sources.sort(), ['autocomplete', 'competitor-heading', 'competitor-phrase', 'competitor-title']);
check('an autocomplete phrase records the seed it came from', byPhrase['guitar setup near me'].details, ['guitar repairs']);
check('a model suggestion is labelled as a model suggestion', byPhrase['vintage guitar servicing'].sources, ['model']);
check('the page\'s own keyword is included and labelled', byPhrase['guitar repairs'].sources, ['seed', 'page-keyword']);
check('multi-source phrases rank above single-source ones', merged[0].phrase, 'guitar repairs melbourne');
// With the brand suffix stripped, a long title CAN yield a usable keyword —
// that is the point of titleCore. What must still be excluded is a title whose
// informative part is itself a sentence.
check('a brand-suffixed long title yields its core, not the whole title',
  mergeCandidates({ competitors: [{ url: 'u', title: 'Guitar Repairs Melbourne | Valiant Music | Est 1998 Since Then' }] }).map((r) => r.phrase),
  ['guitar repairs melbourne']);
check('a title that is a sentence stays out',
  mergeCandidates({ competitors: [{ url: 'u', title: 'The complete guide to buying your first vintage guitar in Melbourne' }] }).length, 0);
check('a meta description is never a keyword', mergeCandidates({ competitors: [{ url: 'u', description: 'Expert guitar repairs in Melbourne. Book a setup today.' }] }).length, 0);

console.log('\n3b. site furniture never becomes a keyword');
// Found by running this against a real shop: a search field's "Form name"
// label became a keyword AND an autocomplete seed, which then dragged
// "form name meaning in hindi" back from Google.
check('a nav label is chrome', isChrome('About'), true);
check('a form label is chrome', isChrome('Form name'), true);
check('a boilerplate line is chrome', isChrome('All rights reserved'), true);
check('content is not chrome', isChrome('Acoustic guitar setup'), false);
// The case the live run produced: a cart notice glued to a quantity.
check('a cart notice is chrome', isChrome('Item added to your cart'), true);
check('...and even with a number glued to it', isChrome('00 add to cart'), true);
check('a nav term with a brand after it is chrome', isChrome('About Billy Hyde Music'), true);
check('an ambiguous first word alone is not enough to drop real content', isChrome('Shop guitar repairs'), false);
check('chrome never becomes a keyword',
  mergeCandidates({ competitors: [{ url: 'u', h1: ['About'], h2: ['Form name', 'Contact us'] }] }).length, 0);
check('but the operator\'s own seed is kept even if it looks like chrome',
  mergeCandidates({ seeds: ['about'] }).map((r) => r.phrase), ['about']);
check('a page\'s own focus keyword is kept too',
  mergeCandidates({ page: { focus_keyword: 'search' } }).map((r) => r.phrase), ['search']);
check('a brand suffix is stripped from a competitor title', titleCore('Acoustic guitar - Wikipedia'), 'Acoustic guitar');
check('...keeping the informative part of a longer title', titleCore('Guitar Repairs Melbourne | Best Guitar Setup'), 'Guitar Repairs Melbourne');
check('a title with no separator is left alone', titleCore('Guitar Repairs Melbourne'), 'Guitar Repairs Melbourne');
check('the stripped title is what becomes the keyword',
  mergeCandidates({ competitors: [{ url: 'u', title: 'Acoustic guitar - Wikipedia' }] }).map((r) => r.phrase), ['acoustic guitar']);

console.log('\n4. the response shape cannot carry an invented number');
const everyKey = (obj, out = []) => {
  if (Array.isArray(obj)) { obj.forEach((o) => everyKey(o, out)); return out; }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) { out.push(k); everyKey(v, out); }
  }
  return out;
};
const sample = mergeCandidates({ seeds: ['a b'], suggests: { 'a b': ['a b c'] }, competitors: [{ url: 'u', h1: ['a b c'] }], page: { title: 'a b' } });
const keys = new Set(everyKey(sample));
// `impressions`, `clicks` and `position` are deliberately NOT here any more:
// they are now real Search Console numbers, copied from Google's response. What
// stays forbidden is everything that is unobtainable for free, which is what a
// model would invent — a volume, a difficulty score, a CPC, a traffic estimate.
const FORBIDDEN = ['volume', 'search_volume', 'volume_monthly', 'difficulty', 'kd', 'keyword_difficulty', 'cpc', 'competition', 'traffic', 'rank', 'ranking'];
check('no forbidden metrics on any keyword row', [...keys].filter((k) => FORBIDDEN.includes(k)), []);
check('the rows carry provenance', keys.has('sources') && keys.has('details'), true);

// The handler and the UI must not add one either. Comments are stripped first
// on purpose: the rule is DOCUMENTED in prose at the top of the handler, and a
// check that trips over its own documentation would push the next person to
// delete the explanation rather than keep it.
const stripComments = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  // `//` after a colon is a URL (https://…), not a comment.
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const handler = read('server/src/functions/researchKeywords.js');
const ui = read('src/components/matrix/website/SeoTab.jsx');
for (const word of ['volume', 'difficulty', 'KD', 'CPC']) {
  check(`the handler's code never mentions "${word}"`, new RegExp(`\\b${word}\\b`, 'i').test(stripComments(handler)), false);
}
// Precise on purpose: the UI is ALLOWED to say "there are no search volumes
// here" (it does, as the disclosure), so a check for the mere word would push
// the next person to delete the explanation. What it must never do is render a
// metric — a label with a value, or a property off the payload.
check('the UI renders no metric label or metric property',
  /(volume|difficulty|cpc|\bkd\b)\s*[:=]/i.test(stripComments(ui))
  || />\s*(search\s+)?(volume|difficulty|kd|cpc)\s*</i.test(ui), false);
check('...and it reads no metric off the payload',
  /\.(search_)?volume\b|\.difficulty\b|\.cpc\b/i.test(ui), false);
check('the UI shows the disclosure instead', has(ui, 'disclosure'), true);

console.log('\n4b. competitor phrases seed the research — through the chrome filter, never around it');
// The rule CHANGED here (2026-09-22): competitor phrases may seed Google's
// autocomplete, which they were previously banned from after a live run turned a
// search field's "Form name" label into a seed and dragged "form name meaning in
// hindi" back as a keyword. The ban was the wrong fix — the chrome filter was
// already the right one — so what this asserts is that the filter is what lets a
// phrase through, not that competitors are excluded.
const seedInputs = {
  page: { focus_keyword: 'guitar setup', title: 'Guitar Repairs' },
  manualSeed: '',
  competitors: [{
    url: 'https://rival.example',
    title: "Guitar Repairs Melbourne | Val's Music",
    h1: ['Acoustic guitar setup'],
    h2: ['Form name', 'Contact us', 'Electric guitar servicing'],
  }],
};
const seeds = researchSeeds(seedInputs);
check('the page\'s own keyword seeds first', seeds[0], 'guitar setup');
check('a competitor heading seeds the research', seeds.includes('acoustic guitar setup'), true);
check('…and a competitor title does too', seeds.includes('guitar repairs melbourne'), true);
// The incident this must keep preventing.
check('site furniture never seeds', seeds.some((s) => s.includes('form')), false);
check('…nor does any other chrome heading', seeds.includes('contact us'), false);
check('a slogan-length competitor title does not seed',
  researchSeeds({ competitors: [{ url: 'u', title: "Melbourne, Perth & Adelaide's largest & best Music Store" }] }).length, 0);
check('seeds are deduped and normalised',
  researchSeeds({ page: { focus_keyword: 'Guitar Setup' }, competitors: [{ url: 'u', h1: ['guitar   setup'] }] }), ['guitar setup']);
check('a bare competitor URL with no readable page seeds nothing', researchSeeds({ competitors: [{ url: 'u', error: 'HTTP 404' }] }).length, 0);
check('the chrome filter is what decides, not a bypass', isChrome('Form name') && !isChrome('Acoustic guitar setup'), true);

const handlerSrc = read('server/src/functions/researchKeywords.js');
check('the handler uses the shared seed rules', has(handlerSrc, 'researchSeeds('), true);
check('…and does not build a second, weaker seed list inline', /const seeds = \[/.test(handlerSrc), false);

console.log('\n5. the honest disclosure is part of the payload');
const disclosure = researchDisclosure({ competitorCount: 2, autocompleteUsed: true });
check('it names both signals', has(disclosure, 'autocomplete') && has(disclosure, '2 competing pages'), true);
check('it says why there are no volumes', has(disclosure, 'deliberately no search volumes'), true);
check('one competitor reads correctly', has(researchDisclosure({ competitorCount: 1, autocompleteUsed: false }), '1 competing page'), true);
// Search Console is the one MEASURED source, so it is named first and its
// numbers are described as Google's rather than ours.
check('it names Search Console when its queries are used',
  has(researchDisclosure({ gscQueryCount: 3 }), '3 queries your own site already appears for in Google Search Console'), true);
check('one query reads correctly', has(researchDisclosure({ gscQueryCount: 1 }), '1 query your own site already appears for'), true);
check('…and says the numbers are Google\'s own',
  has(researchDisclosure({ gscQueryCount: 2 }), 'The only numbers shown are Google\'s own'), true);
// Skipped silently in the payload, but never silently to the operator.
check('it says so when Search Console could not be asked',
  has(researchDisclosure({ gscSkipped: true, autocompleteUsed: true }), 'Search Console connection is not set up'), true);
check('…and stays quiet about it when it answered',
  has(researchDisclosure({ gscQueryCount: 2 }), 'not set up'), false);
check('the no-invented-numbers promise survives Search Console',
  has(researchDisclosure({ gscQueryCount: 2 }), 'deliberately no search volumes or difficulty scores'), true);

console.log('\n6. limits exist so this cannot be used to hammer a third party');
check('seeds are capped', /MAX_SEEDS = \d+/.test(read('server/src/lib/keywordResearch.js')), true);
check('competitors are capped', /MAX_COMPETITORS = \d+/.test(read('server/src/lib/keywordResearch.js')), true);
check('competitor HTML is size-capped', /MAX_COMPETITOR_BYTES = \d+/.test(read('server/src/lib/keywordResearch.js')), true);
// COUNT THEM AGAINST EACH OTHER, not against a number. The first version of
// this checked "FETCH_TIMEOUT_MS appears at least twice", which still passed
// after one of the two timeouts was deleted — because the constant declaration
// and the other call site supplied the count on their own.
const handlerCode = stripComments(handler);
const fetches = (handlerCode.match(/await fetch\(/g) || []).length;
const timeouts = (handlerCode.match(/setTimeout\([\s\S]{0,60}?FETCH_TIMEOUT_MS\)/g) || []).length;
check('the handler makes outbound requests at all (parser sanity)', fetches >= 2, true);
check('EVERY outbound fetch has its own timeout', timeouts >= fetches, true);

console.log('\n7. relevance: sharing the head noun is not being about the page');
// THE CASE THAT DECIDES THIS RULE, and the one a weaker gate fails. Every
// autocomplete row below shares exactly one content word — "guitar" — with a
// page about guitar repairs, so a single-shared-word gate drops nothing at all
// and ships the complaint this change answers. The page's DISTINCTIVE terms are
// its title, its own target keyword, and the words it repeats; a phrase has to
// carry two of them.
const relevancePage = {
  title: 'Guitar repairs and setups',
  focus_keyword: 'guitar setup',
  text: 'We repair guitars. Every repair starts with a setup, and our workshop is a repair and a setup workshop.',
};
const relevanceTerms = distinctiveTerms(relevancePage);
check('the distinctive terms are the page\'s real subject (parser sanity)', relevanceTerms.size >= 3, true);
check('…including words the body repeats, not just the title', relevanceTerms.has('repair') && relevanceTerms.has('workshop'), true);
const relevanceRows = mergeCandidates({
  seeds: ['guitar setup'],
  suggests: { 'guitar setup': ['guitar setup near me', 'guitar center', 'how to play guitar', 'guitar tab', 'guitar hero'] },
  competitors: [{ url: 'https://rival.example/repairs', title: 'Guitar repair melbourne', h1: ['Acoustic guitar setup'], h2: ['Fret work', 'Setups'] }],
  page: relevancePage,
});
const keptPhrases = relevanceRows.map((r) => r.phrase);
check('an on-topic phrase survives',
  ['guitar repair melbourne', 'acoustic guitar setup', 'guitar setup near me'].every((p) => keptPhrases.includes(p)), true);
check('a phrase sharing ONLY the head noun is dropped',
  keptPhrases.filter((p) => ['guitar center', 'guitar hero', 'guitar tab', 'how to play guitar'].includes(p)), []);
check('…and so is one with no distinctive term at all', keptPhrases.includes('fret work'), false);
check('a single shared word scores 1, which is why 1 cannot be the bar', distinctiveMatches('guitar center', relevanceTerms), 1);
check('every kept row that is not always-kept carries two distinctive terms',
  relevanceRows.filter((r) => !r.sources.some((s) => ['seed', 'page-keyword', 'page-title', 'gsc'].includes(s))).every((r) => r.relevance >= 2), true);

// Fallback 1: a thin page cannot support a two-term test.
const thinPage = mergeCandidates({ suggests: { guitar: ['guitar center'] }, page: { title: 'Guitar' } });
check('a page with too few distinctive terms asks for one, not two', thinPage.map((r) => r.phrase).includes('guitar center'), true);
check('…and its distinctive term count is what decides (parser sanity)', distinctiveTerms({ title: 'Guitar' }).size, 1);

// Fallback 2: no page at all — a bare-seed exploration has nothing to be
// relevant TO, and dropping everything would report "no keywords" for a page
// that was simply never read. This is the HANDLER's shape, not an empty object:
// researchKeywords.js copies body.seed into page.focus_keyword, so a bare
// exploration still has a target keyword. Judging candidates against those two
// words would filter out everything Google returned for the seed itself.
const bareSeed = mergeCandidates({
  seeds: ['guitar setup'],
  suggests: { 'guitar setup': ['guitar center', 'ukulele strings'] },
  page: { title: '', focus_keyword: 'guitar setup', text: '' },
});
check('a bare-seed exploration is not filtered away', bareSeed.length, 3);
check('…even for a phrase sharing nothing with the seed', bareSeed.map((r) => r.phrase).includes('ukulele strings'), true);
check('…and every row still says where it came from', bareSeed.every((r) => r.source_labels.length > 0), true);
// A page that was read has a title or text; that is what turns the gate on, so a
// failed read cannot masquerade as a page with nothing relevant on it.
const readButEmpty = mergeCandidates({
  suggests: { guitar: ['guitar center', 'ukulele strings'] },
  page: { title: 'Guitar repairs and setups', focus_keyword: 'guitar setup', text: '' },
});
check('a page that WAS read is gated', readButEmpty.map((r) => r.phrase).includes('ukulele strings'), false);

// Fallback 3: the operator's own input and measured demand are never inferences
// about this page, so a relevance gate does not apply to them.
const offTopic = mergeCandidates({
  seeds: ['ukulele restringing'],
  gsc: [{ phrase: 'banjo setups', impressions: 12, clicks: 1, ctr: 0.083, position: 6.4 }],
  model: ['banjo lessons'],
  page: relevancePage,
});
const offTopicPhrases = offTopic.map((r) => r.phrase);
check('the operator\'s own seed survives an off-topic page', offTopicPhrases.includes('ukulele restringing'), true);
check('measured demand survives too', offTopicPhrases.includes('banjo setups'), true);
check('…but an unrelated AI idea does not', offTopicPhrases.includes('banjo lessons'), false);

console.log('\n8. every row says where it came from, and the cap is eight');
check('the competitor cap is 8', MAX_COMPETITORS, 8);
// The panel caps the same list. A UI that caps lower than the server is a limit
// nobody can see, explain, or change from the server side.
const uiSrc = read('src/components/matrix/website/SeoTab.jsx');
const uiCap = Number((uiSrc.match(/competitors\.split\([\s\S]{0,120}?slice\(0, (\d+)\)/) || [])[1]);
check('the panel accepts as many competitors as the server', uiCap, MAX_COMPETITORS);
check('competitor rows name the HOST, not the whole URL',
  relevanceRows.find((r) => r.phrase === 'guitar repair melbourne').provenance, 'rival.example');
check('a competitor URL becomes its host', provenanceOf('https://rival.example/repairs?utm_source=x'), 'rival.example');
check('www is stripped so two rows from one site read alike', hostOf('https://www.rival.example/a'), 'rival.example');
check('an autocomplete row shows the seed it came from', provenanceOf('guitar setup'), 'guitar setup');
check('every source the pipeline can emit has a chip label',
  ['seed', 'page-keyword', 'page-title', 'autocomplete', 'competitor-title', 'competitor-heading', 'competitor-phrase', 'gsc', 'model']
    .every((s) => sourceLabel(s) && sourceLabel(s) !== s), true);
check('a row carries one label per source',
  relevanceRows.every((r) => r.source_labels.length === r.sources.length), true);
check('the panel renders the served labels rather than its own',
  has(uiSrc, 'row.source_labels') && has(uiSrc, 'row.provenance'), true);

console.log('\n9. the site\'s own measured queries, with Google\'s numbers, first');
const gscRows = gscCandidates([
  { keys: ['guitar setup near me'], clicks: 4, impressions: 180, ctr: 0.022, position: 8.3 },
  { keys: ['guitar repairs'], clicks: 9, impressions: 240, ctr: 0.037, position: 4.1 },
  { keys: ['guitar center'], clicks: 1, impressions: 90, ctr: 0.011, position: 21.5 },
]);
check('rows are read from Google\'s own payload', gscRows.map((r) => r.phrase), ['guitar repairs', 'guitar setup near me', 'guitar center']);
check('…carrying the exact numbers, untouched',
  [gscRows[0].impressions, gscRows[0].clicks, gscRows[0].position, gscRows[0].ctr], [240, 9, 4.1, 0.037]);
check('a row without real numbers is dropped rather than shown as zero',
  gscCandidates([{ keys: ['a query'], impressions: 'many', clicks: 1, ctr: 0.1, position: 3 }]).length, 0);
check('a row with no query is dropped',
  gscCandidates([{ keys: [], clicks: 1, impressions: 2, ctr: 0.5, position: 3 }]).length, 0);
check('a duplicate query keeps the busiest row',
  gscCandidates([
    { keys: ['q'], impressions: 5, clicks: 0, ctr: 0, position: 9 },
    { keys: ['q'], impressions: 50, clicks: 2, ctr: 0.04, position: 3 },
  ])[0].impressions, 50);
check('the summary line is Google\'s numbers in words',
  gscSummary({ impressions: 1240, clicks: 12, position: 4.25 }), '1,240 impressions · 12 clicks · avg position 4.3');

const measured = mergeCandidates({
  seeds: ['guitar setup'],
  // 'guitar setup near me' is deliberately BOTH a Search Console query and an
  // autocomplete phrase: a row can be measured demand AND something people type,
  // and then it keeps both sources and the measured bonus. The comparison that
  // means anything is against a phrase the site does NOT already rank for.
  suggests: { 'guitar setup': ['guitar setup near me', 'guitar setup prices'] },
  competitors: [{ url: 'https://rival.example', h1: ['Acoustic guitar setup'] }],
  gsc: gscRows,
  page: relevancePage,
});
const measuredPhrases = measured.map((r) => r.phrase);
check('measured demand outranks a phrase nobody has measured', measuredPhrases.indexOf('guitar repairs') < measuredPhrases.indexOf('guitar setup prices'), true);
check('…and a competitor phrase', measuredPhrases.indexOf('guitar repairs') < measuredPhrases.indexOf('acoustic guitar setup'), true);
check('a row that is both measured and typed keeps both sources',
  measured.find((r) => r.phrase === 'guitar setup near me').sources.sort(), ['autocomplete', 'gsc']);
const measuredRow = measured.find((r) => r.phrase === 'guitar repairs');
check('the row carries Google\'s numbers', measuredRow.gsc, { impressions: 240, clicks: 9, position: 4.1, ctr: 0.037 });
check('…and the line the panel shows', measuredRow.gsc_summary, '240 impressions · 9 clicks · avg position 4.1');
check('…labelled as the site\'s own Search Console', measuredRow.source_labels.includes('your Search Console'), true);
check('no row that is not from Search Console carries measured numbers',
  measured.filter((r) => !r.sources.includes('gsc')).every((r) => r.gsc === undefined && r.gsc_summary === null), true);

// A competitor that fails must return a failure, not throw: one bad address
// among three must not lose the other two.
const competitorFn = handlerCode.slice(handlerCode.indexOf('async function fetchCompetitor'));
const competitorBody = competitorFn.slice(0, competitorFn.indexOf('\n}\n') + 2);
check('the competitor reader was located (parser sanity)', competitorBody.length > 200, true);
check('it never throws — a failure is a value', /\bthrow\b/.test(competitorBody), false);
check('it has a catch for the network itself', /catch\s*\(/.test(competitorBody), true);
check('failures carry a reason for the operator', (competitorBody.match(/error:/g) || []).length >= 3, true);
check('and the response reports them per URL', has(handler, 'error: c.error || null'), true);
check('the model is optional: its failure cannot fail the research', has(handler, 'catch {'), true);
check('the rows are capped', MAX_KEYWORDS > 0 && MAX_KEYWORDS <= 100, true);
check('phrases are normalised for dedupe', normalizePhrase('  Guitar   Repairs!  '), 'guitar repairs');

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\nKeyword research is broken or claims more than it can know. Fix before merging.\n');
  process.exit(1);
}
console.log('keyword research holds.\n');
