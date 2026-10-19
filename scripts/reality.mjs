// What Morpheus IS right now — repo, production and deploy, consolidated, with
// the marketing claims checked against the system they describe.
//
// WHY THIS EXISTS
//
// 13 planning documents had drifted from the code and from each other: ~27
// financial contradictions, 12 backlog contradictions, and claims the live
// system does not meet ("no free tier exists" while five accounts held 200
// signup credits; "not stored on Morpheus's servers" while 21 deck_* tables sat
// in Supabase; "hard stop before overspend" while an account sat at -3.77).
//
// The repo already solved this once for its own memory — "facts are generated
// or checked; rules stay curated" (see scripts/context.mjs). This extends that
// principle past the repo boundary to PRODUCTION and to the CLAIMS: the things
// that actually drift, and that decisions get made on.
//
// Nothing here is remembered. Repo facts come from context.mjs; production
// facts are queried live; deploy facts come from the Northflank API; the claims
// are checked against both. If this disagrees with a document, the document is
// wrong.
//
// Run: node scripts/reality.mjs
//      node scripts/reality.mjs --json
//
// Credentials are optional and degrade honestly: without server/.env.prodsql the
// production section prints NOT VERIFIED and the claim checks that need it are
// skipped — never guessed.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(REPO, 'server');
const JSON_OUT = process.argv.includes('--json');
// Read a repo file as text, or '' if it isn't there — every check below treats
// a missing file as "not built" rather than throwing.
const srcFile = (p) => (existsSync(join(REPO, p)) ? readFileSync(join(REPO, p), 'utf8') : '');
const out = { generatedAt: new Date().toISOString(), ethos: null, built: null, live: null, deployed: null, claims: [] };

// ── Intent ───────────────────────────────────────────────────────────────────
// Curated on purpose. This is the one part that is judgement, not fact, and it
// is the thing every other line here should be measured against.
out.ethos = {
  thesis: 'Build software by describing it, and keep what you build.',
  principles: [
    'Ownership, not rental — the code is the user\'s, in their own repo, and does not disappear when they stop paying.',
    'Model-agnostic — never locked to one AI provider.',
    'Native output — real Android/iOS/desktop/Linux builds, not a browser wrapper wearing an app icon.',
    'An honest meter — cost shown before the action runs, not discovered after.',
    // Changed 2026-09-28 (Rob): own-key calls are charged 1 credit, so this is no longer FREE —
    // a complete free path cannot be covered at current prices. It stays genuinely cheap and
    // genuinely uncapped: the operator's own key, ~16x cheaper than a platform-key call, and never
    // a trial. The line must move with the meter — see lib/creditPolicy.js and verify-ai-cost-claims.
    'A genuinely cheap path — the user\'s own provider key, billed at 1 credit a call instead of ~16, never a trial.',
    'Command Deck exists so life-context is synthesised across domains, not siloed in single-purpose apps.',
  ],
};

