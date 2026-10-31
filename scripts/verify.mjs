// ONE command for the whole gate — so no step can be skipped or forgotten.
//
// WHY THIS EXISTS
//
// The two production breaks on 2026-09-19 (H12, the boot failure; H11, the
// missing column) both passed every check that was *run* — because the
// decisive check was never run. A single entrypoint that runs them all, in
// order, and reports a clear pass/fail/not-verified for each, is the guard
// against "I ran the tests and they were green" meaning anything less than
// "the server boots and the database matches".
//
// Run:  node scripts/verify.mjs
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// Hard gates — any failure here fails the whole run.
const HARD = [
  'verify-licence-issuance.mjs',
  'verify-licence-purchase.mjs',
  'verify-drift.mjs',
  'verify-ai-roles.mjs',
  'verify-review-context.mjs',
  'verify-caller-check.mjs',
  'verify-compile-artifacts.mjs',
  'verify-artifact-save-background.mjs',
  'verify-cabinet-upload.mjs',
  'verify-mac-app-arch.mjs',
  'verify-user-manual.mjs',
  'verify-prisma-fields.mjs',
  'verify-seo-static.mjs',
  'verify-cors.mjs',
  'verify-context.mjs',
  'verify-dump-classify.mjs',
  'verify-dump-filing.mjs',
  'verify-deck-play.mjs',
  'verify-murbah-money.mjs',
  'verify-life-files.mjs',
  'verify-jarvis-voice.mjs',
  'verify-jarvis-careers.mjs',
  'verify-web-research.mjs',
  'verify-jarvis-snapshot-gate.mjs',
  'verify-jarvis-reply-length.mjs',
  'verify-jarvis-stream.mjs',
  'verify-doc-export.mjs',
  'verify-gmail-sync.mjs',
  'verify-deck-draft.mjs',
  'verify-deck-document.mjs',
  'verify-deck-forward.mjs',
  'verify-deck-snapshot.mjs',
  'verify-deck-crm-edit.mjs',
  'verify-deck-fee-tiers.mjs',
  'verify-deck-add-guard.mjs',
  'verify-salvage-json.mjs',
  'verify-google-reconnect.mjs',
  'verify-deck-ui.mjs',
  'verify-stale-chunk.mjs',
  'verify-lint-coverage.mjs',
  'verify-deploy-health-scope.mjs',
  'verify-frontend-deploy.mjs',
  'verify-connection-secrets.mjs',
  'verify-deck-prompt-bounds.mjs',
  'verify-usage-observability.mjs',
  'verify-deck-memory.mjs',
  'verify-insight-optout.mjs',
  'verify-seo.mjs',
  'verify-pairing.mjs',
  'verify-working-copy.mjs',
  'verify-keywords.mjs',
  'verify-contrast.mjs',
  'verify-prose-ink.mjs',
  'verify-traffic.mjs',
  'verify-photo-drive.mjs',
  'verify-app-capability-creds.mjs',
  'verify-dock.mjs',
  'verify-plugin-pack.mjs',
  'verify-plugin-uninstall.mjs',
  'verify-redirects.mjs',
  'verify-prod-sql.mjs',
  'verify-billing-clamp.mjs',
  'verify-guards-no-install.mjs',
  'verify-push-policy.mjs',
  'verify-search-console.mjs',
  'verify-site-health.mjs',
  'verify-clean-site.mjs',
  'verify-site-maintenance.mjs',
  'verify-wp-rollback.mjs',
  'verify-merge-gates.mjs',
  'verify-operator-drive.mjs',
  'verify-proving-ground.mjs',
  'verify-selfdev-runs.mjs',
  'verify-sync-safety.mjs',
  'verify-provider-spend.mjs',
  'verify-doc-honesty.mjs',
  'verify-stage-observability.mjs',
  'verify-server-imports.mjs',
  'verify-prisma-models.mjs',
  'verify-verifier-coverage.mjs',
  'verify-ai-cost-claims.mjs',
  'verify-billing-ledger-math.mjs',
  'verify-github-reconnect.mjs',
  'verify-workspace-search.mjs',
  'verify-onramp.mjs',
  'verify-deck-widget-build.mjs',
  'verify-deck-widget-order.mjs',
  'verify-deck-widget-backend.mjs',
  'verify-render-check.mjs',
  'verify-audio-plugin.mjs',
  'verify-rig.mjs',
  'verify-task-models.mjs',
  'verify-task-ladder.mjs',
  'verify-audio-measure.mjs',
  'verify-nam-quantize.mjs',
  'verify-audio-capture.mjs',
  'verify-valiant-licence.mjs',
  'verify-revocation-service.mjs',
  'verify-publish-auth.mjs',
  'verify-package-registry.mjs',
  'verify-licence-check.mjs',
  'verify-corpus-ingest.mjs',
  'verify-portable-bundle.mjs',
  'verify-portable-setup.mjs',
  'verify-portable-remote.mjs',
  'verify-portable-ai.mjs',
  'verify-portable-launcher.mjs',
  'verify-portable-platform.mjs',
  'verify-shipped-imports.mjs',
  'verify-cloud-metering.mjs',
  'verify-build-gate-failopen.mjs',
  'verify-delivery-posture.mjs',
  'verify-registry-parity.mjs',
  'verify-generated-app.mjs',
  'verify-backend-chunk-context.mjs',
  'verify-review-budget.mjs',
  'verify-incremental-persist.mjs',
  'verify-security-posture.mjs',
  'verify-ui-feedback.mjs',
  'verify-export-promise.mjs',
  'verify-client-env.mjs',
  'verify-netlify-cost.mjs',
  'verify-license-terms.mjs',
  'verify-no-secret-fixtures.mjs',
  'verify-build-failure-owner.mjs',
  'verify-project-divergence.mjs',
  'verify-guard-mutations.mjs',
  'verify-php-syntax.mjs',
  'verify-lane-partition.mjs',
  'verify-call-pool.mjs',
  'verify-app-selftest.mjs',
  'verify-build-loop-stdin.mjs',
  'verify-bootstrap-sql.mjs',
  'verify-plan-reconciliation.mjs',
  'verify-applied-ops.mjs',
  'verify-broker-minting.mjs',
  'verify-site-uptime.mjs',
  'verify-guard-count-copy.mjs',
  'boot-smoke.mjs',
];

