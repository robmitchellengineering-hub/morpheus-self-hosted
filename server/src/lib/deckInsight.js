// Proactive Command Deck insight — the scheduler's brain.
//
// WHY THIS EXISTS
//
// The product's promise is "tell you that BEFORE you notice it yourself". The
// synthesis existed but only fired from a button, so the operator had to
// already suspect a pattern to go looking for it — which is exactly what every
// competitor does, and not what the marketing claims.
//
// This runs it unprompted. Two brakes make that affordable and non-annoying:
//
//   1. ONLY WHEN SOMETHING CHANGED. If no Deck row has moved since the last
//      insight, there is no LLM call at all. Cost tracks activity rather than
//      elapsed time, which is what makes a daily cadence cheap.
//   2. THE MODEL MAY DECLINE. The scheduled prompt is written so "nothing worth
//      raising" is the expected answer most days, and a declined run persists
//      nothing. A periodic check-in obliged to produce a paragraph will produce
//      one, and a manufactured daily insight teaches the operator to ignore the
//      card — worse than silence.
//
// The result is stored as an ordinary DeckJarvisMessage (role "jarvis_synthesis")
// exactly as the button path does, so it appears in Jarvis's history, in his
// long-term memory, and in the DeckHome card with no UI change whatsoever.
import { prisma } from '../db.js'
import { synthesizeDeck } from '../functions/runJarvisSynthesis.js'

// The tables whose movement means "there is something new to reason about".
// Only high-churn, user-authored ones: this decides whether to spend an LLM
// call, so it must not be triggered by the insight machinery itself.
const ACTIVITY_PROBES = [
  { model: 'deckJarvisMessage', field: 'created_date', excludeSynthesis: true },
  { model: 'deckDumpItem', field: 'updated_date' },
  { model: 'deckTask', field: 'updated_date' },
  { model: 'deckStrategyNote', field: 'updated_date' },
  { model: 'deckKnowledgeNote', field: 'updated_date' },
  { model: 'deckInboxItem', field: 'updated_date' },
  { model: 'deckEnergyLogEntry', field: 'created_date' },
  { model: 'deckLifeStreamNote', field: 'created_date' },
]

// A floor between insights for one account, independent of the cron cadence.
// Cheap insurance: if the interval is ever set short, this stops a misconfigured
// deployment from producing a synthesis every few minutes.
const MIN_GAP_MS = 12 * 60 * 60 * 1000 // 12h

/** When this account last received a synthesis, or null if never. */
export async function lastInsightAt(userId) {
  const row = await prisma.deckJarvisMessage.findFirst({
    where: { created_by_id: userId, role: 'jarvis_synthesis' },
    orderBy: { created_date: 'desc' },
    select: { created_date: true },
  })
  return row?.created_date ?? null
}

/**
 * The newest Deck activity for an account, or null when there is none after
 * `since`. Returns the timestamp so callers can also ask "how stale is this?".
 */
export async function newestActivityAt(userId, since = null) {
  let newest = null
  for (const { model, field, excludeSynthesis } of ACTIVITY_PROBES) {
    const where = { created_by_id: userId }
    if (since) where[field] = { gt: since }
    // The synthesis messages themselves must never count as new activity, or
    // each insight would justify the next one and the gate would never close.
    if (excludeSynthesis) where.role = { not: 'jarvis_synthesis' }

    const row = await prisma[model].findFirst({
      where,
      orderBy: { [field]: 'desc' },
      select: { [field]: true },
    })
    const at = row?.[field]
    if (at && (!newest || at > newest)) newest = at
  }
  return newest
}

/**
 * Accounts that actually use a Deck. Derived from the same probes, so it cannot
 * drift from what "activity" means, and so an account that has been abandoned
 * for months costs nothing to include.
 */
export async function activeDeckUserIds() {
  const ids = new Set()
  for (const { model } of ACTIVITY_PROBES) {
    const rows = await prisma[model].findMany({
      distinct: ['created_by_id'],
      select: { created_by_id: true },
    })
    for (const r of rows) if (r.created_by_id) ids.add(r.created_by_id)
  }
  return [...ids]
}

/**
 * Run the proactive insight for every active Deck account.
 *
 * Never throws: one account failing must not stop the rest, and a scheduled job
 * that dies on the first error would silently stop providing the feature.
 *
 * @param {{now?: Date, log?: (...args: any[]) => void}} [opts]
 * @returns {Promise<{considered: number, raised: number, skipped: number, failed: number}>}
 */
export async function runDeckInsights({ now = new Date(), log = console.log } = {}) {
  const ids = await activeDeckUserIds()
  const result = { considered: ids.length, raised: 0, skipped: 0, failed: 0 }
  if (!ids.length) {
    log('[deck-insight] no accounts with Deck activity — nothing to do.')
    return result
  }

  for (const id of ids) {
    try {
      const last = await lastInsightAt(id)
      if (last && now.getTime() - new Date(last).getTime() < MIN_GAP_MS) {
        result.skipped++
        continue
      }

      const activity = await newestActivityAt(id, last)
      if (!activity) {
        // Nothing has moved since the last insight. This is the brake that
        // keeps a daily cadence affordable — no LLM call happens at all.
        result.skipped++
        continue
      }

      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, full_name: true },
      })
      if (!user) {
        result.skipped++
        continue
      }

      const out = await synthesizeDeck(user, { trigger: 'scheduled' })
      if (out?.skipped) result.skipped++
      else result.raised++
    } catch (err) {
      result.failed++
      log(`[deck-insight] ${id} failed: ${err?.message || err}`)
    }
  }

  log(
    `[deck-insight] ${result.considered} account(s): ${result.raised} raised, `
    + `${result.skipped} skipped, ${result.failed} failed.`,
  )
  return result
}
