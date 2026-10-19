// Toolchain manifest — records the exact SDK, runtime, and AI models that
// produced each build output. Stored in UsageRecord.metadata so it flows into
// the aggregated build logs (HistoryPanel + BUILD_LOG.md). This lets operators
// trace any output back to the toolchain that generated it and catch version-
// related errors before they propagate.

export const SDK_VERSION = '@base44/sdk@0.8.40';
export const RUNTIME = 'base44-deno';

// Client-side tool versions (used in the preview/export pipeline).
// These are the versions of the libraries that transpile, bundle, and export
// project files in the browser — the other half of the toolchain besides the
// AI models.
export const CLIENT_TOOLS: Record<string, string> = {
  babel: 'standalone@7',
  jszip: '3.10.1',
  react: '18.2.0',
};

export interface ToolchainInfo {
  sdk: string;
  runtime: string;
  provider: 'platform' | 'custom';
  planner_model?: string;
  coder_model?: string;
  reviewer_model?: string;
  client_tools?: Record<string, string>;
}

// Build a toolchain manifest for a build operation. Callers pass the models
// that were actually used (resolved from UserSettings role overrides) and the
// provider that served the request.
export function buildToolchain(
  provider: 'platform' | 'custom',
  models: { planner?: string; coder?: string; reviewer?: string }
): ToolchainInfo {
  return {
    sdk: SDK_VERSION,
    runtime: RUNTIME,
    provider,
    planner_model: models.planner,
    coder_model: models.coder,
    reviewer_model: models.reviewer,
    client_tools: CLIENT_TOOLS,
  };
}

// Parse a UsageRecord metadata string back into a structured toolchain object.
// Returns null if the metadata doesn't contain toolchain info.
export function parseToolchain(metadata: string): ToolchainInfo | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (parsed && parsed.sdk) {
      return {
        sdk: parsed.sdk,
        runtime: parsed.runtime,
        provider: parsed.provider,
        planner_model: parsed.planner_model,
        coder_model: parsed.coder_model,
        reviewer_model: parsed.reviewer_model,
        client_tools: parsed.client_tools,
      };
    }
  } catch {
    // metadata might be a plain string, not JSON
  }
  return null;
}