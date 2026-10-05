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
// Where this is going, as opposed to what ships today: the "digital possibility engine"
// framing, rendered on the landing page and published to machines by scripts/seo-static.mjs.
// It lives in the JSON beside the capability list for the same reason everything else does —
// one source, so the page and the prerender cannot say different things.
export const MORPHEUS_POSSIBILITY = data.possibility;
// The audio pathway, in more detail than one capability line can carry: which machine each route builds
// for, how to use it, what the build measures, and — as its own list, never as a hedge inside a sentence
// — what is on the bench rather than shipped. The landing page renders it above the capability box, and
// scripts/seo-static.mjs publishes the same object to the prerender, llms.txt and llms-full.txt, so a
// reader and a crawler get one text. The SECTION HEADINGS are typed out at both call sites rather than
// carried here: the prose-ink rule (scripts/verify-prose-ink.mjs) attributes a green label to the text
// where it is written, so a heading that arrived at runtime would fail the build.
export const MORPHEUS_AUDIO = data.audio;