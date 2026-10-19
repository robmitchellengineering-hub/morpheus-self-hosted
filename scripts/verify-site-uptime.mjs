// Uptime: what Morpheus is allowed to say about whether a site was up.
//
// WHY THIS EXISTS — 2026-10-08
//
// /status exists in every build of the WordPress plugin and nothing stored the answer,
// so "was my site up last night?" had no answer in the product at all. Adding the
// record is easy; the ways it can LIE are not, and each one is silent:
//
//   * a site nobody has checked reading as 0% (or as 100%);
//   * a timeout on OUR side recorded as the site being down, with no way to tell it
//     from a 500 the site itself sent;
//   * an outage that is happening RIGHT NOW being withheld until it recovers;
//   * a check that took five seconds looking freshly checked because the row was
//     written when it finished;
//   * an unbounded table growing at the polling rate forever.
//
// The arithmetic is a pure module, so most of this is asserted by CALLING it; the
// wiring is asserted against the source.
//
// Run:  node scripts/verify-site-uptime.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyProbe, summarise, durationBetween, humanDuration, RETAIN_DAYS, WINDOWS, STALE_AFTER_MS,
} from '../server/src/lib/siteUptime.js';

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

const lib = read('server/src/lib/siteUptime.js');
const store = read('server/src/lib/siteUptimeStore.js');
const fn = read('server/src/functions/siteUptime.js');
const schema = read('server/prisma/schema.prisma');
const migration = read('server/prisma/selfdev-site-uptime.sql');
const bootstrap = read('server/prisma/manual-supabase-init.sql');

const T0 = Date.parse('2026-10-08T00:00:00Z');
const at = (mins, ok, extra = {}) => ({
  checked_at: new Date(T0 + mins * 60000).toISOString(),
  ok, status_code: ok ? 200 : 500, latency_ms: 120, plugin_version: '0.9.2', error: ok ? null : 'HTTP 500',
  ...extra,
});

console.log('\nWP uptime — what it may and may not claim\n');

// ── 1. one observation ──────────────────────────────────────────────────────
console.log('1. what one probe means');
const dead = classifyProbe({ status: 0, error: 'ECONNREFUSED' });
check('no response at all is DOWN', dead.ok, false);
check('…and is recorded as code 0, not as an HTTP code', dead.status_code, 0);
check('…keeping the network\'s own reason', dead.error, 'ECONNREFUSED');
const five = classifyProbe({ status: 500, data: { message: 'Internal Server Error' } });
check('a 500 is DOWN too', five.ok, false);
check('…with the status the SITE sent', five.status_code, 500);
check('…which is a different fact from code 0 (the remedies differ)', five.status_code === dead.status_code, false);
const good = classifyProbe({ status: 200, data: { plugin: 'morpheus', version: '0.9.2' } });
check('a 200 is UP', good.ok, true);
check('…and carries the plugin version it reported', good.plugin_version, '0.9.2');
const notOurs = classifyProbe({ status: 200, data: { hello: 'world' } });
check('a 200 that is not our plugin is still UP (the site answered)', notOurs.ok, true);
check('…but says so, rather than looking healthy', notOurs.error, 'the site answered, but not with the Morpheus plugin');

// ── 2. never checked is not DOWN ────────────────────────────────────────────
console.log('\n2. "we did not look" is its own answer');
const none = summarise([], T0);
check('no checks is UNKNOWN, not down', none.state, 'unknown');
check('…and every window reports null, never 0 or 100', WINDOWS.map((d) => none.uptime[`${d}d`]), [null, null, null]);
check('…with nothing claimed about latency', none.avg_latency_ms, null);
check('…and no incidents invented', none.incidents, []);

// ── 3. windows ──────────────────────────────────────────────────────────────
console.log('\n3. the windows count what is in them');
// Two checks: one 2 hours ago (down), one 20 minutes ago (up). Within 1d: 50%.
const rows = [at(-120, false), at(-20, true)];
const s1 = summarise(rows, T0);
check('the state is the LAST check, not the majority', s1.state, 'up');
check('1d uptime is the share that answered', s1.uptime['1d'], 50);
check('…and the longer windows agree while everything is inside them', [s1.uptime['7d'], s1.uptime['30d']], [50, 50]);
check('a check older than the window is not counted in the short one', summarise([at(-3 * 1440, true), at(-20, false)], T0).uptime['1d'], 0);
check('…while the 7d window still has it', summarise([at(-3 * 1440, true), at(-20, false)], T0).uptime['7d'], 50);
// ⚠️ A WINDOW WITH NO CHECKS IN IT IS null, NOT 0 — and this is the assertion that
// tells the two apart. The first version checked only the no-checks-at-ALL case, which
// the summary returns early from, so a mutation that reported 0% for an empty window
// SURVIVED: the check was satisfied by a code path the mutation never reached.
check('a window with no checks in it reports null, not zero (0% would read as an outage)',
  summarise([at(-3 * 1440, true)], T0).uptime['1d'], null);
