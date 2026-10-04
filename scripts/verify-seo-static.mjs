// The machine-readable surface of morpheus.nz must actually be there, be accurate, and
// not be text hidden from people.
//
// WHY THIS EXISTS
//
// Until 2026-09-25 a crawler fetching morpheus.nz got a 1.5 KB React shell whose entire
// content was `<title>Morpheus</title>`. Marketing tools and AI answer engines said they
// could not tell what the product was — correctly. `/robots.txt` and `/sitemap.xml` did
// not exist either, because public/_redirects' SPA catch-all answered every path with
// index.html, so a request for a sitemap returned HTML.
//
// Three things this guards, in order of how badly they would hurt:
//
//   1. CLOAKING. The tempting fix is text hidden in the page so only crawlers read it.
//      That is a Google spam-policy violation and would penalise the domain this is meant
//      to promote. So the prerendered block must carry no hiding style, and the same
//      capability list must be rendered by the page itself (`Landing.jsx`) — the check
//      for "is this a prerender or a bot-only block" is literally "does a human see it".
//   2. DRIFT. The explainer documents said Morpheus builds for "6 platforms" while the
//      code shipped **ten**, and said there is "no free tier" while six accounts held the
//      live 200-credit grant. Anything published in metadata is now quoted by search
//      engines and AI tools, so the target list and the capability list are asserted
//      against the code, not trusted.
//   3. DEGRADING to a silent no-op. The generator writes into dist/, which does not exist
//      in CI's no-install guards job — so this runs the REAL generator against a temp
//      directory instead of skipping. A check that cannot run is not a pass.
//
// Dependency-free. Run:  node scripts/verify-seo-static.mjs

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { renderUserManual } from '../server/src/lib/appUserManual.js';
import { getCompileTarget } from '../server/src/lib/compile-targets/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0; let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const caps = JSON.parse(readFileSync(join(ROOT, 'src/lib/morpheusCapabilities.json'), 'utf8'));

// ── The target list must match the code ──────────────────────────────────────────────
const TARGET_DIR = join(ROOT, 'server/src/lib/compile-targets');
const codeTargets = existsSync(TARGET_DIR)
  ? readdirSync(TARGET_DIR)
    .filter((f) => f.endsWith('.js') && !['index.js', 'types.js', 'utils.js', 'workflow-renderer.js'].includes(f))
    .map((f) => f.replace(/\.js$/, '')).sort()
  : null;
check('read the compile targets from the code (not skipped)',
  Array.isArray(codeTargets) && codeTargets.length > 0, TARGET_DIR);
check('capabilities JSON has a buildTargets list',
  Array.isArray(caps.buildTargets) && caps.buildTargets.length > 0);
check(`the published target list matches server/src/lib/compile-targets (${(codeTargets || []).length} targets)`,
  JSON.stringify([...(caps.buildTargets || [])].sort()) === JSON.stringify(codeTargets),
  `published ${JSON.stringify(caps.buildTargets)} vs code ${JSON.stringify(codeTargets)}`);

