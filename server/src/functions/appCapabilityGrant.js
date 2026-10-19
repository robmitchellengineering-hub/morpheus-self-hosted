// Approve ONE generated app to use ONE capability against the caller's own
// connected account — or list/revoke the approvals already given.
//
// Owner's decision, 2026-09-28, verbatim: "I think we need to make morpheus as a
// whole handle oauth and credentials like this so it will just work for free tier
// app creation or if it needs to be the other way he needs to say so and let
// people know the steps."
//
// This is the "approve once" half. `create` returns the token EXACTLY ONCE — it is
// never stored and cannot be recovered — and the response says, in the same breath,
// that the token belongs in the app's BACKEND and not in its pages. That sentence is
// not decoration: a token that can write to the caller's Drive, shipped in a public
// page, is readable and usable by anyone who opens it, which is why the build-time
// honesty text sends a static app down the own-OAuth-client route instead.
//
// `capabilities` is filtered against lib/appCapability.js's registry, so a caller
// cannot mint a grant carrying a capability the endpoint would refuse.
import { prisma } from '../db.js';
import { APP_CAPABILITIES, grantWarning } from '../lib/appCapability.js';
import {
  createCapabilityGrant, listCapabilityGrants, revokeCapabilityGrant, isMissingGrantTable, GRANTS_TABLE_MISSING_MESSAGE,
} from '../lib/appCapabilityGrants.js';

export default async function handler({ user, body }) {
  const { projectId, action = 'create', grantId, label, capabilities } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  try {
    if (action === 'list') {
      return {
        grants: await listCapabilityGrants(projectId, user.id),
        known: Object.keys(APP_CAPABILITIES),
      };
    }
    if (action === 'revoke') {
      if (!grantId) throw Object.assign(new Error('grantId required to revoke.'), { status: 400 });
      return await revokeCapabilityGrant(grantId, projectId, user.id);
    }
    if (action !== 'create') {
      throw Object.assign(new Error('action must be one of create, list, revoke.'), { status: 400 });
    }

    const granted = Array.isArray(capabilities) && capabilities.length ? capabilities : ['drive_upload'];
    const created = await createCapabilityGrant(projectId, user.id, {
      label: label || `${project.name} — app capability`,
      capabilities: granted,
    });
    return {
      ...created,
      // Shown once, on screen, at the moment it exists. The wording is the same
      // fact the README and the UI carry, so an operator reading either learns the
      // same thing about where this value may live.
      warning: grantWarning(granted),
      endpoint: '/api/app-capability',
      appId: created.appId,
    };
  } catch (err) {
    if (isMissingGrantTable(err)) throw Object.assign(new Error(GRANTS_TABLE_MISSING_MESSAGE), { status: 503, code: 'GRANTS_NOT_MIGRATED' });
    throw err;
  }
}
