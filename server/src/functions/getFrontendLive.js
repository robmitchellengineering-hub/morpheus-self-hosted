// Is this construct live, and where? Reads the record "Take it live" wrote.
//
// WHY THIS EXISTS. CompilePanel's live state lives in memory and is cleared the moment
// the panel closes (`if (!open) reset()`), so the URL a deploy produced survived only
// until the user dismissed the panel. The site stayed live, the construct said nothing
// about it, and the button offered TAKE IT LIVE again as though nothing had happened —
// with a new deploy on the next press. For the person this path is built for, that URL
// is the entire deliverable, so it has to survive the page.
//
// Read-only and owner-scoped, 404 rather than 403 for someone else's id — the same rule
// checkDeployHealth.js was fixed to the same day. Staleness is computed with the SAME
// helpers deployFrontend.js uses, so "this is live" and "this is behind your latest
// build" cannot come to mean two different things in the two places.
import { prisma } from '../db.js';
import { getCompileTarget } from '../lib/compile-targets/index.js';
import { FRONTEND_DEPLOY_PATH, pickArtifact, isArtifactStale } from '../lib/frontendDeploy.js';

export default async function handler({ user, body }) {
  const projectId = body?.projectId;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: user.id },
    select: { id: true, compile_target: true },
  });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const files = await prisma.projectFile.findMany({
    where: { project_id: projectId, created_by_id: user.id },
    select: { path: true, content: true, file_url: true, created_date: true, updated_date: true },
  });

  const recordRow = files.find((f) => f.path === FRONTEND_DEPLOY_PATH);
  let record = null;
  try { record = recordRow?.content ? JSON.parse(recordRow.content) : null; } catch { record = null; }

  // No URL recorded means there is nothing to show, and that is not a failure: a
  // construct that has never been deployed is the normal first state.
  if (!record?.url) {
    return { live: false, url: null, siteId: null, siteName: null, stale: false, noArtifact: false, access: 'unknown' };
  }

  const artifactName = getCompileTarget(project.compile_target)?.artifact?.artifactName;
  const artifact = pickArtifact(files, artifactName);

  return {
    live: true,
    url: String(record.url),
    siteId: record.site_id || null,
    siteName: record.site_name || null,
    // Whether the public could read the URL when it was deployed. A record written before this
    // existed has no field, and 'unknown' is the honest answer for it.
    access: record.access || 'unknown',
    // Live, but built from older source than what is in the construct now. Reported,
    // never hidden: "your site is live and does not yet have your latest changes" is
    // the honest sentence, and a RE-DEPLOY that silently means "publish the old build"
    // is the one to avoid. `noArtifact` says the compiled ZIP is gone entirely, so a
    // re-deploy would refuse rather than publish something stale.
    stale: Boolean(artifact) && isArtifactStale(artifact, files),
    noArtifact: !artifact,
  };
}
