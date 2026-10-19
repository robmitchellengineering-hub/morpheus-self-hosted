// Post-deploy health check for a backend the caller owns.
//
// 2026-09-28 — SECURITY FIX. This handler used to be in PUBLIC_FUNCTIONS
// (server/src/routes/functions.routes.js), took `{ url, projectId }` from the body, was never
// handed a `user`, and fetched whatever `url` it was given before returning that URL's status code,
// latency and error text. Three separate problems in one function:
//
//   1. It was an unauthenticated open URL fetcher — an SSRF probe oracle. Any caller could name an
//      address (an internal host, a cloud metadata endpoint, a database port) and read back whether
//      it answered and how it failed.
//   2. With a `projectId` it resolved `BackendConfig.custom_domain` and `backend/.deploy.json` with
//      NO owner filter, so it disclosed another user's deployed URL to anyone who knew or guessed a
//      project id.
//   3. The old comment admitted all of it: "This is a public endpoint (no user scoping) — matches
//      the original, which used base44.entities.* without an owner filter here."
//
// Both real callers pass their own `project.id` from an authenticated page
// (src/components/matrix/BackendPanel.jsx, BackendPipelineRunner.jsx) and neither sends `url`, so
// the fix is to say what it always was: a signed-in user checking a backend on their own project.
// The target is now resolved ONLY from the caller's own project metadata — there is no code path
// left that fetches a caller-supplied address, which is what closes the SSRF hole rather than
// filtering it after the fact.
import { prisma } from '../db.js';
import { checkHealth } from '../lib/healthCheck.js';

export default async function handler({ user, body }) {
  if (!user?.id) {
    throw Object.assign(new Error('Sign in required to check a deployment.'), { status: 401 });
  }

  const { projectId } = body || {};
  if (!projectId) {
    throw Object.assign(new Error('projectId is required'), { status: 400 });
  }

  // Ownership FIRST, and as a 404 rather than a 403: a project id that is not yours must not be
  // distinguishable from one that does not exist, or the endpoint becomes a way to enumerate them.
  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: user.id },
    select: { id: true },
  });
  if (!project) {
    throw Object.assign(new Error('Not found'), { status: 404 });
  }

  // Prefer the custom domain if configured — that is what the frontend actually uses.
  const config = await prisma.backendConfig.findFirst({
    where: { project_id: projectId, created_by_id: user.id },
    select: { custom_domain: true },
  });
  let targetUrl = config?.custom_domain || null;

  // Otherwise the first component this project successfully deployed.
  if (!targetUrl) {
    const deployFile = await prisma.projectFile.findFirst({
      where: { project_id: projectId, created_by_id: user.id, path: 'backend/.deploy.json' },
      select: { content: true },
    });
    if (deployFile) {
      // A stored blob from an earlier run: a malformed one must not 500 this endpoint.
      let deployInfo = null;
      try { deployInfo = JSON.parse(deployFile.content); } catch { deployInfo = null; }
      const deployed = (deployInfo?.results || []).find((r) => r.status === 'deployed' && r.url);
      targetUrl = deployed?.url || null;
    }
  }

  if (!targetUrl) {
    throw Object.assign(
      new Error('This project has no deployed URL yet — deploy the backend first, or set a custom domain.'),
      { status: 400 },
    );
  }

  // Normalize URL — ensure it has a protocol.
  if (!targetUrl.startsWith('http')) {
    targetUrl = `https://${targetUrl}`;
  }

  const result = await checkHealth(targetUrl, { maxRetries: 3, retryDelayMs: 2000, timeoutMs: 8000 });

  return {
    url: targetUrl,
    healthy: result.healthy,
    statusCode: result.statusCode,
    responseTimeMs: result.responseTimeMs,
    error: result.error,
    attempts: result.attempts,
  };
}
