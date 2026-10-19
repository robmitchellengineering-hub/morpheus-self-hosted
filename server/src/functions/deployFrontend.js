// Take a built web app live on the user's OWN hosting connection.
//
// Ported from nothing — this is the first frontend deployer. The gap it closes:
// a `web-app` construct could be built and compiled and its end state was
// `_compiled/release.zip` (a download link) plus DNS guidance. Morpheus could
// build an app and could not host it.
//
// 2026-09-28, the owner: "it's always the customer's connection — we are just
// facilitating and aggregating and synthesizing data." So this deploys into the
// caller's own Netlify account using the caller's own token, read from their own
// connections row. There is deliberately NO platform-level fallback token and no
// Morpheus-owned account on any path here — if the user has not connected
// Netlify, this says so plainly and stops rather than reaching for something of
// ours. (Contrast deployBackend.js, which does keep `process.env` fallbacks for
// Cloudflare/Supabase: that is a pre-existing operator convenience for backend
// targets and explicitly not the model for this file.)
//
// Number of actions follows the app, not a workflow: no backend source = this
// ONE action. Backend source that is not live yet = this refuses and points at
// the backend deploy, so a static publish cannot produce a site pointing at an
// API that does not exist.
//
// Not in PUBLIC_FUNCTIONS (server/src/routes/functions.routes.js): it spends the
// caller's credential against a live provider, so it requires a session.
//
// The ZIP request shape is the one already proven inside this repo but not wired
// into the running app — portable-architect/server/deployers.js's `netlify()`:
// POST /api/v1/sites/:siteId/deploys with `Content-Type: application/zip` and the
// archive as the body. This file differs in one way only: portable-architect
// required an existing site id, and this creates the site on first deploy.
import { prisma } from '../db.js';
import { downloadFile } from '../storage.js';
import { decodeConnections } from '../lib/connectionSecrets.js';
import { logUsage } from '../lib/projectUtils.js';
import { classifySiteAccess } from '../lib/siteAccess.js';
import { getCompileTarget } from '../lib/compile-targets/index.js';
import {
  FRONTEND_DEPLOY_PATH,
  pickArtifact,
  isArtifactStale,
  hasBackendSource,
  backendIsLive,
} from '../lib/frontendDeploy.js';

const NETLIFY_API = 'https://api.netlify.com/api/v1';

/** A URL-safe site name from the construct's name — Netlify names are global. */
function slug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'morpheus-app';
}

