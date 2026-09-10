// Delivery adapters (2026-09-10) — one per way a merged change reaches a
// live site. Self-dev's push → PR → auto-merge → Northflank deploy → smoke
// check → revert is the first adapter ('self-dev'); the WordPress plugin
// webhook will be the second. The shared engine calls the adapter; adding a
// host is a new adapter file here, never a change to the engine.
//
// See the "Self-Dev as a Plugin" scope doc, §"Delivery adapters".
//
// A DeliveryAdapter is:
//   id            string                     — stable key
//   label         string
//   describe()    → {...} metadata            — repo, branch, preview/ship/rollback kind
//   healthCheck({ user, target }) → { ok, checks: [{name, ok, detail}], failing }
//   ship(...)     — land the change (added when the logic moves out of functions/)
//   merge(...)    — bring it to the deploy branch
//   rollback(...) — restore the previous state
//
// Only `describe` and `healthCheck` are implemented in every adapter today.
// `ship` / `merge` / `rollback` arrive with the shared-engine extraction,
// where the self-dev functions' logic moves into lib/ and both self-dev and
// the plugin call it through here.

import { selfDevDelivery } from './selfDev.js';

const ADAPTERS = {
  [selfDevDelivery.id]: selfDevDelivery,
};

export const DELIVERY_IDS = Object.keys(ADAPTERS);

export function getDeliveryAdapter(id) {
  const a = ADAPTERS[id];
  if (!a) throw Object.assign(new Error(`Unknown delivery adapter: ${id}`), { status: 400 });
  return a;
}

// For a project row: which adapter delivers it. Self-dev projects use
// 'self-dev'; everything else has no delivery adapter yet (previews/deploy
// still go through the per-project host config until the extraction lands).
export function deliveryIdForProject(project) {
  return (project?.project_type === 'self_dev') ? 'self-dev' : null;
}
