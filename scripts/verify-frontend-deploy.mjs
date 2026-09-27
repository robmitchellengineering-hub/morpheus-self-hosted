// Runtime verification that "Take it live" deploys into the CUSTOMER'S OWN hosting
// connection — and that it cannot quietly do anything else.
//
// Dependency-free apart from one pure in-repo module (server/src/lib/frontendDeploy.js,
// which imports nothing), so it runs in CI's no-install guards job. The pure module is
// exercised for real, not grepped for strings: the stale-artifact rule and the
// backend-ready rule are decisions, and a guard that only read the handler's source
// would pass on a handler that named the right words and did the wrong thing.
//
// Run:  node scripts/verify-frontend-deploy.mjs
//
// The behaviour this pins, and why each half is a real regression rather than a style
// preference (2026-09-28):
//
//   * The owner's ethos — "it's always the customer's connection — we are just
//     facilitating and aggregating and synthesizing data." A platform fallback token,
//     or a Morpheus-owned Netlify account, would break that promise silently: the app
//     would still work, and the site would be ours.
//   * Owner scoping with a 404, not a 403 — checkDeployHealth.js was fixed for exactly
//     this the same day, and a project id that is not yours must not be distinguishable
//     from one that does not exist.
//   * The deploy must never carry `backend/` files. Every existing backend deployer
//     filters to `path.startsWith('backend/')`, which is why this frontend path had no
//     home; it must be the mirror image, not a second copy of that filter.
//   * The record must be written, or "live at <url>" cannot be shown and a re-deploy
//     cannot land on the same site.
import { readFileSync } from 'node:fs';
import {
  FRONTEND_DEPLOY_PATH,
  pickArtifact,
  isFrontendSourcePath,
  isArtifactStale,
  newestFrontendSourceTime,
  hasBackendSource,
  backendIsLive,
} from '../server/src/lib/frontendDeploy.js';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const fn = read('server/src/functions/deployFrontend.js');
const routes = read('server/src/routes/functions.routes.js');
const ui = read('src/components/matrix/CompilePanel.jsx');

// ═══ 1. the decisions, exercised ════════════════════════════════════════════
console.log('\n1. which artifact gets published');
const BACKEND_ROW = { path: 'backend/src/index.js', created_date: '2026-09-01T00:00:00Z', updated_date: '2026-09-01T00:00:00Z' };
const OLD_ZIP = { path: '_compiled/web-app.zip', created_date: '2026-09-02T00:00:00Z', updated_date: '2026-09-02T00:00:00Z' };
const NEW_ZIP = { path: '_compiled/web-app.zip', created_date: '2026-09-05T00:00:00Z', updated_date: '2026-09-05T00:00:00Z' };
const OTHER_ZIP = { path: '_compiled/release.zip', created_date: '2026-09-04T00:00:00Z', updated_date: '2026-09-04T00:00:00Z' };

check('nothing compiled yet is null (that is the honest error)',
  pickArtifact([BACKEND_ROW], 'web-app.zip'), null);
check('a non-zip artifact is not a web app',
  pickArtifact([{ path: '_compiled/app.apk', created_date: '2026-09-05T00:00:00Z' }], 'web-app.zip'), null);
check('the newest compiled web-app ZIP wins, never list order',
  pickArtifact([NEW_ZIP, OLD_ZIP, OTHER_ZIP], 'web-app.zip')?.created_date, '2026-09-05T00:00:00Z');
check('a backend row can never be chosen as the artifact',
  pickArtifact([BACKEND_ROW, OLD_ZIP], 'web-app.zip')?.path, '_compiled/web-app.zip');
check('the adapter\'s own artifact name is preferred',
  pickArtifact([{ path: '_compiled/other-app.zip', created_date: '2026-09-09T00:00:00Z' }, OLD_ZIP], 'web-app.zip')?.path, '_compiled/web-app.zip');
check('a renamed artifact still deploys instead of reading as "nothing compiled"',
  pickArtifact([{ path: '_compiled/site-bundle.zip', created_date: '2026-09-03T00:00:00Z' }], 'web-app.zip')?.path, '_compiled/site-bundle.zip');

