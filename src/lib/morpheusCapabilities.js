// Re-export the JSON source of truth so app code imports a stable JS API.
// The JSON file (src/lib/morpheusCapabilities.json) is the single source of
// truth — edit it to add or change a capability. The load screen reads from
// here, and `scripts/sync-capabilities.mjs` regenerates the design-plan doc
// from the same JSON on every build (npm prebuild hook).
import data from './morpheusCapabilities.json';

export const MORPHEUS_PRINCIPLE = data.principle;
export const MORPHEUS_CAPABILITIES = data.capabilities;
// The compile targets Morpheus offers. Mirrors server/src/lib/compile-targets/ — the
// landing page and the build-time SEO prerender both read it from here, and
// scripts/verify-seo-static.mjs fails if this list and that directory disagree, because
// the two drifting apart is exactly how the explainer docs came to say "6 platforms"
// while the code shipped ten.
export const MORPHEUS_BUILD_TARGETS = data.buildTargets || [];
export const MORPHEUS_INTRO = data.intro;
export const MORPHEUS_CLOSING = data.closing;