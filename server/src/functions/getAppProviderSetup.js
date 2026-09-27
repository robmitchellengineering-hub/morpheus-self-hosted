// Read the provider-setup verdict for a project, for the compile UI.
//
// WHY IT EXISTS: the build already writes the correct one of the two messages into
// the app's own README, but a README is not where an operator looks while they are
// pressing COMPILE — and the whole point of the honesty half is that Morpheus says
// which mode the app is in BEFORE anyone runs it. This is the same report, from the
// same function (lib/appCapabilitySetup.js → lib/appCapability.js), so the panel
// and the README cannot say different things about the same app.
//
// Read-only, and owner-scoped like every other project read.
import { readProviderSetup } from '../lib/appCapabilitySetup.js';

export default async function handler({ user, body }) {
  const { projectId } = body || {};
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const report = await readProviderSetup(projectId, user.id);
  if (!report) throw Object.assign(new Error('Project not found'), { status: 404 });

  // The app_id is only worth showing when there is something the operator can
  // actually grant — it is what they pass to appCapabilityGrant to mint the token
  // an app's backend uses, and it is deliberately not a project id.
  return report;
}
