// Ported from base44/shared/toolchain.ts — records exactly which
// provider/models produced a given build step, attached to UsageRecord
// metadata and surfaced in the History panel's BUILD LOGS tab.
//
// Field names here (sdk/runtime/provider/planner_model/coder_model/
// reviewer_model/client_tools) must match what lib/buildLogs.js's
// parseToolchain()/generateBuildLogMarkdown() read back out of stored
// UsageRecord metadata — a 2026-08-26 audit found an earlier version of
// this file used a different shape ({sdk, client, provider, models:{...}}),
// which meant every build event's toolchain/AI-model attribution silently
// went blank in the History panel and BUILD_LOG.md even though the data
// had been captured. Keep this in sync with buildLogs.js if either changes.
const SDK_VERSION = 'morpheus-self-hosted@1.0.0';
const RUNTIME = 'node';
const CLIENT_TOOLS = { react: '18.2.0', vite: 'latest', jszip: '3.10.1' };

export function buildToolchain(provider, models) {
  const m = models || {};
  return {
    sdk: SDK_VERSION,
    runtime: RUNTIME,
    provider,
    planner_model: m.planner,
    coder_model: m.coder,
    reviewer_model: m.reviewer,
    client_tools: CLIENT_TOOLS,
  };
}
