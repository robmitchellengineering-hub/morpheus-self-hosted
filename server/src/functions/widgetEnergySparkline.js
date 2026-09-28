// widgetEnergySparkline — the backend read behind the Command Deck's energy
// sparkline widget.
//
// Own-data only: every row returned belongs to the caller (`created_by_id`
// is asserted here, not inferred from scope). Deck* models are personal data —
// see KNOWN-HAZARDS.md H16 for why an admin must never have another account's
// Deck rows merged into their own view through this path.
//
// Deliberately NOT in PUBLIC_FUNCTIONS or ADMIN_FUNCTIONS in
// routes/functions.routes.js: this is an ordinary authenticated, user-scoped
// read. The generic dispatcher auto-loads this file by name — no route or
// registry edit is needed, and none should be made from this build.
import { prisma } from '../db.js';

// The 'low' | 'med' | 'high' vocabulary lives on DeckEnergyLogEntry.level;
// this module only ever passes it through, never invents a value for it.
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

export default async function handler({ user, body }) {
  if (!user?.id) throw Object.assign(new Error('Not authenticated'), { status: 401 });

  // Clamp rather than trust: `days` arrives from the client. A NaN, a float, a
  // negative or a 10-year window all resolve to a sane 1–365 range instead of
  // throwing or asking the database for an unbounded scan.
  const requested = Number.parseInt(body?.days, 10);
  const days = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), MAX_DAYS) : DEFAULT_DAYS;

  const rows = await prisma.deckEnergyLogEntry.findMany({
    where: { created_by_id: user.id },
    orderBy: { date: 'desc' },
    take: days,
  });

  // Newest-first is the right read (that is what `take` must bound against),
  // but a sparkline is drawn oldest→newest, so flip it once here and let the
  // widget render the array as given.
  const sparkline = rows
    .map((row) => ({
      date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10),
      level: row.level,
    }))
    .reverse();

  return { sparkline, days };
}
