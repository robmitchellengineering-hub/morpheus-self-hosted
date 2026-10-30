// corpusIngest.js — the collector the SDK sends corpus observations to (Rob, 2026-11-02).
//
// THE SDK ALREADY COLLECTS. `valiant corpus --consent` shows what leaves a machine: a salted recipe hash, the verdict, the trial
// count, the shape of the check and the repo fingerprint — never the file, the find, the replace or the check, because a recipe
// is source code. This endpoint receives exactly that and nothing else; the validation is in lib/corpusShape.js so the guard that
// proves it needs no database and can run in the no-install job.
import { prisma } from '../db.js';
import { normalizeObservations } from '../lib/corpusShape.js';

export default async function corpusIngest({ body }) {
  const shape = normalizeObservations(body);
  if (!shape.ok) return { ok: false, error: shape.error };
  if (!shape.rows.length) return { ok: true, accepted: 0, rejected: shape.rejected };

  // PARAMETERISED SQL, NOT THE GENERATED CLIENT. A deployed client may predate this table; raw SQL works either way and the ON
  // CONFLICT makes a retried batch idempotent without reading first. Values are placeholders, never interpolation.
  let accepted = 0;
  let rejected = shape.rejected;
  for (const row of shape.rows) {
    try {
      await prisma.$executeRaw`
        insert into corpus_observations (install_id, recipe, verdict, trials, check_kind, repo, license, observed_at)
        values (${row.install_id}, ${row.recipe}, ${row.verdict}, ${row.trials}, ${row.check_kind}, ${row.repo}, ${row.license}, ${row.observed_at})
        on conflict do nothing`;
      accepted++;
    } catch { rejected++; }
  }
  return { ok: true, accepted, rejected };
}
