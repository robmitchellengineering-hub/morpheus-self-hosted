// Admin-only drift read for the Proving Ground's workspace-drift card.
//
// WHAT IT ANSWERS
//
// How much of the self-dev workspace has moved since the content it holds was
// last synced from a commit. That is the condition KNOWN-HAZARDS.md H9 is made
// of: the workspace is a MIRROR of main, the push engine diffs it against the
// live remote tree and treats every remote path absent locally as a DELETION, so
// a stale mirror does not merely miss upstream work — it deletes it. The guard
// that refuses such a push is lib/selfDevDrift.js, backed by
// Project.synced_commit. This endpoint reports the same worry one level down, at
// the file, which is what makes it visible on a page instead of only audible
// inside a refusal.
//
// HOW
//
// Every ProjectFile row carries the git blob sha of the upstream content it was
// last synced from (`synced_sha`, see its own comment in schema.prisma).
// Recomputing that blob sha over the row's CURRENT content and comparing the two
// gives a precise answer: match = still the content that was synced, mismatch =
// changed here and not pushed.
//
// THREE ANSWERS, NOT TWO — the rule this file is most careful about:
//
//   * available:false + reason — the question could not be answered at all (no
//     workspace, the column is not migrated, the database refused). The card
//     renders this as its own state, and it must never be reported as "clean": a
//     green verdict the server never actually computed is worse than no card.
//   * driftCount — files whose recorded sha no longer matches their content.
//   * unknownCount — rows with NO recorded sha (NULL provenance). Not "unchanged":
//     lib/selfDevSyncSafety.js treats NULL conservatively for exactly this reason,
//     and folding these into either answer would be a guess dressed as a
//     measurement.
//
// Raw SQL, not the Prisma model: these tables are created and extended by
// hand-run migrations (KNOWN-HAZARDS.md H8), so a missing `synced_sha` is
// reported rather than thrown. Same shape as getProvingGroundStatus.js, for the
// same reason.

import { createHash } from 'node:crypto';
import { prisma } from '../db.js';

/**
 * git's object id for a piece of content: sha1("blob " + byteLength + NUL + content), hex.
 *
 * Deliberately the exact, byte-for-byte git convention — not a hash of the text,
 * and not a length counted in characters. `synced_sha` was written with this
 * convention by the sync path, so anything else here would report every file as
 * drifted: a false alarm on the one card whose entire job is to be believed.
 */
function gitBlobSha(content) {
  const body = Buffer.from(String(content == null ? '' : content), 'utf8');
  const header = Buffer.from(`blob ${body.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(body).digest('hex');
}

export default async function handler({ user }) {
  // The dispatcher's ADMIN_FUNCTIONS gate already covers this; the guard is here
  // so the function is safe if it is ever reached another way.
  if (!user || user.role !== 'admin') return { available: false, reason: 'admin only' };

  let workspace;
  try {
    const projectRows = await prisma.$queryRawUnsafe(
      "select id from projects where project_type = 'self_dev' limit 1",
    );
    workspace = projectRows?.[0];
  } catch (err) {
    return { available: false, reason: `could not look up the self-dev workspace: ${err?.message || 'unknown error'}` };
  }
  if (!workspace?.id) return { available: false, reason: 'no self-dev workspace exists on this deployment' };

  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      'select path, synced_sha, content, file_url from project_files where project_id = $1',
      workspace.id,
    );
  } catch (err) {
    const message = err?.message || '';
    // P2022 is Prisma's "column does not exist"; the message test covers the raw
    // driver's own wording, since this query bypasses the Prisma model entirely.
    if (err?.code === 'P2022' || (/synced_sha/i.test(message) && /does not exist/i.test(message))) {
      return {
        available: false,
        reason: 'project_files.synced_sha does not exist yet — run server/prisma/selfdev-add-file-synced-sha.sql to make drift verifiable',
      };
    }
    return { available: false, reason: `could not read the workspace files: ${message || 'unknown error'}` };
  }

  const files = Array.isArray(rows) ? rows : [];
  let driftCount = 0;
  let unknownCount = 0;
  let skippedFiles = 0;

  for (const row of files) {
    // A row with a file_url holds only a text preview locally; its real content
    // lives in storage and cannot be blob-hashed from here. Counted separately
    // rather than guessed at in either direction.
    if (row.file_url) {
      skippedFiles += 1;
      continue;
    }
    const recorded = typeof row.synced_sha === 'string' && row.synced_sha.length > 0 ? row.synced_sha : null;
    if (!recorded) {
      unknownCount += 1;
      continue;
    }
    if (gitBlobSha(row.content) !== recorded) driftCount += 1;
  }

  // The one-line verdict. Unknowns count as "locally modified" on purpose: a row
  // with no sync point cannot be shown to be unchanged, and on this page "I
  // could not tell" must not read the same as "clean".
  const unaccounted = driftCount + unknownCount;
  const verdict = unaccounted === 0
    ? 'clean'
    : `${unaccounted} files locally modified${unknownCount > 0 ? ` (${unknownCount} with no recorded sync point)` : ''}`;

  return {
    available: true,
    projectId: workspace.id,
    totalFiles: files.length - skippedFiles,
    driftCount,
    unknownCount,
    skippedFiles,
    verdict,
  };
}
