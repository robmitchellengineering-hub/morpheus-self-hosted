// A build failure Morpheus caused must not be sent to the app, and must not cost
// credits — and nothing else about the diagnosis loop may change.
//
// WHY THIS EXISTS (measured 2026-10-01). A real app's compile failed on both macOS
// jobs, and the failure was Morpheus's OWN generated workflow:
//
//   ##[error]⚠️  Pattern 'USER-MANUAL.txt' does not match any files.
//
// The Release step (fail_on_unmatched_files: true) publishes USER-MANUAL.txt, which
// workflow-renderer.js writes into the workflow BEFORE actions/checkout@v4 — and the
// checkout cleans the workspace and deletes it. Nothing in the app could fix that, and
// the diagnosis loop could not either: it writes to the construct's files while
// Morpheus regenerates the workflow on every compile. It ran anyway — 40,365 input →
// 32,000 output tokens (the cap), 2 m 20 s, recorded `status: ok`, then threw
// OUTPUT_TRUNCATED and discarded the diagnosis.
//
// This guard drives the classifier that stops that, and — the rule that matters most —
// proves that only a confident, evidence-backed 'morpheus' verdict suppresses the fix
// path. 'app' and 'unknown' keep today's behaviour, and a credential gap stays the
// caller's own classification and outranks the ownership verdict (sections 4 and 8),
// because the build pipeline must stay as free as possible. A miss is acceptable; a false
// "this is Morpheus's fault" that stops a real fix is not.
//
// Pure: no model, no key, no network, no database. Run:
//   node scripts/verify-build-failure-owner.mjs
import { readFileSync } from 'node:fs';
import * as ownerModule from '../server/src/lib/buildFailureOwner.js';
import { USER_MANUAL_FILE } from '../server/src/lib/appUserManual.js';
const { classifyBuildFailure, ownerIsMorpheus, shouldRunAiFix, MORPHEUS_OWNED_SIGNATURES } = ownerModule;

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

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
// H19: a check that can be satisfied by its own explanatory prose proves the prose
// exists. Every source assertion below reads comment-stripped code.
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

// The real signature, exactly as the failed run produced it: the Release step, the
// action's own `Pattern ... does not match any files`, and the file Morpheus names.
const REAL_ERROR = "Pattern 'USER-MANUAL.txt' does not match any files";
const REAL_LOG = [
  '##[group]Release',
  'uses: softprops/action-gh-release@v2',
  'with:',
  '##[error]⚠️  Pattern \'USER-MANUAL.txt\' does not match any files.',
  '##[error]Process completed with exit code 1.'
].join('\n');

console.log('\nA Morpheus-owned build failure\n');

console.log('1. the real failure is Morpheus-owned, and takes no AI path');
const real = classifyBuildFailure({
  error: 'Build failed on GitHub Actions',
  logs: [{ job: 'build (macos-15-intel)', log: REAL_LOG }],
  target: 'mac-app',
  artifactGlob: 'app-macos-*.dmg'
});
check('the real failure classifies as morpheus-owned', real.owner, 'morpheus');
check('…with the reason recorded', real.reason, 'release-pattern-unmatched');
check('…and the evidence names the STEP', real.evidence.step, 'Release');
check('…and the evidence names the FILE', real.evidence.file, USER_MANUAL_FILE);
// The claim the whole change rests on, driven through the decision callable rather
// than read out of source text.
check('the decision callable says no AI fix path', shouldRunAiFix(real), false);
check('…and ownerIsMorpheus agrees', ownerIsMorpheus(real), true);
check('a verdict with no evidence does NOT skip the fix path',
  ownerIsMorpheus({ owner: 'morpheus', reason: 'release-pattern-unmatched', evidence: { step: null, file: null } }), false);
check('…so shouldRunAiFix allows the path for it', shouldRunAiFix({ owner: 'morpheus', reason: 'x', evidence: { step: null, file: null } }), true);

