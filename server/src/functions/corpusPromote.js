// corpusPromote.js — read what customers' runs observed, and say what the corpus should learn from it.
//
// THE MISSING READER. `corpusIngest` writes `corpus_observations`; nothing has ever read it (measured 2026-11-04: one writer,
// zero readers). So evidence from every install pooled in a table and the corpus grew only when our own machines absorbed
// shards. This is the read half: a digest of candidate hazards and guards, each one carrying the installs that justify it.
//
// WHY THIS ENDPOINT DOES NOT PUBLISH. A recipe hash cannot become a rule by arithmetic — the rows deliberately contain no
// file, find, replace or check text, so the platform physically cannot invent a rule from them. Promotion ends at a
// candidate with evidence and a sentence saying what to do with it; a human accepts it into a corpus entry and
// `tools/publish-feed.mjs` signs the result. Anything that claimed to close that gap automatically would be fabricating.
//
// WHO MAY ASK. Admin session or the release token, the same door `publishPackage` uses: this reads other customers' evidence
// in aggregate, so it is not a public surface even though every row in it is anonymous.
import { prisma } from '../db.js';
import { mayPublish } from '../lib/publishAuth.js';
import { promoteObservations, digest, MIN_INSTALLS } from '../lib/corpusPromote.js';

/** How far back the digest looks. An observation that is a year old describes a version of the tool that no longer exists. */
const WINDOW_DAYS = Number(process.env.VVS_PROMOTE_WINDOW_DAYS) > 0 ? Number(process.env.VVS_PROMOTE_WINDOW_DAYS) : 120;

export default async function corpusPromote({ user, body, req }) {
  if (!mayPublish({ user, req })) return { ok: false, error: 'promotion needs an admin session or the release token' };

  // Parameterised and bounded: the window keeps the digest about the current tool, and the cap keeps one bad actor who
  // flooded the collector from turning this into an unbounded read.
  const cap = Math.min(Math.max(Number(body?.limit) || 20000, 100), 100000);
  let rows;
  try {
    rows = await prisma.$queryRaw`
      select recipe, verdict, trials, check_kind, repo, install_id, observed_at
      from corpus_observations
      where observed_at > now() - ${`${WINDOW_DAYS} days`}::interval
      order by observed_at desc
      limit ${cap}`;
  } catch (e) {
    // A table that cannot be read is not "no candidates" — that would read as a clean corpus.
    return { ok: false, error: `could not read corpus_observations: ${String(e?.message ?? e).slice(0, 160)}` };
  }

  const promotion = promoteObservations(rows, { minInstalls: Number(body?.minInstalls) > 0 ? Number(body.minInstalls) : MIN_INSTALLS });
  if (!promotion.ok) return { ok: false, error: 'observations were not an array' };

  return {
    ok: true,
    // The digest, for a run artefact or a terminal: this is what a human reads before accepting anything.
    text: digest(promotion),
    candidates: promotion.candidates,
    stats: { ...promotion.stats, windowDays: WINDOW_DAYS, cap },
    // Said in the reply so a caller cannot mistake a candidate for an accepted corpus entry.
    note: 'candidates only — nothing here is in the corpus until a human accepts it and the feed is re-published',
  };
}
