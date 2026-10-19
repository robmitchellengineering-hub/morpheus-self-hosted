// Runs Command Deck's proactive Jarvis insight on a schedule.
//
// The product promises "tell you that before you notice it yourself"; before
// this, synthesis only fired from a button, which required the operator to
// already suspect the pattern. See lib/deckInsight.js for the two brakes that
// make running it unprompted affordable.
//
// Two modes, matching how worker.js already documents single-instance vs.
// horizontally-scaled self-hosts (this mirrors freshnessSchedule.js exactly):
//   - No REDIS_URL (default self-host, one instance): a plain in-process
//     interval here is fine — there is only ever one process to run it.
//   - REDIS_URL set (multiple API replicas): a setInterval in every replica
//     would mean duplicate syntheses and duplicate LLM spend, so this backs off
//     and worker.js registers a single BullMQ repeatable job instead — runs
//     exactly once no matter how many replicas exist.
import { queueEnabled } from '../queue.js'
import { runDeckInsights } from './deckInsight.js'

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24h
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000 // let the server finish booting first

export function startDeckInsightSchedule() {
  if (queueEnabled()) {
    console.log('[deck-insight] REDIS_URL is set — scheduled via the worker process (see worker.js) instead of here.');
    return;
  }
  if (process.env.DECK_INSIGHT_ENABLED === 'false') {
    console.log('[deck-insight] disabled via DECK_INSIGHT_ENABLED=false.');
    return;
  }

  const intervalMs = Number(process.env.DECK_INSIGHT_INTERVAL_MS) || DEFAULT_INTERVAL_MS;

  const run = () => {
    runDeckInsights().catch((err) => console.warn('[deck-insight] run failed:', err.message));
  };

  setTimeout(() => {
    run();
    setInterval(run, intervalMs).unref();
  }, FIRST_RUN_DELAY_MS).unref();

  console.log(`[deck-insight] scheduled — first run in ~${Math.round(FIRST_RUN_DELAY_MS / 1000)}s, then every ${Math.round(intervalMs / 3600000)}h.`);
}
