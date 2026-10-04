// Generate the machine-readable surface of morpheus.nz from the ONE source of truth.
//
// WHY THIS EXISTS
//
// Until 2026-09-25, fetching morpheus.nz returned a 1.5 KB React shell whose entire
// content was `<title>Morpheus</title>` — no description, no Open Graph, no structured
// data, no text at all. Marketing tools and AI answer engines reported, correctly, that
// they could not tell what the product was or did. `/robots.txt` and `/sitemap.xml` did
// not exist either: the SPA catch-all in public/_redirects answered every path with
// index.html, so a crawler asking for a sitemap got HTML.
//
// THE MECHANISM MATTERS. The obvious "fix" — text hidden in the page so only crawlers
// read it — is cloaking, and it would put a penalty on the domain this is meant to
// promote. So this writes metadata and structured data (which are *supposed* to be
// machine-facing) plus a prerender of content the page genuinely shows a human:
// src/pages/Landing.jsx renders the same capabilities from the same JSON. Nothing here
// is content a person cannot see.
//
// EVERY WORD IS SOURCED. `src/lib/morpheusCapabilities.json` is what the app itself
// renders, and the pricing and target lines are read from the code (server/src/lib/
// compile-targets, billing.js's 200-credit grant) rather than typed from memory. Claims
// checked against generated evidence by `node scripts/reality.mjs` in the repo root:
// "10 targets" was UNDERSTATED as "6 platforms" in the explainer docs, "no free tier" is
// FALSE (the 200-credit grant is live), and "your data is not stored on Morpheus's
// servers" is FALSE (21 deck_* tables in Morpheus's own Supabase). None of the false
// ones appear below. **If a claim is added here, check it against reality.mjs first —
// this file is now quoted by search engines and AI tools, not just read by a human.**
//
// Runs from `npm run build` (postbuild). Dependency-free. Never touches the source tree:
// it only writes into dist/.
//
//   node scripts/seo-static.mjs

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
// The manual is generated from the SAME module the app uses to write USER-MANUAL.txt into a build. That is the
// point: the published manual cannot drift from the one a user actually receives, because there is only one.
import { renderUserManual } from '../server/src/lib/appUserManual.js';
import { getCompileTarget, listCompileTargets } from '../server/src/lib/compile-targets/index.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// SEO_DIST lets a guard run this whole generator against a temp directory, which is how
// scripts/verify-seo-static.mjs checks it end-to-end without needing a vite build — the
// CI guards job has no dist/. A check that cannot run is not a pass.
const DIST = process.env.SEO_DIST || join(ROOT, 'dist');
const SITE = 'https://morpheus.nz';

if (!existsSync(DIST)) {
  console.error('  dist/ not found — run vite build first (this runs as postbuild)');
  process.exit(1);
}

const caps = JSON.parse(readFileSync(join(ROOT, 'src/lib/morpheusCapabilities.json'), 'utf8'));
const { principle, intro, closing, capabilities = [], examples = [] } = caps;

// Read the build targets from the code, so a new adapter cannot be forgotten here — the
// same list reality.mjs reports. "6 platforms" was the explainer docs understating ten.
const TARGET_DIR = join(ROOT, 'server/src/lib/compile-targets');
let targets = [];
if (existsSync(TARGET_DIR)) {
  targets = readdirSync(TARGET_DIR)
    .filter((f) => f.endsWith('.js') && !['index.js', 'types.js', 'utils.js', 'workflow-renderer.js'].includes(f))
    .map((f) => f.replace(/\.js$/, ''))
    .sort();
}

// Verified against the running system: the grant is live and 6 accounts hold exactly 200
// credits (reality.mjs), and billing.js carries the grant constant. The subscription line
// matches what the code does, not what the financial reports claimed.
const PRICING = 'No subscription. Every account starts with 200 free credits — enough to plan, build and ship a real first app — then pay-as-you-go, or free forever on your own AI provider key.';

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// ── 1. Structured data ───────────────────────────────────────────────────────────────
const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': `${SITE}/#organization`,
      name: 'Morpheus',
      url: `${SITE}/`,
      logo: `${SITE}/morpheus-icon.svg`,
      description: principle,
    },
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE}/#software`,
      name: 'Morpheus',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Web, Android, iOS, macOS, Windows, Linux, Raspberry Pi',
      url: `${SITE}/`,
      description: intro,
      featureList: capabilities.map((c) => c.title),
      publisher: { '@id': `${SITE}/#organization` },
      offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'USD',
        description: PRICING,
      },
    },
    {
      '@type': 'FAQPage',
      '@id': `${SITE}/#faq`,
      mainEntity: [
        {
          '@type': 'Question',
          name: 'What is Morpheus?',
          acceptedAnswer: { '@type': 'Answer', text: `${principle} ${intro}` },
        },
        {
          '@type': 'Question',
          name: 'What can Morpheus build?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: capabilities.map((c) => `${c.title}: ${c.body}`).join(' '),
          },
        },
        {
          '@type': 'Question',
          name: 'Which platforms can Morpheus build for?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: `Morpheus compiles to ${targets.length} targets: ${targets.join(', ')}.`,
          },
        },
        {
          '@type': 'Question',
          name: 'How much does Morpheus cost?',
          acceptedAnswer: { '@type': 'Answer', text: PRICING },
        },
        {
          '@type': 'Question',
          name: 'Do I own the code Morpheus writes?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'Yes. Every file is written into your own project and pushed to your own GitHub repository. There is no runtime dependency on Morpheus and nothing stops working if you stop paying.',
          },
        },
        ...examples.slice(0, 3).map((ex) => ({
          '@type': 'Question',
          name: ex.title,
          acceptedAnswer: { '@type': 'Answer', text: ex.scenario },
        })),
      ],
    },
  ],
};

