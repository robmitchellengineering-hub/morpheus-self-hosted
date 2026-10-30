#!/usr/bin/env node
// verify-corpus-ingest.mjs — the public collector stores the documented shape, and refuses everything else.
//
// No database, deliberately: the validation lives in server/src/lib/corpusShape.js precisely so this guard can run in the
// no-install guards job. What it cannot check here — that the handler actually persists what the shape module accepts — is
// asserted by reading the handler's own source, which is the honest limit of a text-shaped guard.
import { normalizeObservations, VERDICTS } from '../server/src/lib/corpusShape.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let wrong = 0;
const check = (n, ok) => { if (!ok) wrong++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}`); };

const obs = (o = {}) => ({ v: 1, recipe: 'a'.repeat(32), verdict: 'survived', trials: 2, checkKind: 'node', repo: 'deadbeefcafe', at: '2026-11-02T00:00:00.000Z', ...o });

{
  const r = normalizeObservations({ install: 'install-1', observations: [obs(), obs({ verdict: 'caught' })] });
  check('a documented payload is accepted', r.ok === true && r.rows.length === 2 && r.rejected === 0);
  check('…and only documented columns are kept', r.rows[0] && Object.keys(r.rows[0]).length === 8);
  check('…with the verdict intact, because the verdict is the point', r.rows.some((x) => x.verdict === 'survived') && r.rows.some((x) => x.verdict === 'caught'));
}

{
  const bad = normalizeObservations({ observations: [obs({ verdict: 'perfect' })] });
  check('an unknown verdict is rejected, not stored as a string', bad.rows.length === 0 && bad.rejected === 1);
  check('a row with no recipe hash is rejected', normalizeObservations({ observations: [{ verdict: 'caught' }] }).rows.length === 0);
  check('an oversized row is rejected, so the endpoint cannot be used as storage',
    normalizeObservations({ observations: [obs({ note: 'x'.repeat(700) })] }).rejected === 1);
}

{
  check('a body without an array is refused with a reason', normalizeObservations({ observations: 'nope' }).error?.includes('array') === true);
  check('a batch over the cap is refused, not truncated silently',
    normalizeObservations({ observations: Array.from({ length: 201 }, () => obs()) }).error?.includes('at most 200') === true);
}

{
  const withSource = normalizeObservations({ install: 'i', observations: [obs({ file: 'src/a.js', find: 'const A = 1', check: ['node', 't.mjs'] })] });
  const stored = JSON.stringify(withSource.rows);
  check('source sent by mistake is NOT stored', withSource.rows.length === 1 && !stored.includes('src/a.js') && !stored.includes('const A = 1'));
  check('an install with no id still records the observation', normalizeObservations({ observations: [obs()] }).rows[0].install_id === null);
}

{
  // the handler must actually persist what the shape module accepts — a shape module nobody calls proves nothing
  const handler = readFileSync(join(HERE, '..', 'server', 'src', 'functions', 'corpusIngest.js'), 'utf8');
  check('the handler imports the shape module rather than re-implementing it', /from '\.\.\/lib\/corpusShape\.js'/.test(handler));
  check('…and inserts every accepted row into corpus_observations', /insert into corpus_observations/.test(handler) && /\$executeRaw/.test(handler));
  check('…idempotently, because the SDK retries queued observations', /on conflict do nothing/.test(handler));
  check('…and the verdict list is the one the sets agree on', [...VERDICTS].includes('survived') && [...VERDICTS].includes('cannot-run'));
}

console.log(`\n${wrong === 0 ? 'the public collector stores the documented shape, refuses the rest, and never stores source' : `${wrong} case(s) wrong — fix before merging`}\n`);
process.exit(wrong === 0 ? 0 : 1);