check('…while the window that does contain it reports a real number',
  summarise([at(-3 * 1440, true)], T0).uptime['7d'], 100);

// ── 4. incidents ────────────────────────────────────────────────────────────
console.log('\n4. an outage is a run, and an open one is reported');
const inc = summarise([at(0, true), at(10, false), at(20, false), at(30, true), at(40, true)], T0);
check('one run of failures is ONE incident', inc.incidents.length, 1);
check('…started at the first failure', inc.incidents[0].started_at, at(10, false).checked_at);
check('…ended at the check that recovered', inc.incidents[0].ended_at, at(30, true).checked_at);
check('…and knows how long it lasted', inc.incidents[0].duration_ms, 20 * 60000);
const openInc = summarise([at(0, true), at(10, false), at(20, false)], T0 + 25 * 60000);
check('an outage happening NOW is reported, not withheld', openInc.incidents.length, 1);
check('…with no end yet', openInc.incidents[0].ended_at, null);
check('…and running to the present', openInc.incidents[0].duration_ms, 15 * 60000);
check('two separate outages are two incidents', summarise([at(0, false), at(10, true), at(20, false), at(30, true)], T0).incidents.length, 2);

// ── 5. the version survives an outage ───────────────────────────────────────
console.log('\n5. a site that is down still says what it was running');
const down = summarise([at(0, true), at(10, false, { plugin_version: null })], T0);
check('the version comes from the last check that HAD one', down.plugin_version, '0.9.2');

// ── 6. staleness ────────────────────────────────────────────────────────────
console.log('\n6. "up" has an age');
check('a check older than the staleness bound is flagged', summarise([at(-60, true)], T0).stale, true);
check('…and a fresh one is not', summarise([at(-5, true)], T0).stale, false);
check('the bound is a stated constant, not a number in a template', STALE_AFTER_MS, 30 * 60 * 1000);

console.log('\n7. durations read like a person wrote them');
check('seconds', humanDuration(45 * 1000), '45s');
check('minutes', humanDuration(12 * 60000), '12m 0s');
check('hours', humanDuration((3 * 60 + 12) * 60000), '3h 12m');
check('days', humanDuration((2 * 24 + 4) * 3600000), '2d 4h');
check('an unknown duration is not a made-up zero', humanDuration(null), '—');
check('a backwards pair is null, not negative', durationBetween(at(10, true).checked_at, at(0, true).checked_at), null);

// ── 8. the store's two rules ────────────────────────────────────────────────
console.log('\n8. the table stays bounded, and an unmigrated database is not an outage');
check('it is pruned on write, not by a job that may never run', /await prune\(projectId\)/.test(store), true);
check('…to a stated retention', /RETAIN_DAYS/.test(store) && RETAIN_DAYS > 0, true);
check('a MISSING TABLE reads as no history yet, not as an error',
  /isMissingUptimeTable\(err\)\) return \[\]/.test(store), true);
check('…which is hazard H11 handled rather than hoped for', /return recordCheck|isMissingUptimeTable\(err\)\) return null/.test(store), true);
// ⚠️ AND "MISSING" HAS TWO FORMS. A missing TABLE throws; a missing MODEL does not —
// `prisma.siteUptimeCheck` is simply `undefined` when the generated client predates the
// schema, so reading `.count` off it is a TypeError that reached a real browser as
// "Cannot read properties of undefined (reading 'count')". Exactly ONE direct reference
// is allowed, and it is inside the helper that asks.
check('the store asks for its delegate rather than assuming it',
  /export function uptimeDelegate\(\)/.test(store), true);
// Comments stripped first: this file's own header NAMES `prisma.siteUptimeCheck` while
// explaining the bug, and the first version of this check counted that sentence as a
// direct use — H19's "satisfied by the prose it forbids", in the other direction.
const storeCode = store.replace(/^\s*\/\/.*$/gm, '');
check('…with exactly one direct reference, inside that helper',
  (storeCode.match(/prisma\.siteUptimeCheck/g) || []).length, 1);
