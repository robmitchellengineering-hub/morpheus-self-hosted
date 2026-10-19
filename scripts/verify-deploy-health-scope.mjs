// Runtime verification that the deploy-health endpoint cannot be used to probe the world.
//
// Dependency-free (source assertions only), so it runs in CI's no-install guards job.
// Run:  node scripts/verify-deploy-health-scope.mjs
//
// The defect, verified by reading the code on 2026-09-28: `checkDeployHealth` was in
// PUBLIC_FUNCTIONS, its handler was never handed a `user`, and it fetched a `url` taken straight
// from the request body before returning that URL's status code, latency and error text. That is an
// unauthenticated SSRF probe oracle for any address a caller names. It also resolved
// `BackendConfig.custom_domain` / `backend/.deploy.json` from a bare `projectId` with no owner
// filter, disclosing another user's deployed URL. Its own comment admitted the missing scoping.
//
// This is a source-level guard on purpose: the property is "no code path here fetches an address
// the caller chose", which is exactly the kind of thing a later refactor can quietly reintroduce
// while every behavioural test still passes (both callers pass an owned projectId, so a reintroduced
// `url` path would look untested but live).
import { readFileSync } from 'node:fs';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

const fn = readFileSync(new URL('../server/src/functions/checkDeployHealth.js', import.meta.url), 'utf8');
const routes = readFileSync(new URL('../server/src/routes/functions.routes.js', import.meta.url), 'utf8');

console.log('\n1. it is no longer reachable without a session');
check('checkDeployHealth is not in PUBLIC_FUNCTIONS',
  /PUBLIC_FUNCTIONS = new Set\(\[[^\]]*'checkDeployHealth'/.test(routes), false);
check('…and the list still exists, so this is a removal and not a rename of the check',
  /const PUBLIC_FUNCTIONS = new Set\(\[/.test(routes), true);

console.log('\n2. it refuses to work without a caller');
check('the handler takes the authenticated user', /export default async function handler\(\{ user, body \}\)/.test(fn), true);
check('a missing user is a 401', /if \(!user\?\.id\)[\s\S]{0,120}?status: 401/.test(fn), true);

console.log('\n3. no path fetches an address the caller chose');
// The body is destructured for projectId ONLY. If `url` reappears as a fetch target, this fails.
check('the caller-supplied url is no longer read at all',
  /const \{ url[^}]*\} = body/.test(fn) || /body\?\.url/.test(fn) || /\bbody\.url\b/.test(fn), false);
check('the only thing fetched is the resolved target',
  (fn.match(/checkHealth\(/g) || []).length, 1
);
check('…and it is validated as one of this project\'s own URLs by construction',
  /const result = await checkHealth\(targetUrl,/.test(fn), true);

console.log('\n4. every lookup is scoped to the caller');
check('the project is resolved with an owner filter',
  /prisma\.project\.findFirst\(\{\s*where: \{ id: projectId, created_by_id: user\.id \}/.test(fn), true);
check('a project that is not yours is a 404, not a distinguishable 403',
  /if \(!project\) \{[\s\S]{0,140}?status: 404/.test(fn), true);
check('the custom domain is read with an owner filter',
  /prisma\.backendConfig\.findFirst\(\{\s*where: \{ project_id: projectId, created_by_id: user\.id \}/.test(fn), true);
check('the deploy metadata is read with an owner filter',
  /prisma\.projectFile\.findFirst\(\{\s*where: \{ project_id: projectId, created_by_id: user\.id, path: 'backend\/\.deploy\.json' \}/.test(fn), true);

console.log('\n5. a stored blob cannot take the endpoint down');
check('malformed deploy JSON is caught, not thrown',
  /try \{ deployInfo = JSON\.parse\(deployFile\.content\); \} catch \{ deployInfo = null; \}/.test(fn), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('all good\n');
