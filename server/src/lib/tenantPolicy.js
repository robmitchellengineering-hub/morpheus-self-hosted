// Tenant policy enforcement (2026-09-10) — the runtime checks that make the
// enginePolicy.js caps real. Self-dev / the owner run as `admin` (no caps);
// everyone else is a `plugin_tenant` — capped turns/hour and restricted to
// repos their own GitHub token can push to. See the "Self-Dev as a Plugin"
// scope doc, §"Safety rails".
import { prisma } from '../db.js';
import { resolvePolicy } from './enginePolicy.js';

const GH_API = 'https://api.github.com';

// Which engine policy a user runs under.
export function policyIdForUser(user) {
  return user?.role === 'admin' ? 'admin' : 'plugin_tenant';
}

// Whether `force` (skip a red gate / merge a red check) is allowed for this
// policy — callers pass the client's requested force through here.
export function forceAllowed(policyId, requested) {
  return !!requested && !!resolvePolicy(policyId).allowForce;
}

// Throw 429 if the user has already hit the policy's per-hour ceiling for
// this action. No-op for a policy with an infinite cap (admin).
export async function assertWithinVelocity(userId, policyId, actionType) {
  const p = resolvePolicy(policyId);
  if (!Number.isFinite(p.maxTurnsPerHour)) return;
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const n = await prisma.usageRecord.count({
    where: { created_by_id: userId, action_type: actionType, created_date: { gte: since } },
  });
  if (n >= p.maxTurnsPerHour) {
    throw Object.assign(
      new Error(`Rate limit reached — ${p.maxTurnsPerHour} of these per hour. Try again shortly.`),
      { status: 429, code: 'POLICY_VELOCITY' },
    );
  }
}

// Throw 403 if the policy restricts which repos a tenant may target and the
// caller's GitHub token can't push to `repoFullName`. `null` allow-list
// (admin) → always allowed.
export async function assertRepoAllowed(token, repoFullName, policyId) {
  const p = resolvePolicy(policyId);
  if (!p.repoAllowList) return;

  if (Array.isArray(p.repoAllowList)) {
    if (!p.repoAllowList.includes(repoFullName)) {
      throw Object.assign(new Error(`${repoFullName} is not on the allow-list.`), { status: 403, code: 'POLICY_REPO' });
    }
    return;
  }

  // 'token-push-access' — the tenant may only target repos their own token
  // actually has push rights on.
  const res = await fetch(`${GH_API}/repos/${repoFullName}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Morpheus' },
  });
  if (!res.ok) {
    throw Object.assign(
      new Error(`Can't verify your access to ${repoFullName} (GitHub returned ${res.status}).`),
      { status: 403, code: 'POLICY_REPO' },
    );
  }
  const data = await res.json().catch(() => ({}));
  if (!data?.permissions?.push) {
    throw Object.assign(
      new Error(`Your GitHub account doesn't have push access to ${repoFullName}.`),
      { status: 403, code: 'POLICY_REPO' },
    );
  }
}
