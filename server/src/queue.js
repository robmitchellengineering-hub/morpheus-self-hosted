// Optional BullMQ/Redis job queue. Every function in server/src/functions
// runs synchronously within its HTTP request today (a faithful port of how
// the original Base44 serverless functions worked — each request runs the
// full planner→coder→reviewer pipeline, or polls a GitHub Actions run, to
// completion before responding).
//
// That's fine at low-to-moderate scale. Past it, two call sites benefit
// from moving off the request/response cycle onto this queue — see
// SCALING.md §"Async job offload":
//   - autonomousBuildStep (server/src/functions/autonomousBuildStep.js) —
//     the self-driving build loop
//   - getCompileStatus polling (server/src/functions/getCompileStatus.js) —
//     GitHub Actions status polling
// This module is wired up and ready; those call sites just aren't using it
// yet, so a single-instance self-host needs no Redis at all.
import { Queue, Worker } from 'bullmq';

let connectionOpts = null;
function getConnectionOpts() {
  if (connectionOpts) return connectionOpts;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  connectionOpts = { connection: { url } };
  return connectionOpts;
}

const queues = new Map();

export function getQueue(name) {
  const opts = getConnectionOpts();
  if (!opts) return null; // no Redis configured — caller should run inline instead
  if (!queues.has(name)) queues.set(name, new Queue(name, opts));
  return queues.get(name);
}

export function startWorker(name, processor, concurrency = 4) {
  const opts = getConnectionOpts();
  if (!opts) {
    console.warn(`[morpheus] REDIS_URL not set — worker "${name}" not started.`);
    return null;
  }
  return new Worker(name, processor, { ...opts, concurrency });
}

export function queueEnabled() {
  return !!getConnectionOpts();
}