console.log('\n2. what counts as SOURCE for the staleness check');
check('a source file counts', isFrontendSourcePath('src/App.jsx'), true);
check('the compiled artifact does not', isFrontendSourcePath('_compiled/web-app.zip'), false);
check('backend source does not (it does not rebuild the frontend)', isFrontendSourcePath('backend/src/index.js'), false);
// The regression that would otherwise refuse EVERY re-deploy: the deploy writes its
// own record, which is then newer than the artifact it records.
check('the deploy record it writes does not',
  isFrontendSourcePath(FRONTEND_DEPLOY_PATH), false);
check('the backend deploy record does not', isFrontendSourcePath('backend/.deploy.json'), false);
check('the planner note does not', isFrontendSourcePath('backend/.plan.json'), false);
check('answers yes for a non-code asset too', isFrontendSourcePath('public/logo.svg'), true);
check('the record path is the frontend one, mirroring backend/.deploy.json',
  FRONTEND_DEPLOY_PATH, 'frontend/.deploy.json');

console.log('\n3. the stale-artifact rule');
const built = { created_date: '2026-09-02T00:00:00Z', updated_date: '2026-09-02T00:00:00Z' };
check('an edit after the build is stale',
  isArtifactStale(built, [built, { path: 'src/App.jsx', updated_date: '2026-09-03T00:00:00Z' }]), true);
check('a build after the last edit is not',
  isArtifactStale(built, [built, { path: 'src/App.jsx', updated_date: '2026-09-01T00:00:00Z' }]), false);
check('a newer deploy record alone does NOT make it stale',
  isArtifactStale(built, [built, { path: FRONTEND_DEPLOY_PATH, updated_date: '2026-09-09T00:00:00Z' }]), false);
check('a newer backend edit alone does NOT make it stale',
  isArtifactStale(built, [built, { path: 'backend/src/index.js', updated_date: '2026-09-09T00:00:00Z' }]), false);
check('a newer compiled artifact does not count as source',
  isArtifactStale(built, [built, { path: '_compiled/release.zip', updated_date: '2026-09-09T00:00:00Z' }]), false);
check('an unreadable build time does not block a correct deploy',
  isArtifactStale({ path: '_compiled/web-app.zip' }, [{ path: 'src/App.jsx', updated_date: '2026-09-09T00:00:00Z' }]), false);
check('newest source time ignores excluded paths',
  newestFrontendSourceTime([{ path: 'backend/x.js', updated_date: '2026-09-09T00:00:00Z' }, { path: 'src/a.js', updated_date: '2026-09-02T00:00:00Z' }]),
  Date.parse('2026-09-02T00:00:00Z'));

console.log('\n4. the backend-not-deployed rule');
check('a real backend source file needs a backend', hasBackendSource([{ path: 'backend/src/index.js' }]), true);
check('…as does a backend SQL migration', hasBackendSource([{ path: 'backend/migrations/001.sql' }]), true);
check('the planner note alone does not', hasBackendSource([{ path: 'backend/.plan.json' }]), false);
check('the deploy record alone does not', hasBackendSource([{ path: 'backend/.deploy.json' }]), false);
check('a frontend-only construct does not', hasBackendSource([{ path: 'src/App.jsx' }, { path: '_compiled/web-app.zip' }]), false);
check('a deployed backend reads as live',
  backendIsLive(JSON.stringify({ results: [{ component: 'api_host', status: 'deployed', url: 'https://api.example.com' }] })), true);
check('an errored backend does not',
  backendIsLive(JSON.stringify({ results: [{ component: 'api_host', status: 'error', message: 'nope' }] })), false);
check('a malformed stored blob is not a throw',
  backendIsLive('{not json'), false);
check('no record at all is not live', backendIsLive(null), false);

