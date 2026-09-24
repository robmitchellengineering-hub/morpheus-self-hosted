// Token System Build Plan Step 6b — DeepSeek provider balance safeguard.
//
// DeepSeek (like most LLM providers billed on a prepaid balance) fails
// EVERY call platform-wide the instant that balance hits zero — a total
// outage, not a degraded mode, since every user's traffic funnels through
// this one deployment-wide key (server/src/ai.js resolveEndpoint()'s
// "platform" tier). This module is the safeguard: poll DeepSeek's own
// balance API on a schedule, alert well before zero (not at zero), and
// hand resolveEndpoint() a cheap in-memory read so it can fail over to a
// configured fallback provider automatically instead of erroring out.
//
// Deliberately scoped to monitoring + alerting + automatic failover only —
// NOT automated recharge. DeepSeek's public API is read-only for balance
// (confirmed against their docs: GET /user/balance, no top-up endpoint);
// actually moving money to refill the account is a real financial
// transaction and stays a human (Rob) action, same as every other payment
// in this codebase (Stripe checkout always requires the buyer's own
// confirmed action, nothing here ever charges anything on its own).
import { sendMail } from './mailer.js';
import { prisma } from '../db.js';
import { getPlatformSetting } from './platformSettings.js';
import { recordBalanceReading, DEEPSEEK } from './providerSpendState.js';

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
const DEFAULT_MIN_BALANCE_USD = 10; // "warning" threshold — configurable via admin Config tab (deepseek_balance_min_usd)
const RE_ALERT_MS = 24 * 60 * 60 * 1000; // don't re-email every single check while still in a bad state

export function isDeepSeekPrimary() {
  return /deepseek\.com/i.test(process.env.LLM_BASE_URL || '');
}

export function hasFallbackConfigured() {
  return Boolean(process.env.FALLBACK_LLM_API_KEY);
}

// In-memory only — same tradeoff as platformSettings.js's cache: a DB or
// network round-trip on every single AI call would add real latency to
// what the user is waiting on. Worst case on a restart is one extra
// balance check before the cache warms, not a correctness problem.
let status = { level: 'unknown', checkedAt: 0, totalUsd: null, isAvailable: null, error: null };
let lastAlertedLevel = null;
let lastAlertedAt = 0;

export function getCachedStatus() {
  return status;
}

// The one thing resolveEndpoint() actually needs, kept as a single cheap
// boolean check: "route this call to the fallback provider instead."
// Deliberately fails *open* toward the fallback rather than toward
// DeepSeek when the check itself is stale/unknown or DeepSeek isn't even
// configured as primary — an unmonitored DeepSeek key should never look
// artificially healthy just because nobody's checked it yet.
export function shouldUseFallback() {
  if (!isDeepSeekPrimary()) return false; // nothing to fail over from
  if (status.level === 'unavailable') return true;
  return false; // 'ok' / 'warning' / 'unknown' all still route to DeepSeek — warning is an early heads-up, not yet an outage
}

async function fetchBalance(apiKey) {
  const res = await fetch(DEEPSEEK_BALANCE_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`DeepSeek balance check failed: HTTP ${res.status}`);
  return res.json();
}

async function alert({ level, subject, text }) {
  const now = Date.now();
  const escalating = level !== lastAlertedLevel;
  const dueForReminder = now - lastAlertedAt > RE_ALERT_MS;
  if (!escalating && !dueForReminder) return; // already alerted for this exact state recently — don't spam

  lastAlertedLevel = level;
  lastAlertedAt = now;

  // Always land in the Admin Panel's audit log — visible in-product even
  // if SMTP was never configured (Tier 1 item 5's status has flip-flopped
  // in the plan docs; this alert must not silently depend on it).
  try {
    await prisma.adminAuditLog.create({
      data: { admin_id: null, action: 'deepseek_balance_alert', details: JSON.stringify({ level, subject, text }) },
    });
  } catch {
    // Table may not exist on an unmigrated DB — never let alerting itself throw.
  }

  const to = process.env.DEEPSEEK_ALERT_EMAIL || process.env.FRESHNESS_NOTIFY_EMAIL || process.env.SMTP_USER;
  if (to) {
    try {
      await sendMail({ to, subject, text });
    } catch (err) {
      console.warn('[deepseek-balance] alert email failed:', err.message);
    }
  }
  console.warn(`[deepseek-balance] ${subject}`);
}

