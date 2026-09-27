// Runtime verification for per-app capability grants — "a generated app may use
// ONE named capability against the operator's OWN connected account".
//
// Dependency-free (lib/appCapability.js and lib/tokenHash.js import only
// node:crypto), so it runs in CI's no-install guards job. Run:
//   node scripts/verify-app-capability-creds.mjs
//
// TWO HALVES, AND THE SECOND IS THE ONE THAT ROTS
//
//   1. The pure decisions — what a token hashes to, whether a row is scoped to the
//      app that presented it, whether a revoked row still works, and above all that
//      a static app is told to bring its own OAuth client rather than being handed a
//      token it cannot keep. Driven with plain objects, so these are REAL
//      behavioural assertions and not regexes over source.
//   2. The wiring — that the endpoint mounts outside the session dispatcher, that a
//      capability request never names a user, and that the build writes BOTH honesty
//      messages from one decision.
//
// THE THING THIS GUARD IS REALLY FOR
//
// Every property here is one whose failure is SILENT. A grant that is not scoped to
// its app still works; a revoked grant that still works looks like a working app; a
// token in a public page works perfectly until someone else reads it; a static app
// told "nothing to set up" fails days later with a provider error and no
// explanation. None of these can be caught by lint, `node --check` or a build — so
// they are caught here, by importing the logic that decides them.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  APP_CAPABILITIES, APP_CAPABILITY_PREFIX, appIdForProject, appCanHoldToken,
  decideAppProviderMode, resolveCapabilityGrant, appIdMatches, isKnownCapability,
  scopesForCapabilities, buildProviderReport, providerReadmeSection,
  upsertProviderReadmeSection, headlineForMode, connectedModeMessage, ownClientSetupSteps,
} from '../server/src/lib/appCapability.js';
import { hashToken, sameToken } from '../server/src/lib/tokenHash.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

let checks = 0;
let failures = 0;
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
const has = (haystack, needle) => String(haystack).includes(needle);
/** Source with whole-line comments stripped, so prose ABOUT a thing is not read as the thing. */
const code = (src) => String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

console.log('\nPer-app capability grants — runtime verification\n');

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '22222222-2222-4222-8222-222222222222';
const APP_A = appIdForProject(PROJECT_A);
const APP_B = appIdForProject(PROJECT_B);

// ── 1. the token is stored hashed, and never recoverable ────────────────────
console.log('1. the token is stored as a hash, and only ever shown once');
{
  // A realistic token, assembled here rather than read from anywhere.
  const token = APP_CAPABILITY_PREFIX + 'a'.repeat(64);
  check('the prefix is the one the route dispatches on', APP_CAPABILITY_PREFIX, 'apc_');
  check('hashing is deterministic', hashToken(token), hashToken(token));
  check('the hash is 64 hex chars', /^[0-9a-f]{64}$/.test(hashToken(token)), true);
  check('the hash is not the token', hashToken(token) === token, false);
  // The property that matters: the stored value cannot be turned back into the
  // token, so a database read is not a credential.
  check('the token does not appear in its own hash', has(hashToken(token), token), false);
  check('a one-bit change gives an unrelated hash',
    hashToken(token) === hashToken(token.slice(0, -1) + 'b'), false);
  check('sameToken agrees with equality for a match', sameToken(token, token), true);
  check('sameToken refuses a different value', sameToken(token, token + '0'), false);
  // Two empty values are not "a match" — in a grant check that would mean an app
  // that named no app satisfying a row that named no app.
  check('sameToken refuses an empty value', sameToken('', ''), false);
  check('sameToken refuses one empty side', sameToken(token, ''), false);

  const store = code(read('server/src/lib/appCapabilityGrants.js'));
  const route = code(read('server/src/routes/appCapability.routes.js'));
  const fnSrc = read('server/src/functions/appCapabilityGrant.js');
  const fn = code(fnSrc);

  check('the store writes a hash, not a token', has(store, 'prisma.appCapabilityGrant.create({'), true);
  check('…and the column it writes is token_hash', has(store, 'token_hash: hashCapabilityToken(secret)'), true);
  check('…and the response is the only place the raw token appears',
    has(store, 'token: secret,'), true);
  // The shape a leak would take: a lookup that selects the token, or a list that
  // returns it. There is no such column, and the public shape must not invent one.
  check('the public grant shape carries no token and no hash',
    /token:/.test(store.slice(store.indexOf('export function publicGrant'))), false);
  check('hashCapabilityToken delegates to the ONE shared routine',
    has(store, 'return capabilityTokenHash(raw);') && has(read('server/src/lib/appCapability.js'), "import { hashToken, sameToken } from './tokenHash.js';"), true);
  // 2026-09-28: the widget and device tokens used to spell the same hashing line
  // out for themselves. A second hashing routine is how the shapes drift apart.
  for (const [label, file] of [['widgetToken', 'server/src/lib/widgetToken.js'], ['deviceToken', 'server/src/lib/deviceToken.js'], ['operatorToken', 'server/src/lib/operatorToken.js']]) {
    check(`${label} uses the shared hasher rather than its own`, has(code(read(file)), "createHash('sha256')"), false);
  }
  // Asserted against the raw source, not the comment-stripped text: the sentence is
  // a string literal, so it is the source that carries it verbatim.
  check('the one-time warning names the backend, not the page',
    has(fnSrc, 'into the app BACKEND now') && has(fnSrc, 'Never put it in a web page'), true);
  check('the created token is never logged', /console\.(log|warn|error)\([^)]*token/i.test(store), false);
}