// ── Run the real generator against a temp directory ──────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'seo-verify-'));
let generated = null;
try {
  writeFileSync(join(tmp, 'index.html'), readFileSync(join(ROOT, 'index.html'), 'utf8'));
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts/seo-static.mjs')], {
    env: { ...process.env, SEO_DIST: tmp }, encoding: 'utf8',
  });
  check('the generator runs against a plain index.html copy',
    run.status === 0, (run.stderr || run.stdout || '').trim().slice(0, 300));
  if (run.status === 0) {
    generated = {
      html: readFileSync(join(tmp, 'index.html'), 'utf8'),
      llms: existsSync(join(tmp, 'llms.txt')) ? readFileSync(join(tmp, 'llms.txt'), 'utf8') : null,
      sitemap: existsSync(join(tmp, 'sitemap.xml')) ? readFileSync(join(tmp, 'sitemap.xml'), 'utf8') : null,
      manual: existsSync(join(tmp, 'manual.html')) ? readFileSync(join(tmp, 'manual.html'), 'utf8') : null,
      llmsFull: existsSync(join(tmp, 'llms-full.txt')) ? readFileSync(join(tmp, 'llms-full.txt'), 'utf8') : null,
    };
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (generated) {
  const { html, llms, sitemap, manual, llmsFull } = generated;

  // ── The prerender is complete: everything a reader needs is in the HTML ────────────
  const missing = [];
  for (const c of caps.capabilities) {
    if (!html.includes(c.title)) missing.push(`title:${c.title}`);
    // Bodies contain typographic quotes and arrows; compare on a normalised form.
    const norm = (s) => String(s).replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
    if (!norm(html).includes(norm(c.body).slice(0, 60))) missing.push(`body:${c.title}`);
  }
  check(`every capability (${caps.capabilities.length}) is in the static HTML`,
    missing.length === 0, missing.slice(0, 4).join(', '));
  check('the principle, intro and closing are in the static HTML',
    html.includes('Full-stack software, built by chat') && html.includes('You own every file'));
  check('every build target is in the static HTML',
    caps.buildTargets.every((t) => html.includes(t)));
  check('the pricing line is in the static HTML (and promises no subscription, not "no free tier")',
    /200 free credits/.test(html) && !/no free tier/i.test(html));

  // ── The user manual is published, for machines AND people ─────────────────────────
  // It is generated from the same module that writes USER-MANUAL.txt into a build, so the published manual
  // cannot drift from the one a user receives. Asserting that equivalence is the whole point of these checks:
  // a hand-maintained copy of the manual would pass a "does it mention installing" test and still be wrong.
  check('a manual page is published', Boolean(manual) && manual.length > 5000);
  if (manual) {
    check('…with a section for every registered target',
      codeTargets.every((t) => manual.includes(`id="${t}"`)),
      codeTargets.filter((t) => !manual.includes(`id="${t}"`)).join(', '));
    check('…carrying each target\'s install steps, not just its name',
      (manual.match(/INSTALLING IT/g) || []).length >= codeTargets.length);
    // Recompute the guide here and look for a contiguous chunk of it in the page. The page is HTML-escaped, so
    // the comparison is made against the unescaped text — otherwise a phrase containing an em dash could never
    // match and the check would fail for the wrong reason (or, worse, pass on a shorter coincidental string).
    const unescapeHtml = (v) => v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    // Exactly what the generator does, label included: passing the id as the label produced "a web-app build"
    // where the page says "a Web App build", and the check failed one word in — which is the check doing its job
    // on a mismatch that was mine, not the generator's.
    const guideFor = renderUserManual({
      projectName: 'Your project', target: codeTargets[0],
      targetLabel: getCompileTarget(codeTargets[0])?.label || codeTargets[0], files: [],
    });
    // A CONTIGUOUS slice, blank lines included: filtering the blanks out — the obvious "tidy" move — breaks the
    // match at the first blank line and the check fails on a page that is perfectly correct.
    const chunk = guideFor.split('\n').slice(2, 9).join('\n');
    check('…and its text IS the renderer\'s output, recomputed here rather than trusted',
      chunk.length > 120 && unescapeHtml(manual).includes(chunk),
      chunk.slice(0, 60));
    check('…visible, with no hiding style anywhere in it',
      !/display\s*:\s*none|visibility\s*:\s*hidden/i.test(manual));
    check('…and it says it is the manual, in the title a reader and a crawler both see',
      /<title>[^<]*manual/i.test(manual));
  }
  check('a full-text file is published for a tool that fetches one URL',
    Boolean(llmsFull) && codeTargets.every((t) => llmsFull.includes(t)));
  check('llms.txt points at both', Boolean(llms) && llms.includes('/manual') && llms.includes('/llms-full.txt'));
  check('the sitemap lists the manual as a real page', Boolean(sitemap) && sitemap.includes('/manual'));
  // ORDERING, and it is the difference between a page and a 404: Netlify takes the FIRST matching rule, so the
  // manual rewrite has to come before the SPA catch-all or the clean URL serves index.html.
  const redirects = readFileSync(join(ROOT, 'public/_redirects'), 'utf8');
  const manualRule = redirects.indexOf('/manual  /manual.html');
  const catchAll = redirects.indexOf('/*  /index.html');
  check('the /manual rewrite comes BEFORE the SPA catch-all', manualRule >= 0 && catchAll > manualRule);
  // A page no human can reach is a page only crawlers see, which is the line this file exists to hold.
  // (named apart from the later `landingSrc`, which reads the same file for the capability checks)
  const landingForManualLink = readFileSync(join(ROOT, 'src/pages/Landing.jsx'), 'utf8');
  check('the landing page links to it visibly, with a real <a> (it is not an SPA route)',
    landingForManualLink.includes('href="/manual"'));

  // ── Structured data parses and says the right things ──────────────────────────────
  const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  let ld = null;
  try { ld = ldMatch ? JSON.parse(ldMatch[1]) : null; } catch { ld = null; }
  check('a JSON-LD block is present and parses', !!ld);
  const types = ld ? (ld['@graph'] || []).map((n) => n['@type']) : [];
  check('JSON-LD carries Organization, SoftwareApplication and FAQPage',
    ['Organization', 'SoftwareApplication', 'FAQPage'].every((t) => types.includes(t)), types.join(','));
  if (ld) {
    const app = ld['@graph'].find((n) => n['@type'] === 'SoftwareApplication');
    check('SoftwareApplication lists every capability as a feature',
      Array.isArray(app.featureList) && app.featureList.length === caps.capabilities.length);
    const faq = ld['@graph'].find((n) => n['@type'] === 'FAQPage');
    const answers = JSON.stringify(faq.mainEntity);
    check('the FAQ states the real target count', answers.includes(String(caps.buildTargets.length)));
    check('the FAQ does not repeat either false claim',
      !/no free tier/i.test(answers) && !/not stored on Morpheus/i.test(answers));
    check('the FAQ answers what the "digital possibility engine" framing means, in the JSON\'s own words',
      Boolean(caps.possibility) && answers.includes(caps.possibility.body));
  }

  // ── A machine reading morpheus.nz must learn the PRODUCT'S OWN NOUNS ──────────────
  // Rob, 2026-10-04: talking to an external Gemini about morpheus.nz, it *"cant tell me anything
  // about the plugin or the personal assistant or talk about it as a digital possibility engine"*.
  // It could not, and the reason was measurable: every machine surface was generated from a
  // capability list whose 16 entries named none of them — "Voice" was Jarvis with his name filed
  // off. So the nouns are pinned here, against the JSON, on the two surfaces a model actually
  // reads. A rename in the JSON that never reaches the generated files fails this.
  const NOUNS = ['Jarvis', 'Command Deck', 'dock', 'WordPress', 'digital possibility engine'];
  for (const [what, text] of [['the static HTML', html], ['llms.txt', llms], ['llms-full.txt', llmsFull]]) {
    check(`${what} names the assistant, the Deck, the dock and the possibility engine`,
      Boolean(text) && NOUNS.every((n) => text.includes(n)),
      NOUNS.filter((n) => !text || !text.includes(n)).join(', '));
  }
  const appSrc = readFileSync(join(ROOT, 'src/App.jsx'), 'utf8');
  check('the Deck and Jarvis are real routes in the app, not only words in copy',
    appSrc.includes('path="/deck"') && appSrc.includes('path="jarvis"'));
  check('the dock script the copy promises is the one that ships',
    existsSync(join(ROOT, 'public/plugin.js'))
    && /data-dock/.test(readFileSync(join(ROOT, 'public/plugin.js'), 'utf8')));
  // A count in published copy is the "6 platforms" failure waiting to happen, so it is read
  // from the registry that defines the widgets and asserted against the sentence that quotes it.
  const widgetCount = (readFileSync(join(ROOT, 'src/pages/CommandDeck/deckWidgets.js'), 'utf8').match(/key:\s*'/g) || []).length;
  check(`the published widget count is the registry's (${widgetCount})`,
    widgetCount > 0 && caps.capabilities.some((c) => c.body.includes(`${widgetCount} widgets`)),
    `deckWidgets.js has ${widgetCount}`);
  check('the possibility paragraph is in the prerender and in llms.txt, verbatim from the JSON',
    Boolean(caps.possibility)
    && html.includes(caps.possibility.title) && html.includes(caps.possibility.body.slice(0, 60))
    && llms.includes(caps.possibility.title) && llms.includes(caps.possibility.body.slice(0, 60)));

  // ── CLOAKING: the prerendered block must not be hidden from people ────────────────
  const section = (html.match(/<section id="seo-landing"[\s\S]*?<\/section>/) || [''])[0];
  check('the prerendered section exists', section.length > 500);
  check('the prerendered section carries NO hiding style (cloaking)',
    !/\bstyle\s*=/.test(section)
    && !/(display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0|font-size\s*:\s*0|text-indent\s*:\s*-|left\s*:\s*-\d)/i.test(section),
    section.slice(0, 160));
  check('the prerendered section is not inside a <noscript> or hidden container',
    !/<noscript[\s\S]*<section id="seo-landing"/.test(html));
  // The decisive check: a prerender mirrors what the page renders. A bot-only block does
  // not, and this is the line between the two.
  const landingSrc = readFileSync(join(ROOT, 'src/pages/Landing.jsx'), 'utf8');
  check('the page itself renders the possibility paragraph too (it is not in the prerender only)',
    /MORPHEUS_POSSIBILITY\.title/.test(landingSrc) && /MORPHEUS_POSSIBILITY\.body/.test(landingSrc));
  check('the page itself renders the same capability list (a prerender, not a bot-only block)',
    /MORPHEUS_CAPABILITIES\.map/.test(landingSrc) && /MORPHEUS_BUILD_TARGETS\.map/.test(landingSrc));
  check('the landing page shows all capabilities, not a scroll box',
    !/max-h-\d+ overflow-y-auto[\s\S]{0,120}MORPHEUS_CAPABILITIES/.test(landingSrc));

  // ── llms.txt and sitemap.xml ──────────────────────────────────────────────────────
  check('llms.txt was written', !!llms);
  if (llms) {
    check('llms.txt carries the principle and every capability',
      llms.includes('Full-stack software, built by chat')
      && caps.capabilities.every((c) => llms.includes(c.title)));
    check('llms.txt carries the targets and the pricing line',
      caps.buildTargets.every((t) => llms.includes(t)) && /200 free credits/.test(llms));
    check('llms.txt is not an HTML page (the SPA catch-all bug)',
      !/^\s*<!doctype html/i.test(llms));
  }
  check('sitemap.xml was written', !!sitemap);
  if (sitemap) {
    check('sitemap.xml is XML, not an HTML page served by the catch-all',
      /^<\?xml/.test(sitemap) && /<urlset/.test(sitemap) && !/<!doctype html/i.test(sitemap));
    check('sitemap.xml lists the public routes', ['/', '/start', '/market', '/portable-morpheus'].every((r) => sitemap.includes(`<loc>https://morpheus.nz${r}</loc>`)));
  }
}

// ── The static sources ───────────────────────────────────────────────────────────────
const indexSrc = readFileSync(join(ROOT, 'index.html'), 'utf8');
check('index.html has a meta description', /<meta name="description" content="[^"]{40,}"/.test(indexSrc));
check('index.html has a canonical link', /rel="canonical"/.test(indexSrc));
check('index.html has Open Graph tags', /property="og:title"/.test(indexSrc) && /property="og:description"/.test(indexSrc) && /property="og:image"/.test(indexSrc));
check('index.html has a Twitter card', /name="twitter:card"/.test(indexSrc));
check('index.html keeps the prerender marker the generator needs', indexSrc.includes('<!-- seo-static:prerender'));

const robotsPath = join(ROOT, 'public/robots.txt');
check('public/robots.txt exists', existsSync(robotsPath));
if (existsSync(robotsPath)) {
  const robots = readFileSync(robotsPath, 'utf8');
  check('robots.txt is a real robots file, not the SPA shell',
    /User-agent:/i.test(robots) && !/<!doctype html/i.test(robots));
  check('robots.txt advertises the sitemap', /^Sitemap:\s*https:\/\/morpheus\.nz\/sitemap\.xml/m.test(robots));
  check('robots.txt explicitly welcomes AI crawlers (the point of the exercise)',
    ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'OAI-SearchBot'].every((b) => robots.includes(b)));
  check('robots.txt keeps the signed-in app out of the index',
    /Disallow:\s*\/workspace/.test(robots) && /Disallow:\s*\/deck/.test(robots));
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
check('the generator is wired into the build (postbuild)',
  /seo-static\.mjs/.test(pkg.scripts?.postbuild || ''), pkg.scripts?.postbuild || '(none)');

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('\nThe machine-readable surface is missing, drifted from the code, or is text');
  console.log('hidden from people. Hidden text is cloaking — it would penalise the domain');
  console.log('this exists to promote. Publish it as metadata and structured data, and make');
  console.log('the prerender the thing the page actually shows.\n');
  process.exit(1);
}
console.log('morpheus.nz tells machines what it is, from the same source the page renders.\n');
