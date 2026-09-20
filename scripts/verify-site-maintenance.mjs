// Site maintenance: the rules that decide what may happen to a site unattended.
//
// WHY THIS EXISTS
//
// This is the part of the product that changes someone's live site without them
// watching, so the rules are settled and asserted BEFORE the ability exists. The
// failures worth preventing are all silent:
//
//   * scanning implying permission to apply. An owner who asked to be TOLD what
//     is wrong has not asked us to change their site; `scan_enabled` must grant
//     nothing but a scan.
//   * a major core update applied automatically. It is the one operation here
//     that can take a working site away, and WordPress's own update rollback
//     only covers a failure DURING the update — not "it worked, and now the shop
//     is broken".
//   * a monthly job that drifts into the wrong day, or skips February, because
//     "monthly" was implemented as a 30-day interval.
//   * a run that was missed while the server was down being skipped, or run
//     five times on the way back up.
//   * a report that claims something was applied when nothing was.
//
// The module under test is pure and dependency-free, so this runs in CI's
// no-install guards job (hazard H4).
//
// Run:  node scripts/verify-site-maintenance.mjs
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  POLICY_DEFAULTS, validatePolicy, isDue, nextRunAt, scheduledInstant, mayApply,
  allowedKinds, describePolicy, runSummary, MAX_DAY_OF_MONTH,
} from '../server/src/lib/siteMaintenance.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

let pass = 0;
let fail = 0;
const problems = [];

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log(`          expected ${JSON.stringify(want)}\n          got      ${JSON.stringify(got)}`);
    problems.push(name);
  }
  ok ? pass++ : fail++;
}

console.log('\n1. everything is off until the owner turns it on')

check('scanning is off by default', POLICY_DEFAULTS.scan_enabled, false);
check('applying plugins is off by default', POLICY_DEFAULTS.apply_plugins, false);
check('applying themes is off by default', POLICY_DEFAULTS.apply_themes, false);
check('applying minor core is off by default', POLICY_DEFAULTS.apply_core_minor, false);
// The field exists only to record that a human may be OFFERED a major update.
check('there is no automatic major-core field at all', 'apply_core_major' in POLICY_DEFAULTS, false);
check('the whole default policy is exactly these keys', Object.keys(POLICY_DEFAULTS).sort(),
  ['allow_core_major_manual', 'apply_core_minor', 'apply_plugins', 'apply_themes', 'day_of_month', 'hour_utc', 'scan_enabled']);

console.log('\n2. scanning never implies permission to apply')

const scanOnly = { ...POLICY_DEFAULTS, scan_enabled: true };
check('plugin updates still refused with scanning on', mayApply(scanOnly, 'plugin').allowed, false);
check('theme updates still refused', mayApply(scanOnly, 'theme').allowed, false);
check('minor core still refused', mayApply(scanOnly, 'core_minor').allowed, false);
check('nothing is applicable', allowedKinds(scanOnly).applicable, []);
check('all four kinds are merely reported', allowedKinds(scanOnly).reported.length, 4);
check('the refusal is explained, not silent', /not enabled for this site/.test(mayApply(scanOnly, 'plugin').reason), true);

console.log('\n3. a major core update is NEVER automatic')

// Even if a caller hand-crafts a policy claiming it, nothing honours it.
const smuggled = { ...POLICY_DEFAULTS, scan_enabled: true, apply_core_major: true, apply_core_minor: true };
check('core_major is refused even when smuggled into the policy', mayApply(smuggled, 'core_major').allowed, false);
check('…and the refusal says why', /never applied automatically/.test(mayApply(smuggled, 'core_major').reason), true);
check('…even for an owner-approved run', mayApply(smuggled, 'core_major', { manual: true }).allowed, false);
check('…and an owner-approved run is told it is offered, not done', /offered to the owner/.test(mayApply(smuggled, 'core_major', { manual: true }).reason), true);
check('a smuggled flag cannot leak into the allowed list', allowedKinds(smuggled).applicable.includes('core_major'), false);
// The smuggled policy enables minor core only, so that is all it may apply.
check('the other kinds still work normally when enabled', allowedKinds(smuggled).applicable, ['core_minor']);
check('an unknown kind is refused', mayApply(POLICY_DEFAULTS, 'database').allowed, false);

console.log('\n4. a monthly job stays on its day, and February exists')