export default async function handler({ user, body }) {
  if (!user?.id) {
    throw Object.assign(new Error('Sign in required to take a site live.'), { status: 401 });
  }

  const { projectId } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId is required'), { status: 400 });

  // Ownership FIRST, and as a 404 rather than a 403: a project id that is not
  // the caller's must not be distinguishable from one that does not exist, or
  // this endpoint becomes a way to enumerate them. Same shape as
  // checkDeployHealth.js, which was fixed for exactly this on 2026-09-28.
  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: user.id },
    select: { id: true, name: true, compile_target: true },
  });
  if (!project) {
    throw Object.assign(new Error('Not found'), { status: 404 });
  }

  // This is the frontend path. A non-web-app target has no static build to host,
  // and saying so beats letting it fall through to a confusing "no artifact".
  if (project.compile_target !== 'web-app') {
    throw Object.assign(
      new Error(`This project builds a "${project.compile_target}", not a web app — "Take it live" publishes a built web app (web-app) to Netlify.`),
      { status: 400, code: 'WRONG_TARGET' },
    );
  }

  // The token is the caller's own, and only theirs. No process.env fallback, no
  // shared/platform credential — see the header. A malformed connections blob
  // reads as "not connected" rather than a 500, because that is the honest
  // action for the user: connect Netlify.
  const settingsRow = await prisma.userSettings.findUnique({ where: { created_by_id: user.id } });
  // Through the SHARED helper, never JSON.parse (2026-09-28). This column became encrypted at rest
  // in #397 while this feature was being built, so parsing the stored value directly throws on a
  // ciphertext row — and a local `catch` turns that into "Netlify is not connected" for a token the
  // user has just saved successfully. `decodeConnections` handles the encrypted form, the pre-#397
  // plaintext form, and the malformed case (returning {}), which is what keeps the comment above
  // true: an unreadable blob reads as "not connected" rather than as a 500.
  const userConnections = decodeConnections(settingsRow?.connections);
  const token = userConnections.netlify?.token;
  if (!token) {
    throw Object.assign(
      new Error('Netlify is not connected for your account yet. Add your own Netlify token in Settings → Connections, then take the site live — Morpheus has no hosting account of its own to fall back on.'),
      { status: 400, code: 'NO_NETLIFY_TOKEN' },
    );
  }

  const files = await prisma.projectFile.findMany({
    where: { project_id: projectId, created_by_id: user.id },
    select: { path: true, content: true, file_url: true, created_date: true, updated_date: true },
  });

  // ── What would be published ────────────────────────────────────────────────
  // The artifact is the compiled web app and nothing else. `backend/` source can
  // never reach Netlify from here — netlify() in deployBackend.js filters to
  // `backend/`, and this is its mirror image: the only thing sent is the ZIP
  // under `_compiled/`.
  const artifactName = getCompileTarget(project.compile_target)?.artifact?.artifactName;
  const artifact = pickArtifact(files, artifactName);
  if (!artifact || !artifact.file_url) {
    throw Object.assign(
      new Error('No compiled web app yet — tap COMPILE NOW, and take it live once the build finishes.'),
      { status: 400, code: 'NO_ARTIFACT' },
    );
  }
  if (isArtifactStale(artifact, files)) {
    throw Object.assign(
      new Error('The compiled app is older than your latest source change, so publishing it would put a stale site live. Tap RECOMPILE first, then take it live.'),
      { status: 400, code: 'ARTIFACT_STALE' },
    );
  }

  // ── Backend honesty ────────────────────────────────────────────────────────
  // If the construct has backend source, hosting only the frontend publishes a
  // site wired to an API that is not there. Point at the backend deploy instead
  // of producing a broken site. A construct with no backend source skips this
  // entirely — that is the one-action case.
  if (hasBackendSource(files)) {
    const backendConfig = await prisma.backendConfig.findFirst({
      where: { project_id: projectId, created_by_id: user.id },
      select: { custom_domain: true },
    });
    const deployFile = files.find((f) => f.path === 'backend/.deploy.json');
    if (!backendIsLive(deployFile?.content) && !backendConfig?.custom_domain) {
      throw Object.assign(
        new Error('This app has a backend and it is not live yet. Deploy the backend first (BUILD BACKEND), then take the frontend live — otherwise the site would point at an API that does not exist.'),
        { status: 400, code: 'BACKEND_NOT_DEPLOYED' },
      );
    }
  }

  // The bytes come from object storage through the helper that put them there
  // (storage.js downloadFile) — never by fetching the public file_url over the
  // internet. A web-app ZIP is a built static site (a few MB), not the
  // 100-200MB compiled binary KNOWN-HAZARDS H14 records as an OOM kill, so
  // buffering it is safe; the read is still wrapped so an unreadable artifact
  // is an honest message rather than a raw ENOENT 500.
  let zip;
  try {
    zip = await downloadFile(artifact.file_url);
  } catch (err) {
    throw Object.assign(
      new Error(`The compiled app could not be read from storage (${err?.message || err}). Recompile it, then try again.`),
      { status: 400, code: 'ARTIFACT_UNREADABLE' },
    );
  }
  if (!zip || zip.length === 0) {
    throw Object.assign(
      new Error('The compiled app in storage is empty. Recompile it, then try again.'),
      { status: 400, code: 'ARTIFACT_UNREADABLE' },
    );
  }

  // ── The target site ────────────────────────────────────────────────────────
  // Reuse the site this project already deployed to, so a re-deploy lands on the
  // same URL. The id lives in the project's own `frontend/.deploy.json` and NOT
  // in `userConnections.netlify.site_id`: that field is the BACKEND deployer's
  // Netlify site (deployBackend.js reads it), and sharing it would push the
  // frontend onto the backend's site — or the reverse.
  const priorFile = files.find((f) => f.path === FRONTEND_DEPLOY_PATH);
  let prior = null;
  try { prior = priorFile?.content ? JSON.parse(priorFile.content) : null; } catch { prior = null; }
  const firstDeploy = !prior?.site_id;
  let siteId = prior?.site_id || null;
  let siteUrl = prior?.url || null;

  if (firstDeploy) {
    const created = await createSite(token, project.name);
    siteId = created.id;
    siteUrl = created.url || siteUrl;
  }

  // ── Publish the ZIP ────────────────────────────────────────────────────────
  // The request shape is portable-architect/server/deployers.js's proven zip
  // deployer: the archive IS the body, sent as application/zip.
  let deployRes;
  try {
    deployRes = await fetch(`${NETLIFY_API}/sites/${siteId}/deploys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/zip' },
      body: zip,
    });
  } catch (err) {
    throw Object.assign(
      new Error(`Could not reach Netlify to publish the site (${err?.message || err}). Check your connection and try again.`),
      { status: 502, code: 'NETLIFY_UNREACHABLE' },
    );
  }

  if (!deployRes.ok) {
    const detail = await deployRes.text().catch(() => '');
    // Name the provider's own refusal — a token that lost its scope, a plan
    // limit, a malformed archive are all different problems for the user.
    const hint = deployRes.status === 401 || deployRes.status === 403
      ? ' Netlify rejected the token — reconnect it in Settings → Connections.'
      : '';
    throw Object.assign(
      new Error(`Netlify refused the upload (HTTP ${deployRes.status}).${hint} ${detail.slice(0, 300)}`.trim()),
      { status: 502, code: 'NETLIFY_REJECTED' },
    );
  }

  const deploy = await deployRes.json().catch(() => ({}));
  // The stable site URL, so "live at" does not change on every deploy — the
  // deploy-specific URL is kept separately in the record.
  const url = deploy.ssl_url || deploy.deploy_ssl_url || siteUrl || deploy.url || null;
  if (!url) {
    throw Object.assign(
      new Error('Netlify accepted the upload but returned no site URL, so Morpheus cannot tell you where it went. Open app.netlify.com to find the site.'),
      { status: 502, code: 'NETLIFY_NO_URL' },
    );
  }

  // It has been accepted; has it been PROCESSED? Reporting "live" on the upload response
  // alone would claim something that has not happened — see settleDeploy. A failure here
  // refuses the deploy and names it, and the record is left holding the previous successful
  // deploy, so the URL the operator is shown stays one that actually works.
  const settled = await settleDeploy({ token, siteId, deployId: deploy.id || null, initial: deploy });
  if (settled.state === 'error') {
    throw Object.assign(
      new Error(`Netlify could not publish this build (deploy state: error).${settled.error ? ` ${String(settled.error).slice(0, 300)}` : ''} The site is unchanged — try again, or open app.netlify.com for the deploy log.`),
      { status: 502, code: 'NETLIFY_DEPLOY_FAILED' },
    );
  }
  const pending = settled.state !== 'ready';

  // Netlify says the deploy is ready; ask the URL whether the PUBLIC can read it. A site behind
  // visitor access is deployed and unusable by anyone, which "YOUR SITE IS LIVE" must not hide.
  const access = await probeSiteAccess(url);

  // ── Record it ──────────────────────────────────────────────────────────────
  // Mirrors deployBackend.js's `backend/.deploy.json`: a project file, not a new
  // column or table. This is what makes "live at <url>" and re-deploy-to-the-
  // same-site possible on the next visit.
  const deployInfo = {
    timestamp: new Date().toISOString(),
    provider: 'netlify',
    site_id: siteId,
    site_name: deploy.name || null,
    url,
    deploy_id: deploy.id || null,
    deploy_url: deploy.deploy_ssl_url || deploy.url || null,
    artifact: artifact.path,
    artifact_saved_at: new Date(artifact.updated_date ?? artifact.created_date).toISOString(),
    status: 'deployed',
    // What Netlify said when we stopped watching. 'ready' means it is serving; anything
    // else is recorded rather than rounded up to success.
    deploy_state: settled.state,
    // What the public URL answered at deploy time: 'public' | 'login-required' | 'blocked' | 'unknown'.
    access: access.access,
    access_status: access.status,
  };

  if (priorFile) {
    await prisma.projectFile.update({ where: { id: priorFile.id }, data: { content: JSON.stringify(deployInfo, null, 2) } });
  } else {
    await prisma.projectFile.create({
      data: {
        created_by_id: user.id,
        project_id: projectId,
        path: FRONTEND_DEPLOY_PATH,
        content: JSON.stringify(deployInfo, null, 2),
        language: 'json',
      },
    });
  }

  await logUsage(user.id, 'compile', project.id, project.name, { phase: 'frontend_deploy', provider: 'netlify', firstDeploy });

  return {
    status: 'deployed',
    provider: 'netlify',
    url,
    siteId,
    siteName: deployInfo.site_name,
    deployId: deploy.id || null,
    // True when Netlify had not finished when we stopped watching. The URL is real and the
    // upload was accepted; the panel says "still finishing" rather than "live", because the
    // difference matters to someone about to tap the link.
    pending,
    deployState: settled.state,
    access: access.access,
    accessStatus: access.status,
    artifact: artifact.path,
    firstDeploy,
    deployPath: FRONTEND_DEPLOY_PATH,
  };
}

/**
 * Create the caller's Netlify site for this project.
 *
 * Tries the construct's own name first, then one timestamped variant, because
 * Netlify site names are globally unique: the ordinary case of two people with a
 * project called "my-site" would otherwise hand the second one an error they
 * cannot act on, with the fix already in hand. Anything other than a name
 * collision is surfaced as itself — never retried.
 */
async function createSite(token, projectName) {
  const base = slug(projectName);
  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const names = [base, `${base}-${Date.now().toString(36)}`];
  let last = { status: 0, detail: '' };

  for (const name of names) {
    const res = await fetch(`${NETLIFY_API}/sites`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (!data.id) {
        throw Object.assign(
          new Error('Netlify created no site for this request. Try again, or create a site in your Netlify account first.'),
          { status: 502, code: 'NETLIFY_SITE_FAILED' },
        );
      }
      return { id: data.id, url: data.ssl_url || data.url || null };
    }
    last = { status: res.status, detail: await res.text().catch(() => '') };
    // 422 is Netlify's "that name is taken"; every other status is the real
    // answer and retrying would only hide it.
    if (res.status !== 422) break;
  }

  const hint = last.status === 401 || last.status === 403
    ? ' Netlify rejected the token — reconnect it in Settings → Connections.'
    : '';
  throw Object.assign(
    new Error(`Netlify could not create the site (HTTP ${last.status}).${hint} ${String(last.detail).slice(0, 300)}`.trim()),
    { status: 502, code: 'NETLIFY_SITE_FAILED' },
  );
}

// How long to let Netlify finish processing an upload before saying so honestly
// rather than claiming success. Bounded, and a timeout is not a failure.
const DEPLOY_SETTLE_TIMEOUT_MS = 30_000;
const DEPLOY_SETTLE_POLL_MS = 2_000;

/**
 * Wait, briefly, for an accepted upload to actually settle.
 *
 * WHY. `POST /sites/{id}/deploys` returns as soon as the archive is ACCEPTED, and its
 * response carries the site URL — so reporting "live" on that response alone claims
 * something that has not happened yet, and when processing then FAILS the claim is
 * permanent and false. That is the "a failure reads as success" class this repo has
 * fixed repeatedly, and it was sitting in the one chain nobody has ever run.
 *
 * Returns one of:
 *   'ready'   — Netlify is serving it.
 *   'error'   — processing failed; the caller refuses and says so.
 *   'pending' — accepted, still processing when we stopped waiting. Honest, not
 *               failed: the deploy may well be fine a second later.
 *   'unknown' — the response carried no state we recognise. Deliberately NOT a
 *               failure: an API shape change must not break a deploy that is fine.
 */
// How long a deployed URL gets to answer before we stop asking. Bounded, and an unanswered probe is
// NOT a failure — see probeSiteAccess.
const SITE_PROBE_TIMEOUT_MS = 8_000;

/**
 * Ask the deployed URL whether the public can read it.
 *
 * WHY: the first real end-to-end run deployed, Netlify said `ready`, and the URL answered 401
 * (Netlify's visitor-access login wall) — while Morpheus told the operator their site was live. The
 * deploy HAD succeeded, so nothing in the pipeline could tell; only asking the URL can.
 *
 * Never throws and never fails a deploy: an unreachable probe classifies as 'unknown', because our
 * inability to check must not be reported as their site being broken.
 */
async function probeSiteAccess(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITE_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'user-agent': 'morpheus-deploy-check' },
    });
    // Only enough of the body to see Netlify's edge-access signature; the wall's HTML is tiny.
    let body = '';
    try { body = (await res.text()).slice(0, 8192); } catch { body = ''; }
    return classifySiteAccess({ status: res.status, body });
  } catch {
    return classifySiteAccess({ status: 0 });
  } finally {
    clearTimeout(timer);
  }
}

async function settleDeploy({ token, siteId, deployId, initial }) {  let state = typeof initial?.state === 'string' ? initial.state : '';
  if (!deployId) return { state: state || 'unknown', error: null };
  if (state === 'ready') return { state, error: null };

  const deadline = Date.now() + DEPLOY_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, DEPLOY_SETTLE_POLL_MS));
    let res;
    try {
      res = await fetch(`${NETLIFY_API}/sites/${siteId}/deploys/${deployId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // A network hiccup while watching must not fail a deploy that was accepted.
      return { state: state || 'pending', error: null };
    }
    if (!res.ok) return { state: state || 'pending', error: null };
    const body = await res.json().catch(() => null);
    if (!body?.state) return { state: state || 'unknown', error: null };
    state = body.state;
    if (state === 'ready') return { state, error: null };
    if (state === 'error') return { state, error: body.error_message || null };
  }
  return { state: state || 'pending', error: null };
}