check('…and every read and write goes through it',
  (store.match(/const db = uptimeDelegate\(\);/g) || []).length, 5);
check('…treating a client that predates the model as "not set up yet"',
  /if \(!db\) return null; \/\/ client not regenerated yet/.test(store), true);
check('the record is written AFTER the probe but stamped with when it STARTED',
  /checkedAt: startedAt/.test(fn), true);
check('…and the probe is /status, which needs no secret and works on a stale plugin',
  /wpStatus\(conn\.siteUrl\)/.test(fn), true);
check('…and the panel is told when the table is not there yet', /ready/.test(fn) && /uptimeReady/.test(fn), true);

// ── 9. the migration, in BOTH files (H8) ────────────────────────────────────
console.log('\n9. the table exists for a fresh install and an upgraded one');
check('the model is in the schema', /model SiteUptimeCheck \{/.test(schema), true);
check('…mapped to the snake_case table the SQL creates', /@@map\("site_uptime_checks"\)/.test(schema), true);
check('…indexed by (project, time), which is how it is read', /@@index\(\[project_id, checked_at\]\)/.test(schema), true);
check('the migration creates it idempotently', /CREATE TABLE IF NOT EXISTS site_uptime_checks/.test(migration), true);
check('…with inline foreign keys, because ADD CONSTRAINT is not idempotent',
  /CONSTRAINT site_uptime_checks_project_id_fkey/.test(migration) && !/ALTER TABLE site_uptime_checks ADD CONSTRAINT/.test(migration), true);
check('…and the bootstrap carries it too, so a new self-host is not a lesser install',
  /CREATE TABLE "site_uptime_checks"/.test(bootstrap), true);

// ── 10. the schedule ────────────────────────────────────────────────────────
console.log('\n10. the schedule records, and cannot double-record');
const sched = read('server/src/siteUptimeSchedule.js');
check('it asks which sites are DUE rather than checking all of them every tick',
  /latestCheckAt\(/.test(sched) && /due\.push\(/.test(sched), true);
check('…so a restart or a manual check cannot produce a burst of duplicates',
  /\(now - lastMs\) >= intervalMs\(\)/.test(sched), true);
check('…oldest first, so the longest-unchecked site is not starved by a busy one',
  /due\.sort\(\(a, b\) => a\.lastMs - b\.lastMs\)/.test(sched), true);
check('one tick cannot become an unbounded outbound fan-out', /MAX_PER_TICK\s*=\s*\d+/.test(sched), true);
check('…and a single hanging site cannot hold the tick open', /PROBE_TIMEOUT_MS\s*=\s*\d+/.test(sched), true);
// ⚠️ ANCHORED ON THE BLOCK, NOT ON A CHARACTER COUNT. The first version searched 260
// characters past `catch (err)` for an `outcomes.push`, and the comment inside the
// catch body was longer than that — so it failed on a correct file. A window whose
// meaning changes when somebody edits a comment nearby is the same defect as a slice
// measured in characters, which I had already hit once today.
const catchAt = sched.indexOf('} catch (err) {');
const catchEnd = sched.indexOf('\n    }', catchAt);
const catchBlock = catchAt < 0 || catchEnd < 0 ? '' : sched.slice(catchAt, catchEnd);
check('the schedule\'s catch block was located (parser sanity)', catchBlock.length > 40, true);
check('one site throwing does not stop the rest — that site is recorded and the tick carries on',
  /outcomes\.push/.test(catchBlock) && !/\bthrow\b/.test(catchBlock), true);
check('in-process only when Redis is absent, or every replica would record it again',
  /queueEnabled\(\)[\s\S]{0,220}worker process/.test(sched), true);
check('…and the worker registers it when Redis IS present',
  /runDueUptimeChecks/.test(read('server/src/worker.js')), true);
check('…reading the SAME interval override, so the two cannot disagree',
  /SITE_UPTIME_INTERVAL_MS/.test(read('server/src/worker.js')), true);
check('…and the API process starts the in-process one', /startSiteUptimeSchedule\(\)/.test(read('server/src/index.js')), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ uptime is claiming something it cannot know\n');
  process.exit(1);
}
console.log('Uptime says only what it observed.\n');