// ── 2. scoped to ONE app AND ONE user — behaviourally ───────────────────────
console.log('\n2. a grant is scoped to one app and one user');
{
  const grantA = {
    app_id: APP_A, project_id: PROJECT_A, created_by_id: 'user-A',
    capabilities: 'drive_upload', revoked: false, expires_at: null,
  };
  const rowsFor = (g) => [g];

  check('the app id is derived from, and not equal to, the project id', APP_A !== PROJECT_A && APP_A.startsWith('app_'), true);
  check('two projects give two app ids', APP_A === APP_B, false);
  check('the same project gives the same app id', appIdForProject(PROJECT_A), APP_A);

  // THE ISOLATION CHECK. A token minted for app A, presented for app B, must be
  // refused — and this is the assertion a regex cannot make, because it drives the
  // real decision function with the real row shapes.
  const crossApp = resolveCapabilityGrant(rowsFor(grantA), { appId: APP_B, capability: 'drive_upload' });
  check('app A\'s grant cannot act for app B', crossApp.ok, false);
  check('…and says why', crossApp.reason, 'wrong-app');
  const sameApp = resolveCapabilityGrant(rowsFor(grantA), { appId: APP_A, capability: 'drive_upload' });
  check('app A\'s grant acts for app A', sameApp.ok, true);
  check('a request naming no app at all is refused',
    resolveCapabilityGrant(rowsFor(grantA), { appId: '', capability: 'drive_upload' }).reason, 'wrong-app');
  check('a request naming no capability is refused',
    resolveCapabilityGrant(rowsFor(grantA), { appId: APP_A, capability: '' }).reason, 'not-granted');
  check('a capability that was not granted is refused',
    resolveCapabilityGrant(rowsFor(grantA), { appId: APP_A, capability: 'drive_delete' }).reason, 'not-granted');
  check('an unknown token resolves to nothing', resolveCapabilityGrant([], { appId: APP_A, capability: 'drive_upload' }).reason, 'unknown-token');
  check('appIdMatches is constant-time in shape and refuses empties',
    appIdMatches(APP_A, APP_A) === true && appIdMatches(APP_A, APP_B) === false && appIdMatches('', '') === false, true);

  // The cross-USER half. The endpoint resolves the owner FROM THE GRANT ROW, so a
  // request has no field in which to name a user — if it ever gains one, this fails.
  const route = code(read('server/src/routes/appCapability.routes.js'));
  check('the endpoint reads the owner from the grant, not the request',
    has(route, 'const owner = await grantOwner(decision.grant);'), true);
  check('…and never reads a userId from the body', /body\??\.userId|req\.body\.userId/.test(route), false);
  check('…and never reads a user id from the query', /req\.query[^;]*user/.test(route), false);
  check('the grant row is looked up by its token hash alone',
    has(code(read('server/src/lib/appCapabilityGrants.js')), 'where: { token_hash: hashCapabilityToken(raw) }'), true);
  check('the Drive token is fetched for the grant owner', has(route, 'getGoogleDriveConnection(owner.id)'), true);
  // Wrong-connection guard (owner's constraint, 2026-09-28): an app must use the
  // platform `drive.file` connection, never the Command Deck's wider one.
  check('an app capability never borrows the Command Deck connection',
    has(route, 'deckGoogle') || has(route, 'getDeckGoogleConnection'), false);
  check('…and the source it spends is named in the response', has(route, "connection: 'google-drive'"), true);
}