// ── What is built (repo-derived, never remembered) ───────────────────────────
try {
  out.built = JSON.parse(execFileSync(process.execPath, [join(REPO, 'scripts/context.mjs'), '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
} catch (err) {
  out.built = { error: `context.mjs failed: ${err.message.split('\n')[0]}` };
}

const targetsDir = join(SERVER, 'src/lib/compile-targets');
const NON_TARGETS = new Set(['index', 'types', 'utils', 'workflow-renderer']);
const compileTargets = existsSync(targetsDir)
  ? readdirSync(targetsDir).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, '')).filter((n) => !NON_TARGETS.has(n)).sort()
  : [];

// ── Production (live, optional credential) ───────────────────────────────────
const PROD_ENV = join(SERVER, '.env.prodsql');
let prisma = null;
if (existsSync(PROD_ENV)) {
  try {
    process.loadEnvFile(PROD_ENV);
    const { PrismaClient } = await import(join(SERVER, 'node_modules/@prisma/client/default.js'));
    prisma = new PrismaClient({ datasources: { db: { url: process.env.PROD_DATABASE_URL } }, log: ['error'] });
    const q = async (sql) => (await prisma.$queryRawUnsafe(sql))[0];
    out.live = {
      users: await q('select count(*)::int as n from users'),
      signups30d: await q("select count(*)::int as n from users where created_date > now() - interval '30 days'"),
      signups7d: await q("select count(*)::int as n from users where created_date > now() - interval '7 days'"),
      projects: await q('select count(*)::int as n from projects'),
      creditRevenue: await q("select coalesce(sum(amount_usd),0)::float as usd, count(*)::int as n from credit_transactions where status = 'paid'"),
      donationRevenue: await q("select coalesce(sum(amount),0)::float as usd, count(*)::int as n from donations where status = 'paid'"),
      aiCalls: await q('select count(*)::int as n from usage_events'),
      aiCalls7d: await q("select count(*)::int as n from usage_events where created_date > now() - interval '7 days'"),
      accountsUsingAi: await q('select count(distinct created_by_id)::int as n from usage_events'),
      deckTables: await q("select count(*)::int as n from information_schema.tables where table_schema='public' and table_name like 'deck_%'"),
      accountsAtSignupGrant: await q('select count(*)::int as n from users where credit_balance = 200'),
      accountsNegativeBalance: await q('select count(*)::int as n from users where credit_balance < 0'),
      modelsUsed: await prisma.$queryRawUnsafe('select model_id, count(*)::int as n from usage_events group by model_id order by n desc'),
      catalogEntries: await q('select count(*)::int as n from model_catalog_entries'),
    };
  } catch (err) {
    out.live = { error: `production unavailable: ${String(err.message).split('\n')[0].slice(0, 120)}` };
    prisma = null;
  }
} else {
  out.live = { error: 'NOT VERIFIED — server/.env.prodsql missing' };
}

// ── Deploy (live, optional credential) ───────────────────────────────────────
const NF_ENV = join(SERVER, '.env.northflank');
if (existsSync(NF_ENV)) {
  try {
    process.loadEnvFile(NF_ENV);
    const { getServiceStatus } = await import(join(SERVER, 'src/lib/northflank.js'));
    const s = await getServiceStatus();
    out.deployed = {
      service: s?.name,
      build: s?.status?.build?.status,
      buildAt: s?.status?.build?.lastTransitionTime,
      deployment: s?.status?.deployment?.status,
      deploymentAt: s?.status?.deployment?.lastTransitionTime,
      repoMain: execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
    };
  } catch (err) {
    out.deployed = { error: `deploy status unavailable: ${String(err.message).split('\n')[0].slice(0, 100)}` };
  }
} else {
  out.deployed = { error: 'NOT VERIFIED — server/.env.northflank missing' };
}

// ── Claims vs the system they describe ───────────────────────────────────────
// Each check states what a document claimed, then what the system says. Only
// checks whose evidence is actually available run; the rest are reported as
// unverifiable rather than passed.
const claims = out.claims;
const live = out.live && !out.live.error ? out.live : null;

claims.push({
  claim: 'Documents advertise "6 platforms".',
  evidence: `server/src/lib/compile-targets/ contains ${compileTargets.length} target adapters`,
  list: compileTargets,
  verdict: compileTargets.length === 6 ? 'MATCHES' : compileTargets.length > 6 ? `UNDERSTATED — ${compileTargets.length} targets exist` : `OVERSTATED — only ${compileTargets.length}`,
});

claims.push({
  claim: '"The finalized model has no free tier" (Business Report v6, Competitive Positioning v6).',
  evidence: live ? `users table: ${live.accountsAtSignupGrant.n} account(s) hold exactly the 200-credit signup grant` : 'needs production access',
  verdict: !live ? 'UNVERIFIABLE' : live.accountsAtSignupGrant.n > 0 ? 'FALSE — a free signup grant exists and is live' : 'CONSISTENT',
});

claims.push({
  claim: '"Your data stays yours, not stored on Morpheus\'s servers" (Command Deck explainer).',
  evidence: live ? `${live.deckTables.n} deck_* tables in Morpheus\'s own Supabase` : 'needs production access',
  verdict: !live ? 'UNVERIFIABLE' : live.deckTables.n > 0 ? 'FALSE — the data is stored on Morpheus\'s servers' : 'CONSISTENT',
});

claims.push({
  claim: '"Hard stop before overspend" / pre-call reservation (Competitive Positioning).',
  evidence: live ? `${live.accountsNegativeBalance.n} account(s) with a negative credit balance` : 'needs production access',
  verdict: !live ? 'UNVERIFIABLE' : live.accountsNegativeBalance.n > 0 ? 'VIOLATED — an account spent past zero' : 'HOLDS',
});

// ── The nouns on the published surface (2026-10-04) ──────────────────────────
// Rob asked an external Gemini about morpheus.nz and it could not say what the plugin, the
// personal assistant or the "digital possibility engine" were. The generated surfaces were
// accurate about the builder and silent about all three, because the capability JSON —
// their only source — never contained the words. These check that the nouns are now
// published AND that what is published is true, which is the part that matters: anyone can
// put "Jarvis" on a page.
const appSrc = srcFile('src/App.jsx');
const publishedCaps = (() => {
  try { return JSON.parse(srcFile('src/lib/morpheusCapabilities.json')); } catch { return null; }
})();
const publishedText = publishedCaps ? JSON.stringify(publishedCaps) : '';

const deckBuilt = [
  ['a /deck route', appSrc.includes('path="/deck"')],
  ['a /deck/jarvis route', appSrc.includes('path="jarvis"')],
  ['brain-dump auto-filing', existsSync(join(SERVER, 'src/lib/deckDumpClassify.js'))],
  ['long-term memory', existsSync(join(SERVER, 'src/lib/deckMemory.js'))],
  ['cross-deck synthesis', existsSync(join(SERVER, 'src/functions/runJarvisSynthesis.js'))],
  // The own-data rule, which is the claim "his own memory ... rather than a view onto
  // Morpheus's": a Deck/Jarvis message store separate from the builder's ChatMessage.
  ['Jarvis\'s own message store (not the builder\'s)', /model\s+DeckJarvisMessage/.test(srcFile('server/prisma/schema.prisma'))],
];
const deckMissing = deckBuilt.filter(([, ok]) => !ok).map(([what]) => what);

claims.push({
  claim: 'The published surface calls Jarvis a personal assistant, a second product at /deck, with his own memory.',
  evidence: deckBuilt.map(([what, ok]) => `${ok ? '✓' : '✗'} ${what}`).join(', '),
  verdict: deckMissing.length ? `PARTLY BUILT — missing: ${deckMissing.join(', ')}` : 'BUILT',
});

const dockBuilt = [
  ['the dock loader', srcFile('public/plugin.js').includes('data-dock')],
  // The plugin SOURCE, not the packed zip: public/morpheus-wordpress-plugin.zip and
  // plugin-manifest.json are gitignored build artifacts produced by prebuild, so checking for
  // them here reports a false gap in any tree that has not been built — which is exactly what
  // this reported the first time it ran.
  ['the WordPress plugin source', existsSync(join(REPO, 'wp-plugin/morpheus/morpheus.php'))],
  ['the dock the plugin prints for an admin', existsSync(join(REPO, 'wp-plugin/morpheus/includes/class-dock.php'))],
  ['the embed surface it frames', appSrc.includes('path="/embed"')],
];
const dockMissing = dockBuilt.filter(([, ok]) => !ok).map(([what]) => what);

claims.push({
  claim: 'The published surface describes a Dock you paste onto your own site, with a WordPress plugin that ships it.',
  evidence: dockBuilt.map(([what, ok]) => `${ok ? '✓' : '✗'} ${what}`).join(', '),
  verdict: dockMissing.length ? `PARTLY BUILT — missing: ${dockMissing.join(', ')}` : 'BUILT',
});

// The count is the one number on the published surface that can rot silently, so it is read
// from the registry that defines the widgets and compared to the sentence that quotes it.
const publishedWidgetCount = (() => {
  const m = publishedText.match(/with (\d+) widgets/);
  return m ? Number(m[1]) : null;
})();
const realWidgetCount = out.built && !out.built.error ? out.built.deck?.widgetCount ?? null : null;

claims.push({
  claim: `The published Command Deck copy says "${publishedWidgetCount ?? 'no number'} widgets".`,
  evidence: `src/pages/CommandDeck/deckWidgets.js defines ${realWidgetCount ?? '—'} widgets`,
  verdict: realWidgetCount == null || publishedWidgetCount == null ? 'UNVERIFIABLE'
    : publishedWidgetCount === realWidgetCount ? 'MATCHES'
      : `DRIFTED — the registry has ${realWidgetCount}`,
});

// The framing is aspirational, and the one thing that would make it a false claim is the copy
// presenting it as shipped. It says the opposite, out loud, and that is asserted rather than
// assumed — an aspirational line is exactly the kind that gets quietly upgraded to a feature.
claims.push({
  claim: 'The published "digital possibility engine" framing is a direction, not a shipped feature.',
  evidence: publishedCaps?.possibility ? `"${publishedCaps.possibility.body.slice(0, 80)}…"` : 'not published',
  verdict: !publishedCaps?.possibility ? 'UNVERIFIABLE'
    : /destination rather than a shipped feature/i.test(publishedCaps.possibility.body)
      && publishedCaps.capabilities.every((c) => !/digital possibility engine/i.test(c.title))
      ? 'HONEST — published as a destination, and it is not in the capability list'
      : 'OVERSTATED — the copy reads as a delivered feature',
});

// ── Roadmap items the docs flag as UNVERIFIED ────────────────────────────────
// ROADMAP.md's own recommendation: "confirm Phase 2 (diagnosis/auto-fix) and
// Help mode toggle status directly against the live codebase, since these are
// the two genuinely uncertain items left in the original structural plan", plus
// Phase 6's PWA installability. All three turned out to be BUILT — the docs
// understated again — so they are checked here rather than re-litigated.
//
// These check for the behaviour, not just the file: a diagnosis module that is
// never called on a failed build is not "auto-fix on compile failure".
const compilePanel = srcFile('src/components/matrix/CompilePanel.jsx');
const diagnosisLib = srcFile('server/src/lib/diagnosis.js');

out.roadmap = [
  {
    item: 'Phase 2 — diagnosis agent on build failure',
    verdict: srcFile('server/src/functions/diagnoseIssue.js') && /applyFileFixes|needsUserAction/.test(diagnosisLib) ? 'BUILT' : 'NOT BUILT',
    evidence: 'diagnoseIssue.js + lib/diagnosis.js (applyFileFixes, fixResponseSchema, credential/auth classification)',
  },
  {
    item: 'Phase 2 — AUTO-fix and retry, not just a manual button',
    // The specific thing the docs could not confirm. CompilePanel must call
    // handleCompile(true) itself when the diagnosis produced fixes.
    verdict: /diag\?\.autoFixed\?\.length > 0\s*\)\s*\{\s*handleCompile\(true\)/m.test(compilePanel.replace(/\n\s*/g, '\n'))
      || /autoFixed\?\.length > 0/.test(compilePanel) && /handleCompile\(true\)/.test(compilePanel) ? 'BUILT' : 'NOT BUILT',
    evidence: 'CompilePanel.jsx re-runs the compile automatically when the diagnosis auto-fixed files',
  },
  {
    item: 'Phase 6 — PWA manifest installable',
    verdict: (() => {
      const mf = srcFile('public/manifest.json');
      if (!mf) return 'NOT BUILT';
      let m; try { m = JSON.parse(mf); } catch { return 'MALFORMED'; }
      const ok = m.name && m.start_url && ['standalone', 'fullscreen', 'minimal-ui'].includes(m.display);
      // The icons must actually exist — a manifest pointing at a missing file
      // is a silent install failure, which is how this was nearly reported.
      const missing = (m.icons || []).filter((i) => !existsSync(join(REPO, 'public', String(i.src).replace(/^\//, ''))));
      if (!ok || !(m.icons || []).length) return 'NOT BUILT';
      return missing.length ? `ICONS MISSING: ${missing.map((i) => i.src).join(', ')}` : 'INSTALLABLE';
    })(),
    evidence: 'public/manifest.json: name, start_url, display standalone, and every declared icon present',
  },
  {
    item: 'Phase 6 — offline / service worker',
    verdict: /serviceWorker/.test(srcFile('index.html') + srcFile('src/main.jsx')) ? 'BUILT' : 'NOT BUILT',
    evidence: 'installability does not require one, so this is a genuine gap, not a contradiction',
  },
  {
    item: 'Phase 7 — Help mode toggle',
    verdict: srcFile('src/components/matrix/HelpToggle.jsx') && srcFile('src/contexts/HelpModeContext.jsx') ? 'BUILT' : 'NOT BUILT',
    evidence: 'HelpModeContext (persisted) + HelpToggle button + HelpHint per-feature hints with seen-tracking',
  },
];

// ── The token/billing system: is it built, and is every model priced? ────────
// TOKEN-SYSTEM-BUILD-PLAN.md line 3 says "Nothing in this doc has been built
// yet." That was already false when written: 8 of the 9 steps are in the code.
// Checked here so the claim cannot be repeated from memory.
const has = (p) => existsSync(join(REPO, p));
// Build-loop resilience — the class of defect where a check that COULD NOT RUN costs the user the work
// it was checking. Derived, like step 7 above and for the same reason: the literal "still broken" claim
// in OPEN-WORK.md's defect list rotted for two days after the truncation fix landed (`dbd73f7`), and it
// sent a session to re-propose work that was already done.
out.buildResilience = [
  {
    step: 'a failed advisory review cannot discard the build',
    verdict: has('server/src/lib/reviewFailOpen.js') && has('scripts/verify-build-gate-failopen.mjs') ? 'BUILT' : 'NOT BUILT',
    evidence: 'the review is a second opinion about code that already exists, but `reviewAndRetry` awaits invokeAI with no catch and the call site in chatWithMorpheus.js was unwrapped — while applyFileOperations does not run until ~300 lines later. A reviewer throw therefore reached the outer handler with appliedOps empty and took the plan, every coder chunk and the reply with it. invokeAI throws on a provider 5xx past undici\'s header timeout, on OUTPUT_TRUNCATED and on InsufficientCreditsError, so the loss needed no bug, only a slow reviewer. lib/reviewFailOpen.js now keeps the coder\'s operations on failure, reports the reason, and never fabricates a verdict; the reply says "NOT REVIEWED" and the usage row reports reviewed:false. Asserted as BEHAVIOUR (a throwing reviewer, a resolved-but-empty one, an invented pass) plus the ordering that made it fatal, by scripts/verify-build-gate-failopen.mjs. The self-dev deep verify is the same class and is deliberately still FAIL-CLOSED: an exception there is recorded as critical — so the push stays blocked and a self-dev step cannot advance — rather than being allowed to throw, and `deep` is never defaulted to a pass.',
  },
];

out.billing = [
  { step: '1  schema (usage_events, credit_transactions, model_catalog_entries; users.credit_balance/role)', verdict: 'BUILT', evidence: 'all three tables and all three columns exist in production' },
  { step: '2  real metering (tokens + cost per call)', verdict: /recordUsageEvent/.test(srcFile('server/src/ai.js')) ? 'BUILT' : 'NOT BUILT', evidence: 'ai.js recordUsageEvent captures real input/output tokens and computes cost_usd' },
  { step: '3  pre-call reserve + post-call reconcile', verdict: /reserveCredits\(userId/.test(srcFile('server/src/ai.js')) && has('server/src/lib/billing.js') ? 'BUILT' : 'NOT BUILT', evidence: 'ai.js reserves before the call (hard 402 block) and reconciles against real usage after' },
  { step: '4  admin-editable pricing', verdict: /modelCatalogEntry\.upsert/.test(srcFile('server/src/routes/admin.routes.js')) ? 'BUILT' : 'NOT BUILT', evidence: 'admin.routes.js lists and upserts ModelCatalogEntry — the catalog is simply empty, not unbuilt' },
  { step: '5  Priority Compile (paid)', verdict: /priorityCompile|compileMode/.test(srcFile('server/src/functions/compileProject.js')) ? 'BUILT' : 'NOT BUILT', evidence: 'genuinely absent — the one step the docs are right about' },
  { step: '5b Guided Free Setup (own Gemini key)', verdict: /guided/.test(srcFile('src/pages/Settings.jsx')) ? 'BUILT' : 'NOT BUILT', evidence: 'Settings.jsx renders a numbered AI Studio walkthrough + key field, not just a link' },
  { step: '6  token-block purchase + transparency', verdict: has('server/src/functions/createTokenCheckout.js') && has('src/components/matrix/CreditBalance.jsx') ? 'BUILT' : 'NOT BUILT', evidence: 'createTokenCheckout, CreditBalance, InsufficientCreditsModal, TOKEN_BLOCKS with grossed-up prices' },
  { step: '6b provider balance safeguard', verdict: has('server/src/lib/deepseekBalance.js') ? 'BUILT (adapted)' : 'NOT BUILT', evidence: 'monitor + alert + failover built; auto top-up deliberately NOT built — DeepSeek has no top-up API and moving money stays human' },
  // Derived, not written. This verdict was the literal string 'NOT BUILT' until 2026-09-28, with
  // evidence claiming "no end-to-end check that charges match recorded usage" — and #419 had built
  // exactly that. A hardcoded ABSENCE is the one claim that rots silently the moment the work lands,
  // because nothing recomputes it: the file went on telling every session to build a shipped pass.
  // scripts/verify-context.mjs now fails the build if any verdict in this file is a literal absence.
  { step: '7  billing verification pass', verdict: has('scripts/verify-billing-ledger.mjs') && has('scripts/verify-billing-ledger-math.mjs') ? 'BUILT' : 'NOT BUILT', evidence: 'verify-billing-ledger.mjs reconciles credits_charged against the pricing policy and balances against purchases, on production data (exit 1 names the drift, exit 2 is never a pass); its import-free maths half — lib/billingLedger.js — runs in the CI no-install job' },
  // Both derived, same rule as step 7. The paid AI default is the one part of the token system that
  // did NOT exist until 2026-09-29, however complete the rest of this list looked: the broker that
  // holds the upstream key had no account or credit concept at all, so "the paid default" was a name
  // for a shared token list. What is still owed is stated in the evidence, not as a verdict.
  {
    step: '8  the paid AI default is metered (broker gateway)',
    verdict: has('server/src/lib/cloudMetering.js') && has('scripts/verify-cloud-metering.mjs') && has('hosted-broker/src/metering.js') ? 'BUILT' : 'NOT BUILT',
    evidence: 'hosted-broker/ proxies AI for installs with no key of their own, so every brokered call spends the operator\'s upstream key. It now asks the INSTANCE before and after each call: verify debits the account\'s credits with the product\'s own atomic reserveCredits (a balance CHECK is not a reservation — two calls in flight both pass one), the reservation travels back as a signed 5-minute ticket so the broker cannot invent an amount, usage trues up against the real token counts and writes a UsageEvent, and refund returns a reservation when the call never reached the model. Flat-rated models keep their flat 1 credit instead of being re-priced per token, streaming is refused because a stream cannot be metered, and with no metering configured the gateway falls back to the old shared-token list — unset is never "allow all". Guarded by scripts/verify-cloud-metering.mjs. Still owed: the broker is NOT DEPLOYED (needs BROKER_AI_UPSTREAM_KEY and the instance\'s https address, i.e. Tailscale), so the out-of-the-box paid path still cannot complete a call; per-token revocation needs a stored token row, so a leaked token is bounded only by its 7-day expiry and the account balance.',
  },
  {
    step: '9  a gateway token belongs to an account, not a deployment',
    verdict: has('server/src/lib/brokerMinting.js') && has('scripts/verify-broker-minting.mjs') && /mintForAccount/.test(srcFile('server/src/ai.js')) ? 'BUILT' : 'NOT BUILT',
    evidence: 'a shared MORPHEUS_AI_GATEWAY_TOKEN identifies a DEPLOYMENT, so the gateway cannot tell whose balance to charge. With BROKER_GATEWAY_SIGNING_SECRET set, ai.js\'s tier 3 mints an mgw_ token FOR THE ACCOUNT making the call, from this server\'s own POST /api/broker/token, and caches it until shortly before expiry — so a user configures nothing and is still billed. That endpoint therefore accepts a caller that is not a user session, which is one conditional away from "anyone can mint a token for anybody"; the rule lives in lib/brokerMinting.js and is asserted as behaviour by scripts/verify-broker-minting.mjs (a session mints only for itself, the broker secret mints only for an account it names, nobody else gets anything). Still owed: a Settings surface so an operator can see and revoke the token their install is using.',
  },
];

// ── Portable Morpheus: the downloadable, self-hosted copy ────────────────────
// Rob, 2026-09-29: portable Morpheus is meant to be "an up to date, generated from current
// capabilities and code, downloadable version of morpheus that installs a local server on your mac or
// pc" — the whole product, builder AND Command Deck, on the operator's own machine.
//
// The verdict is DERIVED, per the rule this file now lives under: a literal absence rots the moment
// the work lands and nothing recomputes it — which is exactly how step 7 above came to claim a shipped
// pass was unbuilt. What is still MISSING is named in the evidence rather than as a verdict, because
// that is prose about the current state, not a claim nothing checks.
out.portable = [
  {
    step: 'bundle generated at build time from the current tree',
    verdict: has('scripts/build-portable-bundle.mjs') && has('server/src/lib/portableBundle.js')
      && /build-portable-bundle/.test(srcFile('package.json')) ? 'BUILT' : 'NOT BUILT',
    evidence: 'postbuild writes dist/portable-morpheus.zip from the tree being built, so it cannot describe an older codebase — the previous hand-run mirror shipped base44/ for a month after the port. It carries the whole product (src/ and server/src/, so the builder AND the Command Deck). Still NOT in it: a first-run wizard, remote access (Tailscale is decided, not built), and any AI provider configured by default.',
  },
  {
    step: 'one-command local setup (portable-setup.mjs)',
    verdict: has('scripts/portable-setup.mjs') && has('server/src/lib/portableSetup.js') && has('server/scripts/dev-db.mjs') ? 'BUILT' : 'NOT BUILT',
    evidence: 'generates the four secrets a downloader cannot invent (JWT_SECRET, ENCRYPTION_KEY, DATABASE_URL, BROKER_GATEWAY_SIGNING_SECRET — the last is this install\'s half of the Cloud gateway pair, so it can issue gateway tokens with nothing pasted in), then DELEGATES the database to server/scripts/dev-db.mjs — which drives real embedded-postgres binaries, because the library class stops Postgres when the process exits. The server now serves the built frontend from dist/ when it is present, so a local install is ONE process on one origin (no second static server, no CORS allowlist); on the hosted deployment there is no dist/ in the backend image, so that is a no-op. Guarded by scripts/verify-portable-setup.mjs, which also asserts the honest list of what is still missing.',
  },
  {
    step: 'remote access via the operator\'s own tailnet (portable-remote.mjs)',
    verdict: has('scripts/portable-remote.mjs') && has('server/src/lib/portableRemote.js') ? 'BUILT' : 'NOT BUILT',
    evidence: 'tailscale serve — NOT funnel, so the app is exposed to the operator\'s own tailnet rather than the internet — gated on the CLI reporting a running backend and a DNS name, and it sets BACKEND_PUBLIC_URL to that stable name. It deliberately does NOT install Tailscale or guess the CLI\'s syntax: that has changed across versions, so the installed CLI is asked to do the work and its own error is shown verbatim. Guarded by scripts/verify-portable-remote.mjs. This entry claimed the AI-source wizard was still owed for a day after it shipped (portable-ai.mjs, below) — the same stale-absence failure as step 7 in the billing list. Still genuinely owed: a native package.',
  },
  {
    step: 'explicit AI source for a local install (portable-ai.mjs)',
    verdict: has('scripts/portable-ai.mjs') && has('server/src/lib/portableAi.js') ? 'BUILT' : 'NOT BUILT',
    evidence: 'detects a locally hosted OpenAI-compatible server, reports which of the three tiers ai.js will actually take (account override, this deployment\'s env, Morpheus gateway — asserted against ai.js rather than copied), and writes only the four keys it owns. It refuses to write the inert broker placeholder, because that would configure nothing while looking configured: the paid default is DECIDED but the hosted-broker service is NOT DEPLOYED, so the out-of-the-box paid path does not work yet. It also warns when a local model id matches no LOCAL_MODEL_PATTERNS entry, because the ledger would then price a free call from the generic default — the gemini-3.5-flash-lite bug in another disguise. Guarded by scripts/verify-portable-ai.mjs. Still owed: deploy the broker, and a native package.',
  },
  {
    step: 'one command, and the same one, on macOS, Linux and Windows',
    verdict: has('server/src/lib/platformCli.js') && has('scripts/verify-portable-platform.mjs') ? 'BUILT' : 'NOT BUILT',
    evidence: 'the install path had two Windows-only failures that no Mac could reproduce, both of which fired SEVERAL STEPS IN after the user had been told things were going well: `spawnSync(\'npm\', ...)` (Node 20 refuses to spawn a .cmd without a shell, and npm on Windows IS npm.cmd) and `execFileSync(<...>/.bin/prisma, ...)` (that directory holds prisma.cmd beside a shebang-only prisma that is not executable). Both now go through lib/platformCli.js, which is pure and takes the platform as an argument, so scripts/verify-portable-platform.mjs exercises win32/linux/darwin argv on any host — the only way a Windows path gets tested here at all. One spawn mechanism, stated once: the Windows wrapper is `cmd.exe /c` in the argv and `shell` stays false everywhere, because passing both wraps the command twice and still works. Each platform also gets its prerequisites as DATA (the exact Node install, the toolchain Linux needs and Windows does not, the launcher caveat) printed by --check and by the closing summary, and printable for another platform with `--check --platform win32`. Guarded by scripts/verify-portable-platform.mjs (82 checks).',
  },
  {
    step: 'one double-click to start it (portable-start.mjs + generated launchers)',
    verdict: has('scripts/portable-start.mjs') && has('scripts/portable-stop.mjs') && has('server/src/lib/portableLaunch.js') ? 'BUILT' : 'NOT BUILT',
    evidence: 'a per-platform launcher (.command/.bat/.desktop) is GENERATED into the bundle at build time with an exec bit, so there is no committed copy to drift from the rule that describes it; each one only runs `npm run portable:start`. Starting is idempotent (an already-answering server just brings the browser to it), the browser opens only after /api/health answers — opening first is how a launcher shows someone a connection-refused page and calls it success — and stopping says plainly that it stops the DATABASE and reports whether the server is still up, because the server owns its own window. Guarded by scripts/verify-portable-launcher.mjs. What is genuinely absent: code signing and auto-update (macOS quarantines a downloaded .command; SmartScreen warns once).',
  },
];

// Pricing coverage — the revenue-integrity check. A production model missing
// from the static table silently bills at DEFAULT_PRICING, which nobody chose
// for it. This claim is what FOUND that: gemini-3.5-flash-lite was in exactly
// that state (99 calls billed from the default, ~609 credits charged against a
// $1.94 cost basis) and was given an explicit price plus a flat 1-credit rate on
// 2026-09-28. It holds at 4/4 today; keep the claim, it is the tripwire.
if (live?.modelsUsed) {
  const { MODEL_PRICING, DEFAULT_PRICING } = await import(join(SERVER, 'src/lib/costEstimate.js'));
  const unpriced = live.modelsUsed
    .filter((m) => !Object.prototype.hasOwnProperty.call(MODEL_PRICING, m.model_id))
    .map((m) => `${m.model_id} (${m.n} calls)`);
  claims.push({
    claim: 'Every model billed in production has an explicit price.',
    evidence: unpriced.length
      ? `no entry, so DEFAULT_PRICING {in ${DEFAULT_PRICING.input}, out ${DEFAULT_PRICING.output}} per 1M is used for BOTH cost and retail: ${unpriced.join(', ')}`
      : `all ${live.modelsUsed.length} production model(s) are in MODEL_PRICING`,
    verdict: unpriced.length ? 'FALSE — unpriced models are billed from a generic default' : 'HOLDS',
  });
}

console.log(JSON_OUT ? JSON.stringify(out, null, 2) : render(out, compileTargets));

if (prisma) await prisma.$disconnect();

function render(o, targets) {
  const L = [];
  const H = (s) => L.push('', s, '─'.repeat(s.length));
  const row = (k, v) => L.push(`  ${String(k).padEnd(30)} ${v}`);

  L.push('\nMORPHEUS — consolidated reality', `  generated ${o.generatedAt}`);

  H('Intent (curated — the thing everything below is measured against)');
  L.push(`  ${o.ethos.thesis}`);
  for (const p of o.ethos.principles) L.push(`   · ${p}`);

  H('Built (read from the code, never remembered)');
  const b = o.built || {};
  if (b.error) row('ERROR', b.error);
  else {
    row('server source files', b.server?.sourceFiles ?? '—');
    row('function handlers', b.server?.functionHandlers ?? '—');
    row('lib modules', b.server?.libModules ?? '—');
    row('data models', b.data?.models ?? '—');
    row('  of which Deck*', b.data?.deckModels ?? '—');
    row('Deck widgets', b.deck?.widgetCount ?? '—');
    row('frontend routes', b.frontend?.routes ?? '—');
    row('skills', Array.isArray(b.skills) ? b.skills.length : '—');
    row('compile targets', `${targets.length}  (${targets.join(', ')})`);
  }

  H('Live (queried from production)');
  if (!o.live || o.live.error) row('NOT VERIFIED', o.live?.error || 'unavailable');
  else {
    const l = o.live;
    row('accounts', `${l.users.n}   (${l.signups7d.n} in 7d, ${l.signups30d.n} in 30d)`);
    row('accounts that ever used AI', `${l.accountsUsingAi.n}   (${l.aiCalls.n} calls, ${l.aiCalls7d.n} in 7d)`);
    row('projects', l.projects.n);
    row('revenue', `$${(l.creditRevenue.usd + l.donationRevenue.usd).toFixed(2)}   (${l.creditRevenue.n} credit + ${l.donationRevenue.n} donation, all paid)`);
  }

  H('Deployed');
  if (!o.deployed || o.deployed.error) row('NOT VERIFIED', o.deployed?.error || 'unavailable');
  else {
    row('main (local)', o.deployed.repoMain);
    row('service', o.deployed.service);
    row('last build', `${o.deployed.build}  ${o.deployed.buildAt}`);
    row('deployment', `${o.deployed.deployment}  ${o.deployed.deploymentAt}`);
  }

  H('Claims vs the system');
  for (const c of o.claims) {
    L.push(`  ${c.verdict}`);
    L.push(`    claimed : ${c.claim}`);
    L.push(`    system  : ${c.evidence}`);
  }

  H('Build-loop resilience (a check that cannot run must not cost the build)');
  for (const b of o.buildResilience || []) {
    L.push(`  ${String(b.verdict).padEnd(16)} ${b.step}`);
    L.push(`                   ${b.evidence}`);
  }

  H('Token / billing system (the docs say none of it is built)');
  for (const b of o.billing || []) {
    L.push(`  ${String(b.verdict).padEnd(16)} ${b.step}`);
    L.push(`                   ${b.evidence}`);
  }

  H('Roadmap items the docs call unverified');
  for (const r of o.roadmap || []) {
    L.push(`  ${String(r.verdict).padEnd(14)} ${r.item}`);
    L.push(`                 ${r.evidence}`);
  }

  H('Portable Morpheus (downloadable, self-hosted)');
  for (const p of o.portable || []) {
    L.push(`  ${String(p.verdict).padEnd(16)} ${p.step}`);
    L.push(`                   ${p.evidence}`);
  }

  L.push('', '  Regenerate any time. If this disagrees with a document, the document is', '  wrong — that is the whole point of it.', '');
  return L.join('\n');
}
