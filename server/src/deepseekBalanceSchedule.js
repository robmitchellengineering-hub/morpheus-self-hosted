// Runs the DeepSeek balance check (server/src/lib/deepseekBalance.js) on an
// ongoing schedule. Same single-instance-vs-horizontally-scaled split as
// freshnessSchedule.js — see that file's header comment for why.
import { queueEnabled } from './queue.js';
import { checkBalanceAndAlert, isDeepSeekPrimary } from './lib/deepseekBalance.js';

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000; // 15m — a balance can move fast under real paid load, unlike the 24h freshness check
const FIRST_RUN_DELAY_MS = 30 * 1000;

export function startDeepSeekBalanceSchedule() {
  if (!isDeepSeekPrimary()) {
    console.log('[deepseek-balance] LLM_BASE_URL is not DeepSeek — balance monitoring is a no-op on this deployment.');
    return;
  }
  if (queueEnabled()) {
    console.log('[deepseek-balance] REDIS_URL is set — scheduled via the worker process (see worker.js) instead of here.');
    return;
  }
  if (process.env.DEEPSEEK_BALANCE_CHECK_ENABLED === 'false') {
    console.log('[deepseek-balance] disabled via DEEPSEEK_BALANCE_CHECK_ENABLED=false.');
    return;
  }

  const intervalMs = Number(process.env.DEEPSEEK_BALANCE_CHECK_INTERVAL_MS) || DEFAULT_INTERVAL_MS;

  const run = () => {
    checkBalanceAndAlert()
      .then((status) => console.log(`[deepseek-balance] level=${status.level} balance=$${status.totalUsd ?? '?'}`))
      .catch((err) => console.warn('[deepseek-balance] check failed:', err.message));
  };

  setTimeout(() => {
    run();
    setInterval(run, intervalMs).unref();
  }, FIRST_RUN_DELAY_MS).unref();

  console.log(`[deepseek-balance] scheduled — first check in ~${Math.round(FIRST_RUN_DELAY_MS / 1000)}s, then every ${Math.round(intervalMs / 60000)}m.`);
}