// ── 2. A prerender of what the page really shows ─────────────────────────────────────
// Not a bot-only block: Landing.jsx renders this same capability list from this same
// JSON, and the styled intro is an overlay on top. A visitor with no JS now sees the
// product description instead of a spinner that never resolves.
const landingSection = `
      <!-- seo-static:start — generated by scripts/seo-static.mjs from src/lib/morpheusCapabilities.json -->
      <section id="seo-landing" aria-label="What Morpheus is and what it does">
        <h1>Morpheus — full-stack software, built by chat</h1>
        <p>${esc(principle)}</p>
        <p>${esc(intro)}</p>
        <h2>What Morpheus does</h2>
        <ul>
${capabilities.map((c) => `          <li><h3>${esc(c.title)}</h3><p>${esc(c.body)}</p>${c.workflow ? `<p>${esc(c.workflow)}</p>` : ''}</li>`).join('\n')}
        </ul>
        <h2>Build targets</h2>
        <p>Morpheus compiles to ${targets.length} targets:</p>
        <ul>${targets.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
        <h2>Pricing</h2>
        <p>${esc(PRICING)}</p>
        <p>${esc(closing)}</p>
      </section>
      <!-- seo-static:end -->`;

// ── 2b. the user manual, published — the same text a download carries ────────────────
// WHY THIS IS PUBLIC AND THE ENGINEERING DOCS ARE NOT: every build already ships USER-MANUAL.txt, so this
// publishes claims the product ALREADY makes rather than new copy — and "how do I install this on a Mac?" is
// exactly the question someone asks a machine. AGENTS.md, KNOWN-HAZARDS.md and the session logs stay private:
// they carry incident records, security items and internal decisions, and none of that belongs in a crawler.
const manualTargets = listCompileTargets().map((id) => ({ id, label: getCompileTarget(id)?.label || id }));
// No project name and no files: this is the generic guide for each target, which is what a stranger needs.
const manualText = (t) => renderUserManual({ projectName: 'Your project', target: t.id, targetLabel: t.label, files: [] });

const manualHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Morpheus user manual — installing and running what you build</title>
<meta name="description" content="How to install and run what Morpheus builds: ${manualTargets.length} targets, from a Windows .exe to a Raspberry Pi image, including the unsigned-software warnings each platform puts in your way." />
<link rel="canonical" href="${SITE}/manual" />
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 2rem 1rem 5rem; background: #050705; color: #b9ffc4;
         font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
  main { max-width: 82ch; margin: 0 auto; }
  h1 { color: #7dff9b; font-size: 1.4rem; letter-spacing: .08em; text-transform: uppercase; }
  h2 { color: #7dff9b; font-size: 1rem; margin: 2.5rem 0 .5rem; letter-spacing: .06em; }
  p.lede { color: #86c993; }
  nav a { color: #7dff9b; margin-right: .75rem; white-space: nowrap; }
  pre { white-space: pre-wrap; background: #0a0f0a; border-left: 2px solid #1f5c2c; padding: 1rem; overflow-x: auto; }
  a { color: #9effb5; }
  footer { margin-top: 3rem; color: #6f9c78; }
</style>
</head>
<body>
<main>
  <h1>Morpheus user manual</h1>
  <p class="lede">This is the manual that ships with a build, for every target Morpheus can compile to. It covers
  installing what you made, starting it, and the warnings each platform puts in front of unsigned software —
  because that is the part that looks like a broken download and is not.</p>
  <nav>${manualTargets.map((t) => `<a href="#${esc(t.id)}">${esc(t.label)}</a>`).join('')}</nav>
${manualTargets.map((t) => `  <h2 id="${esc(t.id)}">${esc(t.label)}</h2>
  <pre>${esc(manualText(t))}</pre>`).join('\n')}
  <footer>
    <p>Morpheus is a chat-driven software builder — describe it, and it writes the code, compiles a native
    build and puts it in a repository you own. <a href="${SITE}/">${SITE.replace('https://', '')}</a></p>
    <p>Machine-readable: <a href="/llms.txt">/llms.txt</a> · <a href="/llms-full.txt">/llms-full.txt</a></p>
  </footer>
</main>
</body>
</html>
`;

// The llms.txt convention's "full" companion: everything in one file, so a tool that fetches one URL has the
// whole manual rather than an index it has to follow links from.
const llmsFull = `# Morpheus — full reference

> ${principle}

${intro}

## User manual

The manual that ships with a build, for every target. Each section covers installing it, starting it, and the
unsigned-software warnings that platform puts in your way.

${manualTargets.map((t) => `### ${t.label}\n\nTarget id: \`${t.id}\`\n\n${manualText(t)}`).join('\n\n')}
`;

// ── 3. llms.txt — the plain-text brief AI tools look for ─────────────────────────────
const llms = `# Morpheus

> ${principle}

${intro}

Morpheus is a chat-driven software builder. You describe an application in plain
language and it writes the real files — frontend, backend, database schema — reviews
them, pins them to a GitHub repository you own, and compiles a native build. It runs
from a phone as well as a desktop.

## What Morpheus does

${capabilities.map((c) => `- **${c.title}** — ${c.body}${c.workflow ? `\n  Workflow: ${c.workflow}` : ''}`).join('\n')}

## Build targets (${targets.length})

${targets.map((t) => `- ${t}`).join('\n')}

## How a build works

Describe it in chat → Morpheus plans the file structure → writes each file in full →
runs a review pass → verifies it compiles → pushes to a branch on your repo → opens and
merges a pull request once the checks pass. "Revert last push" undoes it in one click.

## Pricing

${PRICING}

## Ownership

Every file is written into your own project and pushed to your own GitHub repository.
There is no runtime dependency on Morpheus, and nothing stops working if you stop paying.

## Manual

Every build ships a user manual covering installing it, starting it, and the unsigned-software warnings each
platform puts in your way. The whole thing, for all ${targets.length} targets:

- Read it: ${SITE}/manual
- One file for a machine: ${SITE}/llms-full.txt

## Links

- Home: ${SITE}/
- Start building: ${SITE}/start
- Marketplace: ${SITE}/market
- Desktop build: ${SITE}/portable-morpheus
`;

// ── 4. Sitemap ───────────────────────────────────────────────────────────────────────
// Public routes only. The signed-in application is Disallowed in robots.txt so a login
// shell is not indexed as if it were content.
const PUBLIC_ROUTES = [
  ['/', '1.0'],
  ['/start', '0.9'],
  ['/market', '0.8'],
  ['/portable-morpheus', '0.8'],
  ['/register', '0.7'],
  ['/login', '0.5'],
  ['/terms', '0.3'],
  ['/privacy', '0.3'],
  ['/refund-policy', '0.3'],
  // A real page with real content for every target, linked visibly from the landing page — not a text file
  // only crawlers are told about, which is the line between publishing and cloaking.
  ['/manual', '0.8'],
];
const today = new Date().toISOString().slice(0, 10);
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${PUBLIC_ROUTES.map(([p, prio]) => `  <url>\n    <loc>${SITE}${p}</loc>\n    <lastmod>${today}</lastmod>\n    <priority>${prio}</priority>\n  </url>`).join('\n')}
</urlset>
`;

// ── Write ────────────────────────────────────────────────────────────────────────────
const indexPath = join(DIST, 'index.html');
let html = readFileSync(indexPath, 'utf8');

const PRERENDER_MARKER = '<!-- seo-static:prerender';
if (html.includes('seo-static:start')) {
  console.log('  seo-static: already injected (skipping the body/JSON-LD, refreshing the files)');
} else {
  if (!html.includes(PRERENDER_MARKER)) {
    console.error(`  FAILED: ${PRERENDER_MARKER} … --> is missing from index.html. It is the anchor`);
    console.error('  this prerender is injected at; without it the content would land somewhere');
    console.error('  unpredictable. Restore the marker in index.html.');
    process.exit(1);
  }
  html = html.replace('</head>', `  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>\n  </head>`);
  html = html.replace(/<!-- seo-static:prerender[\s\S]*?-->/, landingSection.trim());
  if (!html.includes('seo-static:start')) {
    console.error('  FAILED: injection did not take — dist/index.html is unchanged');
    process.exit(1);
  }
  writeFileSync(indexPath, html);
}

writeFileSync(join(DIST, 'llms.txt'), llms);
writeFileSync(join(DIST, 'llms-full.txt'), llmsFull);
writeFileSync(join(DIST, 'manual.html'), manualHtml);
writeFileSync(join(DIST, 'sitemap.xml'), sitemap);

const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(1)} KB`;
console.log(`  seo-static: index.html ${kb(html)} · JSON-LD ${kb(JSON.stringify(jsonLd))} · llms.txt ${kb(llms)} · sitemap.xml ${kb(sitemap)}`);
console.log(`  seo-static: ${capabilities.length} capabilities, ${targets.length} build targets, ${PUBLIC_ROUTES.length} public routes`);
console.log(`  seo-static: manual.html ${kb(manualHtml)} · llms-full.txt ${kb(llmsFull)} · ${manualTargets.length} target guides`);
