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

const DEFAULT_BUSINESS_CONTEXT = 'a small business (no further detail set in Settings yet)';

export async function getDeckBusinessContext(userId) {
  const profile = await prisma.deckBusinessProfile.findUnique({ where: { created_by_id: userId } });
  return profile?.business_context?.trim() || DEFAULT_BUSINESS_CONTEXT;
}
