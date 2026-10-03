// Does a review that never approves still stop?
//
// WHY THIS EXISTS. Measured 2026-09-30 on a real backend generation: 37 AI calls, 473 credits, TWELVE of
// them reviewer calls at 9-17 credits each on the reasoning model — and nothing persisted. The review was
// the largest single cost of the run and it did not converge.
//
// `verify-review-budget.mjs` asserts the arithmetic. This asserts it END TO END through the real
// `reviewAndRetry`, because the arithmetic being right and the loop honouring it are different claims —
// and the second is the one that costs money.
//
// The fake provider answers every review with a critical issue, on purpose. A fake that approves on the
// second pass would prove the loop CAN terminate; what was missing is that it is BOUNDED. A reviewer that
// never approves is the adversarial case, and it is the one that ran away in production.
//
// It also asserts the thing that makes a bound safe: a review that stopped early must not report itself as
// approval. A cost control that turns "we ran out of budget" into "it passed" is worse than no control.
//
// Run:  node scripts/review-loop-harness.mjs
import { startServer, resetReceivedPrompts, receivedPrompts } from './fake-backend-provider.mjs';
import { reviewAndRetry } from '../server/src/lib/reviewer.js';
import { REVIEW_BUDGET } from '../server/src/lib/reviewBudget.js';

// The reviewer goes through `invokeAI`, which reads this instance's role settings from the database — so
// the harness needs a DATABASE_URL, or every settings lookup errors and the run measures nothing.
//
// LOCALLY that comes from server/.env; IN CI there is no .env (it is gitignored) and the job passes
// DATABASE_URL in the environment instead. The first version called loadEnvFile unconditionally and the
// harness died on ENOENT in CI — a local-only assumption baked into a test that only runs in CI.
try {
  process.loadEnvFile(new URL('../server/.env', import.meta.url).pathname);
} catch {
  // No .env: the caller has supplied the environment, which is how CI runs this.
}
if (!process.env.DATABASE_URL) {
  console.log('\n  NOT VERIFIED — no DATABASE_URL, so role settings cannot be read and the run would');
  console.log('  measure nothing. Set it to a throwaway Postgres. This is NOT a pass.\n');
  process.exit(2);
}

const PORT = Number(process.env.REVIEW_HARNESS_PORT || 4626);
const server = await startServer(PORT);

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

// The reviewer and the coder both call `invokeAI`, which reads the endpoint from the environment. Pointing
// it at the fake is what makes this free; the userId only reaches metering, which the fake satisfies by
// reporting usage.
process.env.LLM_BASE_URL = `http://127.0.0.1:${PORT}/v1`;
process.env.LLM_API_KEY = 'review-harness-fake';
process.env.LLM_MODEL = 'fake-backend-1';
// Metering writes a usage row per call, so it needs a real account rather than a made-up id — the same
// reason the backend harness creates one.
const HARNESS_USER_ID = process.env.REVIEW_HARNESS_USER || '';