// 2026-03-15T00:00Z, day 1 at 03:00 -> the run owed is 2026-03-01T03:00Z.
const march = Date.UTC(2026, 2, 15, 0, 0, 0);
const p1 = { ...POLICY_DEFAULTS, scan_enabled: true, day_of_month: 1, hour_utc: 3 };
check('the due instant this month is the scheduled one', scheduledInstant(p1, march), Date.UTC(2026, 2, 1, 3));
check('the next run is next month once this month has passed', nextRunAt(p1, march), Date.UTC(2026, 3, 1, 3));
// February: day 28 exists in every month, which is why the cap is 28.
const feb = { ...POLICY_DEFAULTS, scan_enabled: true, day_of_month: 28, hour_utc: 0 };
// From 10 February with the 28th scheduled: the NEXT instant is still February
// (the 28th exists in every month — that is why the cap is 28), and the most
// recent PAST one is 28 January.
const febTen = Date.UTC(2027, 1, 10);
check('the next run in February is still February', scheduledInstant(feb, febTen, { next: true }), Date.UTC(2027, 1, 28));
check('…and it is the 28th', new Date(scheduledInstant(feb, febTen, { next: true })).getUTCDate(), 28);
check('the most recent PAST instant is last month, not next', scheduledInstant(feb, febTen), Date.UTC(2027, 0, 28));
const rejected = validatePolicy({ day_of_month: 31 });
check('the 31st is refused rather than clamped', rejected.ok, false);
check('…and the refusal explains the 28 cap', /cannot skip February/.test(rejected.errors[0]), true);
check('day 0 is refused', validatePolicy({ day_of_month: 0 }).ok, false);
check('hour 24 is refused', validatePolicy({ hour_utc: 24 }).ok, false);
check('hour -1 is refused', validatePolicy({ hour_utc: -1 }).ok, false);
check('a valid day and hour are kept', (() => { const r = validatePolicy({ day_of_month: 15, hour_utc: 22 }); return [r.ok, r.policy.day_of_month, r.policy.hour_utc]; })(), [true, 15, 22]);
check('a bad field does not half-apply the good ones', validatePolicy({ day_of_month: 31, hour_utc: 22 }).policy.hour_utc, POLICY_DEFAULTS.hour_utc);
check('fields not mentioned are kept from current', validatePolicy({}, { ...POLICY_DEFAULTS, day_of_month: 9 }).policy.day_of_month, 9);
check('the day cap is the constant, not a magic number', MAX_DAY_OF_MONTH, 28);

console.log('\n5. a missed run happens once, not zero or five times')

const due = { ...p1, last_scan_at: null };
check('never scanned and past the day -> due', isDue(due, march), true);
// Timing, holding the catch-up rule constant: last scanned just after LAST
// month's instant, so this month is the only thing in question.
const caughtUp = { ...p1, last_scan_at: new Date(Date.UTC(2026, 1, 1, 3, 30)).toISOString() };
check('not due a minute before the instant', isDue(caughtUp, Date.UTC(2026, 2, 1, 2, 59)), false);
check('due at the instant', isDue(caughtUp, Date.UTC(2026, 2, 1, 3, 0)), true);
// And with nothing ever scanned, the month BEFORE is already owed — which is
// the catch-up rule, not a bug.
check('never scanned is owed the previous month too', isDue({ ...p1, last_scan_at: null }, Date.UTC(2026, 2, 1, 2, 59)), true);
// Scanned after this month's instant -> this month is settled.
check('already scanned this month -> not due', isDue({ ...p1, last_scan_at: new Date(Date.UTC(2026, 2, 1, 3, 30)).toISOString() }, march), false);
// The run that was missed while the server was down: last scanned two months
// ago, so it is owed exactly one run — not skipped, and not repeated.
check('a run missed while down is still owed', isDue({ ...p1, last_scan_at: new Date(Date.UTC(2026, 0, 1, 3, 30)).toISOString() }, march), true);
check('and only once (it is not due twice in the same month)', isDue({ ...p1, last_scan_at: new Date(Date.UTC(2026, 2, 1, 3, 0, 1)).toISOString() }, march), false);
check('scanning off is never due', isDue({ ...p1, scan_enabled: false, last_scan_at: null }, march), false);
check('no next run when scanning is off', nextRunAt({ ...POLICY_DEFAULTS, scan_enabled: false }, march), null);

console.log('\n6. the panel says what will happen, in words')

check('scan-only says nothing will be changed', /will not change anything/.test(describePolicy(scanOnly)), true);
check('off says it only looks when asked', /only look at this site when you ask/.test(describePolicy(POLICY_DEFAULTS)), true);
const applying = { ...POLICY_DEFAULTS, scan_enabled: true, day_of_month: 1, hour_utc: 3, apply_plugins: true, apply_themes: true };
check('the sentence names what will be applied', /applies plugin, theme updates/.test(describePolicy(applying)), true);
check('…and says major core is reported, never applied', /Major WordPress updates are reported, never applied/.test(describePolicy(applying)), true);
check('…and states the schedule in UTC', /03:00 UTC/.test(describePolicy(applying)), true);

console.log('\n7. the report never claims more than the run did')