console.log('\n2. the user-facing sentence is a reason, not a log dump');
const sentence = `${real.headline} ${real.detail}`;
check('it leads with the plain fact', sentence.includes("Morpheus's own build pipeline failed, not your app."), true);
check('it names the step it stopped in', real.detail.includes('Release'), true);
check('it names the file at fault', real.detail.includes(USER_MANUAL_FILE), true);
check('it says where the fix belongs', real.detail.includes('this is being fixed in Morpheus'), true);
check('…and that the user spent nothing on it', real.detail.includes('no credits were spent'), true);
// The guard's hygiene claim: no raw log line and no stack trace reaches the user.
check('no raw ##[error] line', /##\[(?:error|warning|group|endgroup)\]/.test(sentence), false);
check('…no verbatim log sentence', /does not match any files/i.test(sentence), false);
check('…no exit-code line', /Process completed with exit code/i.test(sentence), false);
check('…no stack trace', /Traceback \(most recent call last\)|\n\s+at\s+\S+/.test(sentence), false);
check('…no builder path from the runner', /runner\/_work|\/Users\/|\/home\/runner/.test(sentence), false);

console.log('\n3. a genuine app failure still gets the fix path');
const appLog = [
  '##[group]Install dependencies',
  'pip install -r requirements.txt',
  "ModuleNotFoundError: No module named 'requests'",
  '##[error]Process completed with exit code 1.'
].join('\n');
const app = classifyBuildFailure({ error: 'Build failed on GitHub Actions', logs: [{ job: 'build', log: appLog }], target: 'python-package' });
check('the app failure is the app\'s', app.owner, 'app');
check('…with a reason', app.reason, 'missing-module');
check('…and the auto-fix path still runs', shouldRunAiFix(app), true);
// The dangerous direction: an app failure must never be talked out of its fix.
check('the app failure is not Morpheus\'s', ownerIsMorpheus(app), false);
// …even when a Morpheus-owned signature appears in the same logs, which the real
// multi-job logs can. The app's own build error wins.
const mixed = classifyBuildFailure({
  error: REAL_ERROR,
  logs: [{ job: 'build (macos-15-intel)', log: `${REAL_LOG}\n${appLog}` }],
  target: 'mac-app',
  artifactGlob: 'app-macos-*.dmg'
});
check('an app error elsewhere in the logs wins over a Morpheus signature', mixed.owner, 'app');
check('…and keeps the fix path', shouldRunAiFix(mixed), true);

console.log('\n4. credentials are the caller\'s class, never this module\'s opinion');
// THE BOUNDARY THIS DOCUMENTS. diagnoseIssue.js answers a credential gap with the
// canonical isCredentialError() / isAuthError() branches, which this change leaves
// untouched — the ownership check does not replace them. So this classifier must carry
// no credential vocabulary at all: a credential-shaped message with no Morpheus
// signature falls through to 'unknown' and the caller keeps that class exactly as it was.
for (const message of [
  'GitHub connection not connected',
  'credentials not configured',
  'access token not set',
  'Project not authenticated',
  '401 from github',
]) {
  const result = classifyBuildFailure({ error: message });
  check(`"${message}" is not claimed as Morpheus's`, result.owner, 'unknown');
  check(`…and keeps today's behaviour`, shouldRunAiFix(result), true);
}
// The module has no credential opinion to drift from the caller's — asserted on the
// exported surface, not on prose.
check('the classifier exports no credential vocabulary',
  Object.keys(ownerModule).filter((k) => /credential|auth/i.test(k)), []);

console.log('\n5. a novel failure falls through, and does NOT become Morpheus\'s');
const novel = classifyBuildFailure({ error: 'The build failed for an unexpected reason', logs: ['something nobody has seen before'] });
check('a novel failure is unknown', novel.owner, 'unknown');
check('…carries no reason', novel.reason, null);
check('…and therefore cannot claim ownership', ownerIsMorpheus(novel), false);
check('…so it keeps today\'s behaviour exactly', shouldRunAiFix(novel), true);
check('the caller\'s own generic error text is not an app signature',
  classifyBuildFailure({ error: 'Build failed on GitHub Actions' }).owner, 'unknown');

console.log('\n6. the other Morpheus-owned signatures are real, and each says why');
// Driven with the CANONICAL constant, so renaming USER_MANUAL_FILE cannot silently
// decouple the classifier's literal from the file Morpheus actually writes.
const canonical = classifyBuildFailure({ error: `Pattern '${USER_MANUAL_FILE}' does not match any files`, target: 'mac-app' });
check('the classifier recognises the canonical USER_MANUAL_FILE', canonical.owner, 'morpheus');
const artifactGlob = classifyBuildFailure({ error: "Pattern 'app-macos-*.dmg' does not match any files", target: 'mac-app', artifactGlob: 'app-macos-*.dmg' });
check("the target's artifact glob is Morpheus's too", artifactGlob.owner, 'morpheus');
check('…and the evidence names that glob', artifactGlob.evidence.file, 'app-macos-*.dmg');
check('an unknown pattern is NOT Morpheus\'s',
  classifyBuildFailure({ error: "Pattern 'something-else.txt' does not match any files" }).owner, 'unknown');
check('a step Morpheus wrote failing is Morpheus\'s',
  classifyBuildFailure({ logs: 'USER-MANUAL.txt is empty - refusing to publish a build with no manual' }).owner, 'morpheus');
check('an unparseable generated workflow is Morpheus\'s',
  classifyBuildFailure({ logs: 'Invalid workflow file: .github/workflows/build.yml#L20\nUnexpected value' }).owner, 'morpheus');
check('…and names the rendered file',
  classifyBuildFailure({ logs: 'Invalid workflow file: .github/workflows/build.yml#L20\nUnexpected value' }).evidence.file,
  '.github/workflows/build.yml');
check('a declared artifact never produced is Morpheus\'s',
  classifyBuildFailure({ logs: 'Artifact not found for name: app' }).owner, 'morpheus');
for (const signature of MORPHEUS_OWNED_SIGNATURES) {
  check(`${signature.id}: has an id, a why and a match`,
    typeof signature.id === 'string' && typeof signature.why === 'string' && signature.why.length > 40 && typeof signature.match === 'function', true);
}
check('there are the four signatures the change names', MORPHEUS_OWNED_SIGNATURES.length, 4);

console.log('\n7. the wiring reaches the decision before it reaches the AI');
const issueSrc = codeOf(read('../server/src/functions/diagnoseIssue.js'));
const compileBody = issueSrc.slice(issueSrc.indexOf('async function diagnoseCompile('), issueSrc.indexOf('async function diagnoseGithub('));
check('the compile path classifies the failure', compileBody.includes('classifyBuildFailure('), true);
check('…and decides with the callable', compileBody.includes('ownerIsMorpheus('), true);
check('…before it reaches autoFixCodeErrors',
  compileBody.indexOf('ownerIsMorpheus(') > -1 && compileBody.indexOf('ownerIsMorpheus(') < compileBody.indexOf('autoFixCodeErrors('), true);
const buildBody = issueSrc.slice(issueSrc.indexOf('async function diagnoseBuild('));
check('the autonomous build path classifies too', buildBody.includes('classifyBuildFailure('), true);

console.log('\n8. the caller\'s credential class outranks the ownership verdict');
// THE FIXTURE. A top-level auth error whose logs ALSO carry a Morpheus-owned signature.
// Asked on its own, the classifier says 'morpheus' — which is exactly why the caller's
// own credential branch has to be reached first, and why the order is a property rather
// than a comment.
const authPlusMorpheus = {
  error: 'GitHub connection not connected',
  logs: [{ job: 'build (macos-15-intel)', log: REAL_LOG }],
  target: 'mac-app',
  artifactGlob: 'app-macos-*.dmg'
};
check('the scenario really does carry a Morpheus-owned signature',
  classifyBuildFailure(authPlusMorpheus).owner, 'morpheus');
// diagnoseIssue.js cannot be imported here — it reaches @prisma/client, and this runs in
// the no-install guards job — so the caller's ORDER is pinned on comment-stripped source,
// exactly as section 7 pins the auto-fix ordering. The gate is the claim: if the ownership
// verdict ran unconditionally, this scenario would return the Morpheus sentence and the
// credential action would never be built.
const authAt = compileBody.indexOf('isAuthError(');
const ownershipAt = compileBody.indexOf('classifyBuildFailure(');
const gateAt = compileBody.indexOf('if (!isAuthError(error)) {');
check('the caller decides its credential class before the ownership verdict',
  authAt > -1 && ownershipAt > -1 && authAt < ownershipAt, true);
check('…and the ownership verdict is gated on it', gateAt > -1 && gateAt < ownershipAt, true);
check('…so the credential action is still built by the caller',
  compileBody.includes("label: 'GitHub Connection'") && compileBody.indexOf("label: 'GitHub Connection'") < ownershipAt, true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('a Morpheus-owned failure is named, explained, and never sent to the app\n');