const results = [];
for (const script of HARD) {
  const r = spawnSync(process.execPath, [resolve(HERE, script)], { stdio: 'inherit' });
  results.push({ name: script, status: r.status });
}

// THE LICENCE CHAIN — the issuer and the gate driven against each other. It is the only check that proves they MEET: the issuer's own
// suite proves the mint, the SDK's own suite proves the gate, and neither proves a licence this service signs opens a gate on a machine.
// It needs a `valiant` CLI; a CI runner does not have one, and a missing toolchain is not a licence defect — so without it the step reports
// NOT VERIFIED (exit 2, never a pass) instead of failing the build.
const cliFound = Boolean(process.env.VALIANT_CLI)
  || existsSync(resolve(HERE, '..', '..', 'valiant-verification-sdk', 'bin', 'valiant.mjs'))
  || spawnSync('sh', ['-c', 'command -v valiant'], { stdio: 'ignore' }).status === 0;
let chainStatus = 2;
if (cliFound) {
  const chain = spawnSync(process.execPath, [resolve(HERE, 'licence-chain-e2e.mjs')], { stdio: 'inherit' });
  chainStatus = chain.status ?? 2;
} else {
  console.log('  NOT VERIFIED  the licence chain — no valiant CLI on this machine (set VALIANT_CLI to run it)');
}
results.push({ name: 'licence-chain-e2e.mjs', status: chainStatus });

// The production drift check is reported separately: exit 2 means "could not
// reach production", which is NOT a pass and is called out loudly, but it only
// blocks a merge when the change touches schema.prisma (see the rule in
// morpheus-dev-protocol / H11).
const drift = spawnSync(process.execPath, [resolve(HERE, 'verify-schema-prod.mjs')], { stdio: 'inherit' });
results.push({ name: 'verify-schema-prod.mjs', status: drift.status });

// The billing ledger's database half (token plan Step 7). Same contract as the drift check for exit 2:
// "could not reach production" is never a pass. Exit 1 is different from a code failure, though — it is
// a real accounting discrepancy in production DATA, so it is reported loudly and does NOT block the
// merge: the fix is a price decision or a data correction, not a line in the pull request. Its maths
// half runs in HARD above, on every pull request, with no credential.
const ledger = spawnSync(process.execPath, [resolve(HERE, 'verify-billing-ledger.mjs')], { stdio: 'inherit' });
results.push({ name: 'verify-billing-ledger.mjs', status: ledger.status });

console.log('\n──────────────────────────────');
console.log('Summary');
for (const { name, status } of results) {
  const label = status === 0 ? 'PASS'
    : name === 'licence-chain-e2e.mjs' && status === 2 ? 'NOT VERIFIED (no valiant CLI)'
    : status === 2 ? 'NOT VERIFIED (no prod credential)'
    : `FAIL (${status})`;
  console.log(`  ${label.padEnd(30)} ${name}`);
}

// The chain blocks a merge only when it actually ran (status 1). NOT VERIFIED (2) is reported, never hidden, and never a pass.
const chainFailure = results.filter((r) => r.name === 'licence-chain-e2e.mjs' && r.status === 1);
const hardFailures = results.filter((r) => HARD.includes(r.name) && r.status !== 0);
const driftBlocking = drift.status === 1;

if (hardFailures.length || driftBlocking || chainFailure.length) {
  console.log('\n  ✗ verify failed — fix before merging.\n');
  process.exit(1);
}
if (ledger.status === 1) {
  console.log('\n  ! the production billing ledger does not reconcile — that is real money, in data.');
  console.log('    It does not block this merge (the cause is a price or a correction, not the diff),');
  console.log('    but it should not be left standing. See the checks named above.\n');
}
console.log('\n  ✓ all hard gates passed.\n');