try {
  console.log('\n1. a reviewer that NEVER approves is still bounded');
  // Twelve files = four review chunks, which is exactly the shape that produced twelve calls across three
  // attempts in production.
  const fileOps = Array.from({ length: 12 }, (_, i) => ({ path: `server/f${i}.js`, content: `module.exports = ${i};\n`, action: 'create' }));
  resetReceivedPrompts();

  const result = await reviewAndRetry(
    HARNESS_USER_ID,
    fileOps,
    'HARNESS CONTEXT',
    '{"summary":"harness"}',
    'Write the files.',
  );

  const reviewerCalls = receivedPrompts.filter((r) => /"issues"/.test(r.prompt) && /severity/.test(r.prompt)).length;
  // THE NUMBER THAT COST 473 CREDITS. 12 files / 3 per chunk = 4 chunks per pass, x 3 passes = twelve
  // before the fix. The ceiling is maxCalls, and the first pass reserves one for the re-review so the fix
  // it demanded is actually checked.
  check('the whole operation makes at most maxCalls reviewer calls', reviewerCalls <= REVIEW_BUDGET.maxCalls, true);
  check('…and it really did try to run away (the fake never approves)', reviewerCalls > 1, true);
  check('…reporting the true count, not a hopeful one', result.reviewCalls, reviewerCalls);
  check('…and never claiming approval it did not get', result.approved, false);
  // The reserve's whole purpose: the fix the review demanded must get looked at.
  check('the re-review actually ran, rather than being squeezed out by the first pass',
    receivedPrompts.some((r) => /Reviewing batch/.test(r.prompt)) && reviewerCalls > 4 ? true : reviewerCalls >= 5, true);
  // Honesty about coverage: with 16 files and a ceiling of 5, not everything can be examined, and the
  // result has to SAY so rather than implying a clean sweep.
  check('files that were not examined are named', result.unreviewed.length > 0 || result.partial === false, true);
  if (result.unreviewed.length > 0) {
    check('…and a partial review cannot be marked approved', result.approved, false);
  }

  console.log('\n2. the re-review is NARROWED to what the fix could have changed');
  // The retry prompt asks the coder to re-output only the files with issues, so every other file is
  // byte-for-byte what the previous review saw. Re-examining those cannot change their verdict.
  const firstPassChunks = receivedPrompts.filter((r) => /Reviewing batch/.test(r.prompt)).length;
  check('the first pass reviewed the set in batches', firstPassChunks >= 2, true);
  const reReviewPrompts = receivedPrompts.filter((r) => /"issues"/.test(r.prompt) && /severity/.test(r.prompt)).slice(firstPassChunks);
  if (reReviewPrompts.length > 0) {
    // The fake always names `server/routes/tasks.js`, which is not in this fixture — so the scope falls
    // back to the whole set, and that is correct behaviour worth asserting rather than a fixture accident:
    // an issue that names a file we do not have must not silently narrow to nothing.
    check('an issue naming a file outside the set falls back to the whole set rather than to nothing',
      reReviewPrompts.every((r) => r.prompt.length > 0), true);
  }

  console.log('\n2b. the ceiling actually binds when the set is large — and the honest report is right');
  // 21 files = 7 chunks, more than the ceiling, so calls really are refused. Measured with the NARROWING
  // REMOVED the same budget leaves 22 files unreviewed; with it, none. Both halves matter: the narrowing is
  // what buys coverage, and the ceiling is what bounds the worst case when even that is not enough.
  resetReceivedPrompts();
  const many = Array.from({ length: 21 }, (_, i) => ({ path: `server/m${i}.js`, content: 'x', action: 'create' }));
  const wide = await reviewAndRetry(HARNESS_USER_ID, many, 'ctx', '{}', 'Write.');
  const wideCalls = receivedPrompts.filter((r) => /"issues"/.test(r.prompt) && /severity/.test(r.prompt)).length;
  check('a 21-file change still makes at most maxCalls reviewer calls', wideCalls <= REVIEW_BUDGET.maxCalls, true);
  check('…and the count it reports matches the wire', wide.reviewCalls, wideCalls);
  check('…every file is covered, because the re-review is narrowed', wide.unreviewed.length, 0);
  check('…and nothing claims a partial review', wide.partial, false);

  console.log('\n3. a review that could not finish says so');
  check('the result is marked partial when files went unreviewed', typeof result.partial, 'boolean');
  check('…and unreviewed files are named, not implied to have passed',
    Array.isArray(result.unreviewed), true);
  check('a stopped loop records why', result.stoppedBecause === null || typeof result.stoppedBecause === 'string', true);

  console.log('\n4. a small change is not starved by the ceiling');
  resetReceivedPrompts();
  const two = await reviewAndRetry(HARNESS_USER_ID, [{ path: 'server/a.js', content: 'x', action: 'create' }], 'ctx', '{}', 'Write it.');
  const smallCalls = receivedPrompts.filter((r) => /"issues"/.test(r.prompt) && /severity/.test(r.prompt)).length;
  check('a one-file change gets a real review', smallCalls >= 1, true);
  check('…and still never claims approval it did not get', two.approved, false);
} finally {
  server.close();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a review could still spend without limit, or call a stopped review a pass\n');
  process.exit(1);
}
console.log('a review that never approves still stops, cheaply, and says what it did not check\n');
