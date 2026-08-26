// Background worker process. Run as a separate deployment/pod from the API
// servers so heavy AI/compile-polling work scales independently of request
// throughput (see SCALING.md). Mostly a no-op today until a queue producer
// is wired up in autonomousBuildStep/getCompileStatus — see queue.js's
// header comment — except for the freshness-check repeatable job below,
// which this process owns whenever REDIS_URL is set (see
// freshnessSchedule.js for why: exactly-once across however many API
// replicas are running, instead of every replica running its own timer).
import 'dotenv/config';
import { queueEnabled, getQueue, startWorker } from './queue.js';
import { runFreshnessCheckAndNotify } from './freshness.js';

if (!queueEnabled()) {
  console.log('[morpheus-worker] REDIS_URL not set — nothing to do. This process is only needed once you offload work onto queue.js, or once REDIS_URL is set (single-instance self-hosts get the freshness check via freshnessSchedule.js in the API process instead).');
  process.exit(0);
}

console.log('[morpheus-worker] started.');

const FRESHNESS_INTERVAL_MS = Number(process.env.FRESHNESS_CHECK_INTERVAL_MS) || 24 * 60 * 60 * 1000;

if (process.env.FRESHNESS_CHECK_ENABLED !== 'false') {
  const freshnessQueue = getQueue('freshness-check');
  await freshnessQueue.add(
    'check',
    {},
    { repeat: { every: FRESHNESS_INTERVAL_MS }, jobId: 'freshness-check-repeatable' },
  );
  startWorker('freshness-check', async () => {
    const notifyEmail = process.env.FRESHNESS_NOTIFY_EMAIL || process.env.SMTP_USER || null;
    const { summary } = await runFreshnessCheckAndNotify(notifyEmail);
    console.log(summary.length ? `[freshness] ${summary.length} item(s) worth reviewing: ${summary.join('; ')}` : '[freshness] up to date, nothing to review.');
  }, 1);
  console.log(`[morpheus-worker] freshness-check registered — every ${Math.round(FRESHNESS_INTERVAL_MS / 3600000)}h.`);
}

// Example of how another processor would be registered once a producer
// exists for the queues queue.js's header comment describes:
// startWorker('compile-status-poll', async (job) => { ... });
