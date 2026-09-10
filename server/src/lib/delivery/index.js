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
//   verify({ files })                → { ok, errorCount, errors, checkedFiles }
//   ship({ user, files, directToMain, precheck }) → engine ship result (see engine/ship.js)
//   merge({ user, prNumber, force })  → engine merge result (see engine/merge.js)
//   rollback({ user, commitSha })     → { commitSha, revertedToSha, branch, commitUrl }
//   healthCheck({ user, target })     → { ok, checks: [{name, ok, detail}], failing }
//
// All five capabilities are implemented for 'self-dev'. The WordPress
// adapter reuses merge / rollback as-is (the PR lives on GitHub) and brings
// its own verify entry points, ship (webhook + PHP write) and healthCheck.

import { selfDevDelivery } from './selfDev.js';
import { wordpressDelivery } from './wordpress.js';

const ADAPTERS = {
  [selfDevDelivery.id]: selfDevDelivery,
  [wordpressDelivery.id]: wordpressDelivery,
};

export const DELIVERY_IDS = Object.keys(ADAPTERS);

export function getDeliveryAdapter(id) {
  const a = ADAPTERS[id];
  if (!a) throw Object.assign(new Error(`Unknown delivery adapter: ${id}`), { status: 400 });
  return a;
}

// For a project row: which adapter delivers it. Self-dev projects use
// 'self-dev'. A plugin-tenant project's adapter ('wordpress', later others)
// is resolved by the plugin-api from the tenant's connection, not from the
// project row — so everything else is still null here.
export function deliveryIdForProject(project) {
  return (project?.project_type === 'self_dev') ? 'self-dev' : null;
}
