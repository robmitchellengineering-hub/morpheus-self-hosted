// Does the repository still state its own terms — and state them in the place that ships?
//
// WHY THIS EXISTS. Rob, 2026-10-05: *"lets not grant those rights"* — Morpheus is published source, not
// open source. It is a PUBLIC repository and the site serves a ZIP of ~813 of its own source files, so
// anyone can read it; what nobody has is a LICENCE, and with no licence granted the default is all rights
// reserved. That is the posture, and it is entirely carried by a text file plus three `license` fields.
//
// WHICH MEANS IT IS ONE `rm` FROM DISAPPEARING. Nothing breaks. The build passes, the site deploys, the
// portable bundle still downloads — and the project silently becomes "publicly readable with no terms",
// which is the ambiguous middle this replaced. A contributor cannot tell whether they may reuse it, and a
// customer cannot tell what they are buying.
//
// ⚠️ AND IT ALREADY WENT WRONG ONCE, IN THE OPPOSITE DIRECTION: two `package.json` files declared
// `"license": "MIT"` — an ACTIVE GRANT of exactly the rights this posture withholds — while every other
// file granted nothing. A licence field in a manifest is a grant, not a label, so the repository was
// contradicting itself and the permissive half was in the files a tool reads first.
//
// THE ASSERTIONS, in order of what they protect:
//   1. the notice exists and says the two things that make it unambiguous — published, and NOT a grant;
//   2. no manifest declares a permissive licence, because that is a grant whatever the LICENSE file says;
//   3. every manifest points at the notice;
//   4. the PORTABLE BUNDLE carries it, because that ZIP is the public source distribution and a copy that
//      travels without its terms is the one that matters most;
//   5. and the carve-out for generated applications survives — this notice must never be readable as
//      claiming a user's own project.
//
// Dependency-free — reads text files. Run: node scripts/verify-license-terms.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}
function truthy(name, ok) {
  checks++;
  if (ok) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}`); failures++; }
}

// ── 1. the notice itself ──────────────────────────────────────────────────────────────────────────────────
console.log('\n1. the repository states its terms');
const licensePath = join(ROOT, 'LICENSE');
check('a LICENSE file exists', existsSync(licensePath), true);
const license = existsSync(licensePath) ? readFileSync(licensePath, 'utf8') : '';
// The two halves of an unambiguous source-available notice. "Published" without "not a grant" reads as
// permission, and "not a grant" without "published" contradicts the fact that the repo is public and the
// site serves its source — so both are asserted, not one.
truthy('…it says the source is PUBLISHED, because it is', /publish/i.test(license) && /read/i.test(license));
truthy('…and says outright that this is NOT an open-source licence', /NOT AN OPEN-SOURCE LICENCE/.test(license));
truthy('…and reserves the rights rather than leaving them implied', /[Aa]ll rights reserved/.test(license));

// ⚠️ AND IT MUST ACTUALLY WITHHOLD THEM, WHICH IS NOT THE SAME AS RESERVING THEM. A mutation proved the
// point: replacing "No licence is granted except as set out below." with "You are free to use this software
// for any purpose." left every check above PASSING, because they all assert that something is PRESENT and
// none asserted that the important thing is ABSENT. A notice that reserves rights and then grants them is
// the contradiction this whole posture exists to remove.
//
// The denial is scoped to the prohibitions half of the file, because the other half — the carve-out for what
// Morpheus builds FOR a user — is supposed to grant exactly these verbs. Asserting both halves with the SAME
// pattern is what makes the distinction load-bearing rather than a matter of phrasing.
const GRANT = /\b(you|anyone|everyone)\b[^.]{0,60}\b(free to|permitted to|may|can)\b[^.]{0,60}\b(copy|modify|distribute|reuse|sublicense|sell|use this)\b/i;
const splitAt = license.indexOf('WHAT THIS NOTICE DOES NOT COVER');
truthy('the notice has a prohibitions half and a carve-out half', splitAt > 0);
const prohibitions = license.slice(0, splitAt);
const carveOut = license.slice(splitAt);
truthy('…and the prohibitions half does NOT grant use, copying, modification or distribution',
  !GRANT.test(prohibitions));
truthy('…while the carve-out half DOES grant the user their own generated project',
  GRANT.test(carveOut));

// ── 2. the carve-out that keeps it from contradicting the product ─────────────────────────────────────────
// The product promises "you own every file" about what Morpheus BUILDS. If this notice can be read as
// claiming a user's own generated project, it contradicts the promise and it is wrong. Asserted as its own
// section because it is the one line in the file that must never be lost in an edit.
console.log('\n2. and it does not claim what Morpheus builds FOR a user');
truthy('…the notice carves out generated applications explicitly',
  /APPLICATIONS MORPHEUS GENERATES ARE YOURS/.test(license));
truthy('…and keeps the promise in the product\'s own words', /You own every file/.test(license));
truthy('…and does not extend to third-party components, whose licences govern them',
  /THIRD-PARTY COMPONENTS KEEP THEIR OWN LICENCES/.test(license) && /NeuralAmpModelerCore/.test(license));

// ── 3. no manifest contradicts it ─────────────────────────────────────────────────────────────────────────
// ⚠️ THIS IS THE HALF THAT HAD ALREADY GONE WRONG. `server/package.json` and
// `portable-architect/package.json` both said `"license": "MIT"` — a grant of use, modification and
// redistribution — while the LICENSE file granted nothing. A tool reads the manifest; a person reads the
// LICENSE. They have to agree, and a permissive value here silently wins.
console.log('\n3. no manifest grants what the notice withholds');
const MANIFESTS = ['package.json', 'server/package.json', 'portable-architect/package.json', 'hosted-broker/package.json'];
const PERMISSIVE = /^(MIT|ISC|BSD|Apache|GPL|AGPL|LGPL|MPL|Unlicense|CC0|0BSD|WTFPL)/i;
const seen = [];
for (const rel of MANIFESTS) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) continue;
  const pkg = JSON.parse(readFileSync(p, 'utf8'));
  seen.push(rel);
  const lic = pkg.license;
  check(`${rel} does not declare a permissive licence`, PERMISSIVE.test(String(lic || '')) , false);
  // Derived from the path, not hardcoded per package: a manifest in a subdirectory needs `../LICENSE`, and
  // the first version of this listed the two directories that existed and then failed on the third.
  const expected = rel.includes('/') ? 'SEE LICENSE IN ../LICENSE' : 'SEE LICENSE IN LICENSE';
  check('…and points at the notice instead', lic, expected);
}
truthy('the manifest list was actually read (guards against a pass over nothing)', seen.length >= 3);

// ── 4. it travels with the thing that is actually distributed ─────────────────────────────────────────────
// The portable bundle is a ZIP of this repository's own source, served from the public site. It is the only
// artefact where the source and its terms can be separated by a download, so the notice has to be inside it
// — and it is generated, so this reads the generator rather than a produced file.
console.log('\n4. the public source distribution carries it');
const bundleSrc = readFileSync(join(ROOT, 'server/src/lib/portableBundle.js'), 'utf8');
truthy('the portable bundle README states the terms', /published source, not open source/.test(bundleSrc));
truthy('…and repeats the generated-apps carve-out, where a reader will look for it',
  /Your own projects are not covered by this/.test(bundleSrc));

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ Morpheus is published source, not open source — and the terms that say so are one\n'
    + '  deleted file away from disappearing, or one manifest field away from being contradicted.\n');
  process.exit(1);
}
console.log('the repository states its own terms, in the repository and in the download\n');
