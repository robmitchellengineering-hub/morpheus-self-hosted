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
import { deckProfileSelect, isMissingDeckProfileColumn } from './deckProfileColumns.js';

const DEFAULT_BUSINESS_CONTEXT = 'a small business (no further detail set in Settings yet)';

// Named columns, plus the H11 step-down in lib/deckProfileColumns.js. This read runs on every
// Jarvis message (and every Gmail sync, dump classification and draft), so a fee_* column the
// database has not been migrated for yet must not 500 the whole feature: the second attempt asks
// only for the columns that existed before 2026-09-28, where the fee tiers are simply absent and
// resolve to the defaults.
async function findProfile(userId) {
  try {
    return await prisma.deckBusinessProfile.findUnique({
      where: { created_by_id: userId },
      select: deckProfileSelect(),
    });
  } catch (err) {
    if (!isMissingDeckProfileColumn(err)) throw err;
    return prisma.deckBusinessProfile.findUnique({
      where: { created_by_id: userId },
      select: deckProfileSelect({ withFee: false }),
    });
  }
}

export async function getDeckBusinessContext(userId) {
  const profile = await findProfile(userId);
  return profile?.business_context?.trim() || DEFAULT_BUSINESS_CONTEXT;
}
