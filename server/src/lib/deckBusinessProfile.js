// 2026-09-17 (Rob: "I should be able to add custom widgets there too... you
// set up the filter how you want") — every AI prompt behind Jarvis, the
// Gmail inquiry filter, brain-dump classification, doc drafting, and
// suggested replies used to hardcode "Rob, who runs Valiant Music, a
// vintage guitar shop" directly in its prompt string. This is the one place
// that context now comes from, so the exact same widget code works for any
// account's business, not just Rob's own. An account that hasn't filled in
// Settings → Business profile yet gets a generic fallback rather than a
// blocked feature.
import { prisma } from '../db.js';
import { deckProfileSelectAttempts, isMissingDeckProfileColumn } from './deckProfileColumns.js';

const DEFAULT_BUSINESS_CONTEXT = 'a small business (no further detail set in Settings yet)';

/**
 * How many operating regions are read into a prompt.
 *
 * The field is free text a person types, so it can grow without limit; the persona interpolates it
 * on every message, so it is capped here rather than trusted. Eight is far more than any real
 * multi-territory operator needs and still bounded — an unbounded list would be a prompt-size bug
 * an operator could cause by pasting into a settings box.
 */
export const MAX_OPERATING_REGIONS = 8;

// Named columns, plus the H11 step-down in lib/deckProfileColumns.js. This read runs on every
// Jarvis message (and every Gmail sync, dump classification and draft), so a column the database
// has not been migrated for yet must not 500 the whole feature: the attempts step back newest-first
// — operating_regions, then the fee tiers, then the pre-2026-09-28 shape — where those settings are
// simply absent and resolve to their defaults.
async function findProfile(userId) {
  const attempts = deckProfileSelectAttempts();
  for (let i = 0; i < attempts.length; i += 1) {
    try {
      return await prisma.deckBusinessProfile.findUnique({
        where: { created_by_id: userId },
        select: attempts[i],
      });
    } catch (err) {
      if (!isMissingDeckProfileColumn(err) || i + 1 >= attempts.length) throw err;
    }
  }
  return null;
}

export async function getDeckBusinessContext(userId) {
  const profile = await findProfile(userId);
  return profile?.business_context?.trim() || DEFAULT_BUSINESS_CONTEXT;
}

/**
 * Where the account operates — the list Jarvis grounds jurisdiction-specific advice in (2026-10-04).
 *
 * Returns `[]` when nothing is stored, which is NOT "nowhere": it means we were never told, and the
 * persona says exactly that rather than assuming a country. Every entry is trimmed and blanks are
 * dropped, because a stray space in a settings box must not become a "region" the model reasons
 * about, and the cap keeps a free-text field from becoming a prompt-size bug.
 *
 * @returns {Promise<string[]>} up to MAX_OPERATING_REGIONS non-empty places, in the order stored
 */
export async function getDeckOperatingRegions(userId) {
  const profile = await findProfile(userId);
  const raw = profile?.operating_regions;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((region) => String(region || '').trim())
    .filter(Boolean)
    .slice(0, MAX_OPERATING_REGIONS);
}