// Main entry point, called on a schedule (see deepseekBalanceSchedule.js).
// Never throws — a monitoring check failing must never take anything else
// down with it.
export async function checkBalanceAndAlert() {
  if (!isDeepSeekPrimary() || !process.env.LLM_API_KEY) {
    status = { level: 'unknown', checkedAt: Date.now(), totalUsd: null, isAvailable: null, error: null };
    return status;
  }

  try {
    const data = await fetchBalance(process.env.LLM_API_KEY);
    const info = (data.balance_infos || []).find((b) => b.currency === 'USD') || data.balance_infos?.[0];
    const totalUsd = info ? Number(info.total_balance) : null;
    const isAvailable = data.is_available !== false;
    const minBalance = Number((await getPlatformSetting('deepseek_balance_min_usd')) || DEFAULT_MIN_BALANCE_USD);

    let level = 'ok';
    if (!isAvailable) level = 'unavailable';
    else if (totalUsd != null && totalUsd < minBalance) level = 'warning';

    status = { level, checkedAt: Date.now(), totalUsd, isAvailable, error: null };

    // The reading was previously logged to stdout and thrown away, which is why
    // "what did the last 30 days actually cost" could only be answered from the
    // ESTIMATE. The delta between two readings IS the real spend, with no pricing
    // table in the path. Best-effort: this poll's job is to warn before the
    // balance hits zero, and bookkeeping must never be why that does not happen.
    if (totalUsd != null) await recordBalanceReading(DEEPSEEK, totalUsd);

    if (level === 'unavailable') {
      const fallbackNote = hasFallbackConfigured()
        ? 'Traffic is automatically failing over to the configured FALLBACK_LLM_* provider.'
        : '⚠️ No FALLBACK_LLM_API_KEY is configured — every AI call platform-wide will fail until this is fixed.';
      await alert({
        level,
        subject: '🔴 DeepSeek balance depleted — Morpheus AI calls at risk',
        text: `DeepSeek reports is_available=false (balance ~$${totalUsd ?? '?'}).${fallbackNote ? ' ' + fallbackNote : ''}\n\nTop up at https://platform.deepseek.com/top_up`,
      });
    } else if (level === 'warning') {
      await alert({
        level,
        subject: `🟡 DeepSeek balance low ($${totalUsd?.toFixed(2)}, below $${minBalance} threshold)`,
        text: `DeepSeek balance is $${totalUsd?.toFixed(2)}, under the configured $${minBalance} warning threshold. Still serving calls normally — top up soon to avoid an outage.\n\nTop up at https://platform.deepseek.com/top_up`,
      });
    } else if (lastAlertedLevel && lastAlertedLevel !== 'ok') {
      // Recovered after a prior warning/outage — one all-clear, not tracked for re-reminders.
      lastAlertedLevel = 'ok';
      lastAlertedAt = Date.now();
      try {
        await prisma.adminAuditLog.create({
          data: { admin_id: null, action: 'deepseek_balance_alert', details: JSON.stringify({ level: 'ok', subject: 'DeepSeek balance recovered' }) },
        });
      } catch { /* never let this break the check */ }
    }
  } catch (err) {
    status = { level: status.level === 'unknown' ? 'unknown' : status.level, checkedAt: Date.now(), totalUsd: status.totalUsd ?? null, isAvailable: status.isAvailable ?? null, error: err.message };
    console.warn('[deepseek-balance] check failed:', err.message);
  }

  return status;
}