const scan = { site: { name: 'Valiant Music', url: 'https://valiantmusic.com.au' }, summary: { critical: 1, recommended: 2 }, update_plan: { total: 3 }, can_apply: { ok: true, reasons: [] } };
const quiet = runSummary({ scan, policy: scanOnly, applied: [], failed: [], skipped: [], at: march });
check('it leads with what needs attention', /1 thing needs fixing now, 2 more worth doing/.test(quiet), true);
check('it says how many updates exist', /3 updates available/.test(quiet), true);
check('it says nothing was changed when applying is off', /nothing was changed/.test(quiet), true);
check('it does NOT say anything was applied', /Applied:/.test(quiet), false);
const did = runSummary({ scan, policy: { ...scanOnly, apply_plugins: true }, applied: ['Akismet 5.0→5.1'], failed: ['WooCommerce'], skipped: ['WordPress 7.2'], at: march });
check('an apply run names what it applied', /Applied: Akismet 5.0→5.1/.test(did), true);
check('…and names what failed', /FAILED and left alone: WooCommerce/.test(did), true);
check('…and what it only reported', /Reported but not applied: WordPress 7.2/.test(did), true);
check('a site that cannot be written to says so', /cannot have its files written/.test(runSummary({ scan: { ...scan, can_apply: { ok: false, reasons: ['not writable'] } }, policy: scanOnly })), true);

console.log('\n8. the wiring cannot apply anything yet')

const schedule = read('server/src/siteMaintenanceSchedule.js');
// The whole point of this slice: the schedule scans and reports, nothing more.
check('the schedule scans', /scanSite\(/.test(schedule), true);
check('the schedule does not apply updates', /applyMaintenance|applyUpdates|runUpdates|wpMaintenance/.test(schedule), false);
check('…and says so in its own words', /applies NOTHING/.test(schedule), true);
check('a failed scan still tells the owner', /could not run/.test(schedule), true);
check('the report goes to the construct chat', /chatMessage\.create/.test(schedule), true);
check('the tick is hourly and asks what is due', /TICK_MS = 60 \* 60 \* 1000/.test(schedule) && /isDue\(policy, now\)/.test(schedule), true);
check('the timer does not hold the process open', /timer\.unref/.test(schedule), true);

const worker = read('server/src/worker.js');
// The in-process schedule DEFERS when REDIS_URL is set (one timer per replica
// would run the check once per replica). So the worker has to register the job,
// or a scaled deployment silently never runs a monthly check at all — a gap that
// is invisible locally, where REDIS_URL is unset.
check('the worker registers the scheduled job', /getQueue\('site-maintenance'\)/.test(worker), true);
check('…with a stable job id so replicas cannot double-register', /site-maintenance-repeatable/.test(worker), true);
check('…and runs the same due-policy function, so there is one definition', /runDueSiteMaintenance\(\)/.test(worker), true);
check('…on an hourly tick, not a monthly interval', /every: 60 \* 60 \* 1000/.test(worker), true);

const fn = read('server/src/functions/siteHealth.js');
check('the handler offers scan and policy only', /ACTIONS = new Set\(\['scan', 'policy'\]\)/.test(fn), true);
check('there is no apply action', /'apply'|'fix'|'update_all'/.test(fn), false);
check('the policy travels with the scan', /policy: policyPayload/.test(fn), true);
check('an invalid policy is refused, not clamped', /INVALID_POLICY/.test(fn), true);
// A widget token is a bearer credential. Reading the policy from the dock is
// fine (the panel shows what is on); CHANGING it is the owner's decision.
// The payload the client receives is written out field by field, so a new column
// cannot leak to the browser by accident.
check('the policy payload does not echo row plumbing', /created_by_id: policy\.created_by_id|id: policy\.id/.test(fn), false);
check('…and the last run is exposed for the panel', /last_result: lastResult/.test(fn), true);
check('a widget token cannot change the policy', /req\?\.widget/.test(fn) && /OWNER_ONLY/.test(fn), true);
check('…and is told why, not just refused', /not from an embedded page/.test(fn), true);

const store = read('server/src/lib/siteMaintenanceStore.js');
check('the policy row is validated before it is written', /validatePolicy\(input, current\)/.test(store), true);
check('recording a run cannot fail the run', /could not record the run/.test(store), true);

const schema = read('server/prisma/schema.prisma');
check('the policy model exists', /^model SiteMaintenancePolicy \{/m.test(schema), true);
check('there is no automatic major-core column', /apply_core_major\s+Boolean/.test(schema), false);
check('the migration ships with the model', read('server/prisma/add-site-maintenance-policies.sql').includes('site_maintenance_policies'), true);

console.log(`\n${pass}/${pass + fail} checks passed`)
if (fail) {
  console.log('\nThis is the code that touches live sites unattended. Fix it before merging.\n')
  process.exit(1)
}
console.log('all good\n')
