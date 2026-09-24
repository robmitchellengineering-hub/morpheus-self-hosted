// Admin-only status read for the Proving Ground's compact status strip.
//
// Three cheap signals an operator otherwise has to go and look up: container
// memory, how many self-dev runs are recorded, and which branch self-dev pushes to.
//
// WHY THIS FILE IS HAND-WRITTEN RATHER THAN SHIPPED AS GENERATED
//
// Self-dev produced a first version of this endpoint that passed lint, build, all
// 35 guards and the render check, and was broken at runtime:
//
//   * it counted runs with `prisma.selfDevRun.count()`. There is no such model —
//     this table is added by a manual migration and read with raw SQL (see
//     lib/selfDevRuns.js), so that expression throws synchronously while the
//     Promise.allSettled array is being built. Every request failed.
//   * it bridged to lib/containerMemory.js by GUESSING export names
//     (`getContainerMemoryMiB || getContainerMemory || getMemory || default`) and,
//     when the guesses missed, reimplemented cgroup parsing itself — a second copy
//     of a rule that already exists, which is the thing this repo refuses to accept.
//
// Both are the same failure: it wrote against an imagined API instead of reading
// the one that exists. Everything here is best-effort and reports its own
// unavailability, because a status strip that 500s tells the operator nothing.

import { prisma } from '../db.js';
import { containerMemory, describeContainerMemory } from '../lib/containerMemory.js';
import { SELF_DEV_BRANCH } from '../lib/selfDevRepo.js';

export default async function handler({ user }) {
  // The dispatcher's ADMIN_FUNCTIONS gate already covers this; the guard here is
  // so the function is safe if it is ever reached another way.
  if (!user || user.role !== 'admin') return { available: false, reason: 'admin only' };

  let memory = null;
  try {
    memory = describeContainerMemory(containerMemory());
  } catch {
    memory = null;   // /sys/fs/cgroup is not readable in every environment
  }

  // Counted the way lib/selfDevRuns.js reads it. `null` with a reason, never a
  // silent 0: "the table is missing" and "there are no runs" are different answers.
  let runCount = null;
  let runCountReason = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      'select count(distinct run_id)::int as n from self_dev_runs where created_by_id = $1',
      String(user.id),
    );
    runCount = Number(rows?.[0]?.n ?? 0);
  } catch (err) {
    runCountReason = err?.message || 'unknown error';
  }

  return {
    available: true,
    memory,
    runCount,
    runCountReason,
    // The constant, not a guess: this is the branch self-dev is configured to push to.
    branch: SELF_DEV_BRANCH,
    // The server's own clock, so a status strip can show what time this reading
    // was actually taken — and, by extension, whether the process answering is
    // the one the operator thinks it is. ISO 8601 UTC, not a localised string:
    // a formatted date would read differently depending on where the container
    // believes it is.
    utcTime: new Date().toISOString(),
  };
}
