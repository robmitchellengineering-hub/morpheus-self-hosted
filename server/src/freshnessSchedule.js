// Runs the freshness check (server/src/freshness.js) on an ongoing
// schedule and emails an operator if the report changed since last run.
//
// Two modes, matching how worker.js already documents single-instance vs.
// horizontally-scaled self-hosts:
//   - No REDIS_URL (default self-host, one instance): a plain in-process
//     interval here is fine — there's only ever one process to run it.
//   - REDIS_URL set (multiple API replicas): running a setInterval in every
//     replica would mean duplicate checks and duplicate emails, so this
//     backs off and worker.js registers a single BullMQ repeatable job
//     instead — runs exactly once no matter how many replicas exist.
import { queueEnabled } from './queue.js';
import { runFreshnessCheckAndNotify } from './freshness.js';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const FIRST_RUN_DELAY_MS = 60 * 1000; // let the server finish booting first

export function startFreshnessSchedule() {
  if (queueEnabled()) {
    console.log('[freshness] REDIS_URL is set — scheduled via the worker process (see worker.js) instead of here.');
    return;
  }
  if (process.env.FRESHNESS_CHECK_ENABLED === 'false') {
    console.log('[freshness] disabled via FRESHNESS_CHECK_ENABLED=false.');
    return;
  }

  const notifyEmail = process.env.FRESHNESS_NOTIFY_EMAIL || process.env.SMTP_USER || null;
  const intervalMs = Number(process.env.FRESHNESS_CHECK_INTERVAL_MS) || DEFAULT_INTERVAL_MS;

  const run = () => {
    runFreshnessCheckAndNotify(notifyEmail)
      .then(({ summary }) => {
        if (summary.length) console.log(`[freshness] ${summary.length} item(s) worth reviewing: ${summary.join('; ')}`);
        else console.log('[freshness] up to date, nothing to review.');
      })
      .catch((err) => console.warn('[freshness] check failed:', err.message));
  };

  setTimeout(() => {
    run();
    setInterval(run, intervalMs).unref();
  }, FIRST_RUN_DELAY_MS).unref();

  console.log(`[freshness] scheduled — first check in ~${Math.round(FIRST_RUN_DELAY_MS / 1000)}s, then every ${Math.round(intervalMs / 3600000)}h.`);
}
