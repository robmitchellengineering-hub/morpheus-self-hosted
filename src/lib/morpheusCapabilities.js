// Re-export the JSON source of truth so app code imports a stable JS API.
// The JSON file (src/lib/morpheusCapabilities.json) is the single source of
// truth — edit it to add or change a capability. The load screen reads from
// here, and `scripts/sync-capabilities.mjs` regenerates the design-plan doc
// from the same JSON on every build (npm prebuild hook).
import data from './morpheusCapabilities.json';

export const MORPHEUS_PRINCIPLE = data.principle;
export const MORPHEUS_CAPABILITIES = data.capabilities;