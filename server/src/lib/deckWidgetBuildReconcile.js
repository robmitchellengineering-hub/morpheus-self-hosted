// Finish widget-build rows that stopped reporting.
//
// WHY THIS EXISTS. A widget build runs inside the server process for ~15 minutes and then merges a
// PR that deploys production — which replaces that process. `buildDeckWidget.js` now does its durable
// work BEFORE that point (see the comment there), so the common case cannot leave a row hanging. This
// is the backstop for the uncommon one: a build that dies in ANY earlier stage (a crash, a container
// restart, an interrupted deploy) leaves a non-terminal row, and Settings polls the newest row while
// its status is not done/failed — so the progress bar would sit frozen forever, which is exactly what
// happened to two 2026-09-17 builds for eleven days.
//
// WHERE IT RUNS. On the read path the poll already takes (`listEntities` for DeckWidgetBuild), because
// that is the one place guaranteed to run after a process died. It costs one indexed query and
// compares timestamps; the rule itself lives in `deckWidgetBuildState.js`, which is import-free and
// tested in CI's no-install job.
import { prisma } from '../db.js';
import { TERMINAL_BUILD_STATUSES, isStaleBuild, staleBuildMessage } from './deckWidgetBuildState.js';

/**
 * Mark this user's stopped-reporting builds as failed, with a message that says what happened.
 * Returns the rows it resolved, so a caller can log or count them. Safe to call on every read: it
 * only ever touches rows that are non-terminal AND quiet for longer than STALE_BUILD_MS.
 */
export async function reconcileStaleWidgetBuilds(userId, nowMs = Date.now()) {
  const open = await prisma.deckWidgetBuild.findMany({
    where: { created_by_id: userId, status: { notIn: TERMINAL_BUILD_STATUSES } },
  }).catch(() => []);
  const stale = open.filter((row) => isStaleBuild(row, nowMs));
  for (const row of stale) {
    await prisma.deckWidgetBuild.update({
      where: { id: row.id },
      data: { status: 'failed', message: staleBuildMessage(row, nowMs) },
    }).catch(() => { /* a concurrent poll may have resolved it first — not an error */ });
  }
  return stale;
}
