// The delivery-posture picker's behaviour, as rules rather than markup.
//
// Run:  node --test src/lib/postureChoice.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { componentsForPosture, selectionSummary, selectionSentence, postureBadge } from './postureChoice.js';
import {
  DELIVERY_POSTURES, getPosture, postureOf, stackRequirement, DEFAULT_COMPONENTS,
} from '../../base44/shared/infrastructureComponents.ts';

const deps = { postureOf, stackRequirement };

test('choosing a posture replaces all five selections, not just the host', () => {
  const selfHosted = getPosture('self-hosted');
  const picked = componentsForPosture(selfHosted);
  assert.deepEqual(picked, selfHosted.components);
  // The bug this prevents: setting only api_host and leaving the database in the cloud, which is the
  // incoherent stack the whole feature exists to stop.
  assert.equal(picked.database, 'sqlite-local');
  assert.equal(picked.api_host, 'standalone');
});

test('the returned selections are a copy, so a posture constant cannot be corrupted', () => {
  const posture = getPosture('cloud');
  const picked = componentsForPosture(posture);
  picked.database = 'sqlite-local';
  assert.equal(posture.components.database, 'supabase-pg');
  assert.equal(getPosture('cloud').components.database, 'supabase-pg');
});

test('an unknown or absent posture yields nothing rather than a default stack', () => {
  // Returning DEFAULT_COMPONENTS here would mean a picker that failed to load silently selects cloud.
  assert.equal(componentsForPosture(null), null);
  assert.equal(componentsForPosture(undefined), null);
  assert.equal(componentsForPosture({ components: null }), null);
});

test('a self-contained preset is reported as needing nobody', () => {
  for (const id of ['self-hosted', 'container']) {
    const summary = selectionSummary({ components: componentsForPosture(getPosture(id)), ...deps });
    assert.equal(summary.selfContained, true, `${id} should be self-contained`);
    assert.deepEqual(summary.needsAccounts, []);
    assert.equal(summary.matchesPreset, id);
    assert.match(selectionSentence(summary), /runs on your own machine/);
    assert.equal(postureBadge(summary), 'no accounts needed');
  }
});

test('the managed preset names every account it needs, and does not cry wolf', () => {
  const summary = selectionSummary({ components: componentsForPosture(getPosture('cloud')), ...deps });
  assert.equal(summary.selfContained, false);
  assert.equal(summary.matchesPreset, 'cloud');
  assert.equal(summary.needsAccounts.length, 4);
  const said = selectionSentence(summary);
  assert.match(said, /needs an account with/);
  // It MATCHES the preset, so the accounts are the chosen outcome — not a warning.
  assert.doesNotMatch(said, /no longer matches/);
});

test('an operator who edits into a mixed stack is told it may not run', () => {
  // The coherence case: self-hosted host, cloud database. This is selectable today and is exactly what
  // the feature has to surface, because nothing else in the product adds the services up.
  const summary = selectionSummary({
    components: { api_host: 'self-hosted-docker', database: 'supabase-pg', auth: 'jwt-self', file_storage: 'local', cache: 'none' },
    ...deps,
  });
  assert.equal(summary.selfContained, false);
  assert.equal(summary.matchesPreset, null);
  assert.deepEqual(summary.needsAccounts.map((n) => n.id), ['supabase-pg']);
  const said = selectionSentence(summary);
  assert.match(said, /no longer matches a preset, so check it can actually run/);
});

test('the badge counts accounts, singular and plural', () => {
  assert.equal(postureBadge({ selfContained: false, needsAccounts: [{ label: 'A' }] }), '1 account needed');
  assert.equal(postureBadge({ selfContained: false, needsAccounts: [{ label: 'A' }, { label: 'B' }] }), '2 accounts needed');
  assert.equal(postureBadge({ selfContained: true, needsAccounts: [] }), 'no accounts needed');
});

test('no sentence is produced for a missing summary, rather than a misleading one', () => {
  assert.equal(selectionSentence(null), '');
  assert.equal(selectionSentence(undefined), '');
});

test('the default stack is a preset, so a fresh panel shows a selected state', () => {
  // Not asserting WHICH preset — only that the initial screen is not blank of selection, which is what
  // `useState(postureOf(DEFAULT_COMPONENTS))` relies on.
  assert.ok(DEFAULT_COMPONENTS);
  const initial = postureOf(DEFAULT_COMPONENTS);
  assert.ok(DELIVERY_POSTURES.some((p) => p.id === initial), `expected the default stack to match a preset, got ${initial}`);
});
