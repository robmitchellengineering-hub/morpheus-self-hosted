// Runtime verification that a failed document fill does not leave an empty doc behind.
//
// Dependency-free (source assertions only), so it runs in CI's no-install guards job.
// Run:  node scripts/verify-deck-document.mjs
//
// `createDeckDocument` creates the Google Doc and then fills it. When the fill threw, the
// empty titled document stayed in the operator's own Drive — real junk, in their account,
// produced by an operation that reported failure — and nothing ever removed it.
import { readFileSync } from 'node:fs';

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
// Comments are masked: the comment explaining this quotes the old shape, and a regex that
// matches its own explanation proves only that the explanation exists.
const mask = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

const lib = mask(read('../server/src/lib/deckGoogle.js'));
const fn = mask(read('../server/src/functions/createDeckDocument.js'));

console.log('\n1. the Drive client can remove a file');
check('a delete helper exists', /export async function deleteDriveFile\(token, fileId\)/.test(lib), true);
check('it calls the Drive v3 files endpoint with DELETE',
  /const DRIVE_API = 'https:\/\/www\.googleapis\.com\/drive\/v3'/.test(lib)
  && /\$\{DRIVE_API\}\/files\/\$\{fileId\}/.test(lib)
  && /method: 'DELETE'/.test(lib), true);
check('…and reports a failure rather than swallowing it',
  /Drive delete failed:/.test(lib), true);

console.log('\n2. the document is not left behind when the fill fails');
check('the request body is built before the document is created',
  fn.indexOf('const requests = buildDocRequests(blocks)') < fn.indexOf('createGoogleDoc(token, title)'), true);
check('the fill is wrapped so a failure can clean up',
  /try \{\s*await batchUpdateGoogleDoc\(token, doc\.documentId, requests\);\s*\} catch \(err\) \{/.test(fn), true);
check('…and the orphan is deleted',
  /deleteDriveFile\(token, doc\.documentId\)/.test(fn), true);
check('…the real error is still thrown to the caller', /\n    throw err;/.test(fn), true);
check('…and a failed cleanup is logged, not swallowed',
  /could not remove \$\{doc\.documentId\}/.test(read('../server/src/functions/createDeckDocument.js')), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('all good\n');