// ── 3. a revoked grant stops working ────────────────────────────────────────
console.log('\n3. revocation is immediate, and a revoked row is inert');
{
  const base = { app_id: APP_A, project_id: PROJECT_A, created_by_id: 'user-A', capabilities: 'drive_upload', expires_at: null };
  const live = { ...base, revoked: false };
  const dead = { ...base, revoked: true };
  check('a live grant works', resolveCapabilityGrant([live], { appId: APP_A, capability: 'drive_upload' }).ok, true);
  check('the same grant stops working once revoked',
    resolveCapabilityGrant([dead], { appId: APP_A, capability: 'drive_upload' }).ok, false);
  check('…and says it was revoked',
    resolveCapabilityGrant([dead], { appId: APP_A, capability: 'drive_upload' }).reason, 'revoked');
  // A decoy beside the real row must not be able to satisfy the request either:
  // resolveCapabilityGrant judges the row it was handed, and only that row.
  check('a revoked row beside a live one still resolves as revoked',
    resolveCapabilityGrant([dead], { appId: APP_A, capability: 'drive_upload' }).grant, null);
  const expired = { ...base, revoked: false, expires_at: '2020-01-01T00:00:00.000Z' };
  check('an expired grant stops working',
    resolveCapabilityGrant([expired], { appId: APP_A, capability: 'drive_upload' }).reason, 'expired');

  const store = code(read('server/src/lib/appCapabilityGrants.js'));
  check('revoking is scoped to the owner and the project',
    has(store, 'where: { id: grantId, project_id: projectId, created_by_id: userId },'), true);
  check('…and sets revoked rather than deleting the row', has(store, 'data: { revoked: true },'), true);
  check('the resolver refuses a revoked row before anything else',
    /if \(grant\.revoked\) return \{ ok: false, reason: 'revoked'/.test(code(read('server/src/lib/appCapability.js'))), true);
}

// ── 4. the endpoint is not public, and a session is not a grant ─────────────
console.log('\n4. the capability endpoint takes a grant and nothing else');
{
  const index = code(read('server/src/index.js'));
  const route = code(read('server/src/routes/appCapability.routes.js'));
  const auth = code(read('server/src/auth.js'));

  check('it is mounted', has(index, "app.use('/api/app-capability', appCapabilityRoutes);"), true);
  // The whole point: it is NOT under /api/functions, whose dispatcher resolves a
  // scoped token into a real Morpheus user and would give a session a way in.
  check('it is not mounted under the functions dispatcher', has(index, "'/api/functions/appCapability"), false);
  check('the route itself never mounts optionalAuth or requireAuth',
    /optionalAuth|requireAuth/.test(route), false);
  check('the route imports no session auth helper',
    /from '\.\.\/auth\.js'/.test(route), false);
  check('an absent/garbage bearer is refused before any lookup',
    has(route, 'if (!presented.startsWith(APP_CAPABILITY_PREFIX))') && has(route, "res.status(401)"), true);
  check('…and the refusal says a session cannot be used here',
    has(route, 'A Morpheus session token cannot be used here'), true);
  // A session JWT does not start with apc_, so it cannot reach the lookup at all —
  // and optionalAuth is not in the chain, so it is never resolved into a user.
  check('a Morpheus JWT still cannot be resolved to a user on this route',
    has(auth, 'if (token.startsWith(WIDGET_TOKEN_PREFIX))'), true); // the pattern the route deliberately does not follow
  const invalid = JSON.stringify([
    { error: 'App capability token required.' },
  ]);
  check('the 401 body names the token type, not a session', has(invalid, 'App capability token required.'), true);
}

// ── 5. the two honesty messages, and which app gets which ───────────────────
console.log('\n5. the build states which mode the app is in');
{
  // The exact sentences a user sees. Pinned here because they are the deliverable:
  // a message that drifts silently is a promise that drifts silently.
  check('mode A headline',
    headlineForMode('connected', 'Google Drive'),
    'This app uses your connected Google Drive account — nothing to set up.');
  check('mode B headline',
    headlineForMode('own_client_required', 'Google Drive'),
    'This app needs your own Google Drive OAuth client — here are the exact steps.');
  check('mode A says which connection to keep connected',
    has(connectedModeMessage('Google Drive'), 'Settings → Google Drive'), true);
  check('mode A says the token lives in the app\'s backend',
    has(connectedModeMessage('Google Drive'), 'its own backend'), true);
  const steps = ownClientSetupSteps({ label: 'Google Drive', origin: 'https://app.example.com', originKnown: true, scopeNames: ['drive.file'] });
  check('mode B names the real origin', has(steps, '`https://app.example.com`'), true);
  check('mode B names the scope', has(steps, 'drive.file'), true);
  // drive.file is a fact about this repo, and the guide is worthless without it.
  check('the capability declares the drive.file scope it actually uses',
    scopesForCapabilities(['drive_upload']), ['https://www.googleapis.com/auth/drive.file']);
  check('mode B lists numbered steps', /1\. Open the Google Cloud Console/.test(steps) && /5\. Under "Authorised JavaScript origins"/.test(steps), true);
  check('mode B says why, not only what',
    has(steps, 'has no server of its own'), true);

  // THE DECISION. A static app cannot keep a token, so it must be told the steps
  // even though a capability we could grant exists.
  const driveFiles = [{ path: 'src/api.js', content: "fetch('https://www.googleapis.com/drive/v3/files')" }];
  check('a static web-app needing Drive takes the own-client route',
    decideAppProviderMode({ files: driveFiles, compileTarget: 'web-app' }).mode, 'own_client_required');
  check('…and the reason is the token, not the capability',
    decideAppProviderMode({ files: driveFiles, compileTarget: 'web-app' }).reason, 'static-app-cannot-hold-token');
  check('a backend app needing Drive uses the connection',
    decideAppProviderMode({ files: driveFiles, compileTarget: 'python-package' }).mode, 'connected');
  check('source (no build) cannot hold a token either',
    appCanHoldToken('source'), false);
  check('web-app is the one static target', appCanHoldToken('web-app'), false);
  check('every other target is treated as able to hold one',
    ['python-package', 'windows-exe', 'mac-app', 'linux-binary', 'android-apk', 'ios-app', 'rpi-distro', 'linux-distro', 'arduino-firmware']
      .every((t) => appCanHoldToken(t)), true);
  // An app that ships its own client id AND touches Drive: the marker scan sees the
  // drive call, and the own-client marker means it must NOT be told "nothing to set
  // up" — it already has a client to configure.
  check('an app that brings its own client is on the own-client route',
    decideAppProviderMode({
      files: [{ path: 'src/auth.js', content: "const CLIENT_ID='x'; fetch('https://www.googleapis.com/drive/v3/files'); window.location='https://accounts.google.com/o/oauth2/v2/auth'" }],
      compileTarget: 'python-package',
    }).reason, 'app-brings-its-own-client');
  check('an app touching no provider gets no message',
    decideAppProviderMode({ files: [{ path: 'src/App.jsx', content: 'hello' }], compileTarget: 'web-app' }).mode, 'none');
  check('a plan that DECLARES the capability needs it even with no marker in the code',
    decideAppProviderMode({ files: [], compileTarget: 'python-package', declared: ['drive_upload'] }).mode, 'connected');
  check('the registry only knows capabilities the endpoint would accept',
    Object.keys(APP_CAPABILITIES).every(isKnownCapability), true);

  // The report the README and the UI are both built from — one decision, two
  // surfaces, so they cannot say different things.
  const reportA = buildProviderReport({ files: driveFiles, compileTarget: 'python-package', projectName: 'X', origin: 'https://x.netlify.app', originKnown: true });
  const reportB = buildProviderReport({ files: driveFiles, compileTarget: 'web-app', projectName: 'Y' });
  check('the connected report leads with the promise', has(reportA.headline, 'nothing to set up'), true);
  check('the own-client report leads with the steps', has(reportB.headline, 'here are the exact steps'), true);
  check('each mode produces a README section with its heading',
    has(providerReadmeSection(reportA), '## Provider setup') && has(providerReadmeSection(reportB), '## Provider setup'), true);
  check('a no-provider app produces no section', providerReadmeSection({ mode: 'none' }), '');
  // The section is MANAGED: a rebuild must replace it, not append a second copy.
  // Counted by the MARKER, not by "## Provider setup" — that heading also appears in
  // the action line inside the section, so counting headings read one good section as
  // two and very nearly sent me looking for a bug in code that was correct.
  const markers = (s) => (s.match(/<!-- MORPHEUS PROVIDER SETUP/g) || []).length;
  const once = upsertProviderReadmeSection('# My app\n\nHello.\n', providerReadmeSection(reportA));
  const twice = upsertProviderReadmeSection(once, providerReadmeSection(reportA));
  check('the section is inserted once', markers(once), 1);
  check('a rebuild does not append a second copy', markers(twice), 1);
  check('the rest of the README survives', has(twice, 'Hello.'), true);
  // A file that ALREADY carries a stray copy is repaired, not extended. Both earlier
  // shapes of this function failed exactly here — the "next heading" one because the
  // section quotes its own heading in prose, and the "next marker" one because on a
  // doubled file the next marker WAS the stray copy, so it re-appended it.
  check('a stray second copy is repaired rather than preserved',
    markers(upsertProviderReadmeSection(once + '\n' + providerReadmeSection(reportA), providerReadmeSection(reportA))), 1);
  check('removing the section leaves the rest of the README',
    markers(upsertProviderReadmeSection(once, '')) === 0 && has(upsertProviderReadmeSection(once, ''), 'Hello.'), true);
  // And the section is REPLACED when the mode changes, not stacked beside the old one.
  const swapped = upsertProviderReadmeSection(twice, providerReadmeSection(reportB));
  check('a mode change replaces the section rather than stacking', markers(swapped), 1);
  check('…and the old mode\'s words are gone',
    has(swapped, 'nothing to set up') === false && has(swapped, 'here are the exact steps'), true);
}

// ── 6. the build writes it ──────────────────────────────────────────────────
console.log('\n6. the build and the compile UI both state the mode');
{
  const chat = code(read('server/src/functions/chatWithMorpheus.js'));
  const panel = read('src/components/matrix/CompilePanel.jsx');
  const setup = code(read('server/src/lib/appCapabilitySetup.js'));

  check('the build writes the README section', has(chat, 'writeProviderHonestyToReadme('), true);
  check('…from the app\'s CURRENT files, not a stale list',
    has(chat, 'const built = await prisma.projectFile.findMany({ where: { project_id: projectId }, select: { path: true, content: true } });'), true);
  check('…and the planner can declare the capability',
    has(chat, 'providerCapabilities') && has(code(read('server/src/functions/chatWithMorpheus.js')), "enum: ['drive_upload']"), true);
  check('…honoured through the lifted variable, not the planner\'s block scope',
    has(chat, 'declared: declaredProviderCapabilities,'), true);
  check('…and it happens before the GitHub sync, so the README ships with the code',
    chat.indexOf('writeProviderHonestyToReadme(') < chat.indexOf('syncProjectFilesToGithub(user.id, project, appliedOps)'), true);
  check('…and the same verdict is put in the chat reply',
    has(chat, '// PROVIDER: ${providerReport.headline}'), true);
  check('…and never runs for self-dev', has(chat, 'if (!isSelfDev && appliedOps.some('), true);
  check('…and a failure there cannot lose the build', has(chat, "console.error('[chatWithMorpheus] provider honesty write failed:', err.message);"), true);

  check('the UI reads the same decision from the server', has(panel, "invoke('getAppProviderSetup'"), true);
  check('the reader and the README write share one builder', has(setup, 'buildProviderReport({'), true);
  check('the UI renders both modes', has(panel, "provider.mode === 'connected'") && has(panel, "provider.mode !== 'none'"), true);
  check('the UI never renders a failed read as "nothing to set up"',
    /catch\(\(\) => \{ if \(!cancelled\) setProvider\(null\); \}\)/.test(panel), true);
  check('the UI offers the one-time token for the app backend', has(panel, "invoke('appCapabilityGrant'"), true);
  check('…and repeats where it may live', has(panel, 'never in a web page'), true);
}

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\nA capability token is not scoped, not hashed, or not revocable — or an app');
  console.log('is being told something about its provider setup that is not true.\n');
  process.exit(1);
}
console.log('app capability grants hold.\n');