// ═══ 5. the handler ═════════════════════════════════════════════════════════
console.log('\n5. it requires a session, and it is NOT public');
check('deployFrontend is not in PUBLIC_FUNCTIONS',
  /PUBLIC_FUNCTIONS = new Set\(\[[^\]]*'deployFrontend'/.test(routes), false);
check('…and the list still exists, so this is a removal and not a rename of the check',
  /const PUBLIC_FUNCTIONS = new Set\(\[/.test(routes), true);
check('the handler takes the authenticated user', /export default async function handler\(\{ user, body \}\)/.test(fn), true);
check('a missing user is a 401', /if \(!user\?\.id\)[\s\S]{0,120}?status: 401/.test(fn), true);

console.log('\n6. every lookup is scoped to the caller, and a stranger gets a 404');
check('the project is resolved with an owner filter',
  /prisma\.project\.findFirst\(\{\s*where: \{ id: projectId, created_by_id: user\.id \}/.test(fn), true);
check('a project that is not yours is a 404, not a distinguishable 403',
  /if \(!project\) \{[\s\S]{0,140}?status: 404/.test(fn), true);
check('project files are read with an owner filter',
  /prisma\.projectFile\.findMany\(\{\s*where: \{ project_id: projectId, created_by_id: user\.id \}/.test(fn), true);
check('the backend config is read with an owner filter',
  /prisma\.backendConfig\.findFirst\(\{\s*where: \{ project_id: projectId, created_by_id: user\.id \}/.test(fn), true);

console.log('\n7. the token is the customer\'s own, with NO fallback of ours');
check('it is read from the caller\'s own connections row',
  /prisma\.userSettings\.findUnique\(\{ where: \{ created_by_id: user\.id \} \}\)/.test(fn), true);
check('…at the netlify.token key',
  /userConnections\.netlify\?\.token/.test(fn), true);
check('nothing else can supply a token (no platform/env fallback)',
  (fn.match(/netlify\?\.token/g) || []).length, 1);
check('no NETLIFY env credential is read anywhere in the file',
  /process\.env\.NETLIFY/.test(fn), false);
check('not connected is its own plain error, and it stops there',
  /code: 'NO_NETLIFY_TOKEN'/.test(fn), true);

console.log('\n8. the artifact comes from storage, never the public internet');
check('bytes come from the storage helper that wrote them',
  /downloadFile\(artifact\.file_url\)/.test(fn), true);
check('the artifact URL is never fetched over the internet',
  /fetch\(\s*artifact\.file_url/.test(fn) || /fetch\(\s*file_url/.test(fn), false);
check('"nothing compiled yet" is checked BEFORE Netlify is called',
  fn.indexOf("code: 'NO_ARTIFACT'") < fn.indexOf('await createSite('), true);
check('a stale artifact is a named error',
  /code: 'ARTIFACT_STALE'/.test(fn), true);

console.log('\n9. the deploy is the FRONTEND zip and never backend/ source');
check('the request body is the compiled ZIP', /body: zip/.test(fn), true);
check('no backend file is reconstructed for the deploy',
  /replace\('backend\/'/.test(fn), false);
check('no backend-prefixed file is selected as deployable',
  /backendFiles/.test(fn), false);
check('only a `backend/` readiness READ is present, not a deploy of it',
  /f\.path === 'backend\/\.deploy\.json'/.test(fn), true);

console.log('\n10. the Netlify request shape matches the proven deployer');
check('the ZIP is POSTed to the site\'s deploys endpoint',
  /`\$\{NETLIFY_API\}\/sites\/\$\{siteId\}\/deploys`/.test(fn), true);
check('…as application/zip (portable-architect/server/deployers.js)',
  /'Content-Type': 'application\/zip'/.test(fn), true);
check('…with the caller\'s bearer token',
  /Authorization: `Bearer \$\{token\}`/.test(fn), true);
check('a refusal from Netlify is named, with its own status and text',
  /code: 'NETLIFY_REJECTED'/.test(fn), true);

console.log('\n11. the site is created once, then reused');
check('the prior deploy record is read back',
  /files\.find\(\(f\) => f\.path === FRONTEND_DEPLOY_PATH\)/.test(fn), true);
check('its site id is reused',
  /prior\?\.site_id/.test(fn), true);
check('a site is created only on a first deploy',
  /if \(firstDeploy\)/.test(fn), true);
check('…through Netlify\'s sites API',
  /`\$\{NETLIFY_API\}\/sites`/.test(fn), true);

console.log('\n12. the record is written, and the URL it enables is returned');
check('the record is a project file at the frontend path',
  /prisma\.projectFile\.create\(\{/.test(fn) && /path: FRONTEND_DEPLOY_PATH/.test(fn), true);
check('an existing record is updated in place, not duplicated',
  /prisma\.projectFile\.update\(\{ where: \{ id: priorFile\.id \}/.test(fn), true);
check('the record carries the site id, the url and the artifact',
  /site_id: siteId/.test(fn) && /provider: 'netlify'/.test(fn) && /artifact: artifact\.path/.test(fn), true);
check('it returns the live URL and a status',
  /status: 'deployed'/.test(fn) && /return \{[\s\S]{0,220}?url,/.test(fn), true);
check('the backend-not-deployed case is named so the UI can point at the backend deploy',
  /code: 'BACKEND_NOT_DEPLOYED'/.test(fn), true);

// ═══ 13. it reaches the screen ══════════════════════════════════════════════
console.log('\n13. the action and its outcome reach the screen');
check('the panel calls deployFrontend', /base44\.functions\.invoke\('deployFrontend'/.test(ui), true);
check('the action is offered for a web-app build only', /\{target === 'web-app' && \(/.test(ui), true);
check('the returned URL is rendered as a tappable link', /href=\{live\.url\}/.test(ui), true);
check('…and can be copied', /navigator\.clipboard\.writeText\(live\.url\)/.test(ui), true);
check('a re-deploy action is offered after success', /RE-DEPLOY/.test(ui), true);
check('the server\'s specific reason is shown, not a generic failure',
  /e\?\.data\?\.error/.test(ui), true);
check('the backend-not-deployed case points at the backend deploy',
  /live\.code === 'BACKEND_NOT_DEPLOYED'/.test(ui) && /onBuildBackend/.test(ui), true);

console.log('\n14. while it runs, it is obvious and the control is disabled');
check('the pending state disables the control', /disabled=\{liveBusy\}/.test(ui), true);
check('…and a sentence says why, so a greyed control is not a dead one',
  /Publishing — wait for it to finish/.test(ui), true);
check('a same-tick second press is refused by a ref (state cannot see it yet)',
  /if \(liveInFlight\.current\) return;/.test(ui), true);

// ═══ 15. the guard itself is wired into the one gate and into CI ════════════
console.log('\n15. this check runs where it is supposed to');
check('it is in verify.mjs\'s HARD list',
  /'verify-frontend-deploy\.mjs'/.test(read('scripts/verify.mjs')), true);
check('CI runs it in the guards job (no install)',
  /node scripts\/verify-frontend-deploy\.mjs/.test(read('.github/workflows/ci.yml')), true);

console.log('\n7. the token is read through the helper, not parsed raw');
// Added 2026-09-28 in review, and it is the check that would have caught a real defect: this file
// originally did `JSON.parse(settingsRow.connections)`. #397 then made that column encrypted at
// rest, so the parse threw on every freshly-saved token and a local `catch` reported "Netlify is
// not connected" for a token the user had just saved — with no gate able to see it, because it is a
// runtime read and the catch was silent. Cross-branch drift is exactly what a stale branch hides.
const fnCode = read('server/src/functions/deployFrontend.js')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^[ \t]*\/\/.*$/gm, ' ');
check('it imports the encryption-aware decoder',
  /import \{ decodeConnections \} from '\.\.\/lib\/connectionSecrets\.js';/.test(fnCode), true);
check('it calls it for the token lookup',
  /const userConnections = decodeConnections\(settingsRow\?\.connections\);/.test(fnCode), true);
check('it does NOT parse the connections column itself',
  /JSON\.parse\([^)]*connections/.test(fnCode), false);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('all good\n');
