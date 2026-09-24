// Verification that the two self-generated documentation pages do not claim to be
// what they are not.
//
// WHY THIS IS A GUARD
//
// /flow-diagram said "Generated live from the source code model" and /ai-docs said
// "Generated live from the source code". Neither is: both render hand-written data
// literals (src/lib/aiFunctionsData.js, the FlowDiagram data) that still describe
// the pre-rewrite Base44 stack — a Deno runtime, @base44/sdk, 35 backend functions
// against 123 today, 15 shared modules against 79, 11 entities against 54, and
// model names that do not exist on this platform at all.
//
// A document that confidently describes deleted software is worse than no document,
// and the fix that matters is the CLAIM. This pins it, because the disclaimer is a
// sentence somebody will eventually tidy away without knowing why it is there.
//
// Run: node scripts/verify-doc-honesty.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const read = (rel) => readFileSync(path.join(REPO, rel), 'utf8');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

const PAGES = ['src/pages/FlowDiagram.jsx', 'src/pages/AIDocs.jsx'];

console.log('\nstale-document honesty — verification\n');
for (const page of PAGES) {
  const src = read(page);
  console.log(`${page}`);
  check('  says it is a point-in-time snapshot', /point-in-time snapshot/.test(src), true);
  check('  says it is not generated from the current source', /not generated from the current\s+source|not generated from the current source/.test(src.replace(/\s+/g, ' ')), true);
  check('  says parts of it are wrong', /(are simply wrong|are wrong)/.test(src), true);
  check('  points at the source of truth instead', src.includes('scripts/context.mjs'), true);
  check('  no longer claims to be generated live from the source',
    /Generated live from the source/i.test(src), false);
}

console.log(`\n${failures === 0 ? '✓' : '✗'} ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
