// The CLAP plugin source Morpheus generates, as text.
//
// WHY THIS IS A SEPARATE MODULE. `audio-plugin.js` is the target's logic — validate, scaffold, build
// steps — and the other nine targets keep that logic readable by not burying a few hundred lines of
// generated source inside it. The templates live here as plain exported functions, so both modules stay
// pure (no fs, no imports beyond each other) and the guard can exercise them without a build.
//
// THE SOURCE IS NOT INVENTED. Every line here was compiled, wrapped into VST3 + AU + standalone, and
// loaded through a host-style dlopen harness before being written down (see the spike in the workspace).
// Three things in it are corrections of mistakes that cost a cycle each, and they are called out inline
// because a future edit will otherwise reintroduce them:
//
//   1. `plugin_data` and `calloc()` are `void *`, so C++ requires an explicit cast at every use.
//   2. There is NO CLAP parameter event space — param events live in CLAP_CORE_EVENT_SPACE_ID and are
//      identified by CLAP_EVENT_PARAM_VALUE.
//   3. The SDK's own `plugin-template.c` ships with `// TODO: add support to CLAP_EXT_PARAMS`. Parameters
//      are the part that is genuinely ours, and a plugin without them is not a usable starting point.

/** Four printable ASCII characters, no spaces — the AU 'subtype'/'manufacturer' code format. */
export function fourCharCode(input, fallback = 'Morp') {
  const clean = String(input || '').replace(/[^A-Za-z0-9]/g, '');
  if (clean.length >= 4) return clean.slice(0, 4);
  return (clean + fallback).slice(0, 4);
}

/**
 * A stable plugin identifier from a human name: `Morpheus Gain` -> `nz.morpheus.gain`.
 *
 * The id is what a host stores in a saved session, so it must be stable across rebuilds or every project
 * that used the plugin loses its settings. Derived from the name rather than random, and the caller can
 * override it.
 */
export function pluginId(name) {
  const slug = String(name || 'plugin')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '') || 'plugin';
  // The reverse-DNS prefix is Morpheus's, not the vendor's: this id is what a host stores in a saved
  // session, and the plugin's own vendor is a separate field. `nz.morpheus.<slug>` is stable, and the
  // manifest lets a user replace it entirely.
  return `nz.morpheus.${slug}`;
}

/**
 * A four-character AU subtype for a plugin name.
 *
 * WHY THE CHECKSUM CHARACTER. The obvious `first four letters` derivation produced "Morp" for a plugin
 * called "Morpheus Plugin" — identical to the manufacturer code, and identical for every plugin whose name
 * begins the same way. Since a duplicate subtype makes one plugin silently shadow another in Logic, three
 * readable characters plus one derived from the whole name is worth the small loss of prettiness.
 */
export function auSubtypeCode(name) {
  const clean = String(name || '').replace(/[^A-Za-z0-9]/g, '');
  const head = (clean + 'Plug').slice(0, 3);
  let h = 0;
  for (let i = 0; i < clean.length; i++) h = (h * 31 + clean.charCodeAt(i)) >>> 0;
  const tail = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[h % 26];
  return head + tail;
}

/** The CLAP implementation: one stereo gain stage with one real parameter. */
export function pluginSource({ name, vendor, id, paramName = 'Gain', description = '' }) {
  const safeName = JSON.stringify(String(name));
  const safeVendor = JSON.stringify(String(vendor));
  const safeId = JSON.stringify(String(id));
  const safeDesc = JSON.stringify(String(description || `${name} — built with Morpheus.`));
  const safeParam = String(paramName).replace(/"/g, '\\"');

  return `// ${name} — a CLAP audio effect.
//
// Built by Morpheus. This file is yours: edit it freely, and the build picks up your changes.
//
// ONE SOURCE, FOUR FORMATS. This is a CLAP plugin; the build wraps it into VST3, AU and a standalone app
// from this same file, so a change here reaches every format at once.
//
// SPDX-License-Identifier: MIT
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <clap/clap.h>

static const clap_plugin_descriptor_t s_desc = {
   .clap_version = CLAP_VERSION_INIT,
   .id = ${safeId},
   .name = ${safeName},
   .vendor = ${safeVendor},
   .url = "https://morpheus.nz",
   .manual_url = "https://morpheus.nz",
   .support_url = "https://morpheus.nz",
   .version = "1.0.0",
   .description = ${safeDesc},
   .features = (const char *[]){CLAP_PLUGIN_FEATURE_AUDIO_EFFECT, CLAP_PLUGIN_FEATURE_STEREO, NULL},
};

// ── parameters ───────────────────────────────────────────────────────────────────────────────────────
// The id must not be 0: CLAP_INVALID_ID means "no parameter", so a host treats an event carrying id 0 as
// malformed. Add parameters by extending this enum and the three functions below.
enum { PARAM_${safeParam.toUpperCase().replace(/[^A-Z0-9]/g, '_') || 'GAIN'} = 1 };

static const double PARAM_MIN = -60.0;
static const double PARAM_MAX = 12.0;
static const double PARAM_DEFAULT = 0.0;

static inline double db_to_linear(double db) { return pow(10.0, db / 20.0); }

typedef struct {
   clap_plugin_t plugin;
   const clap_host_t *host;

   // The value the host and the user see, in dB.
   double value;
   // What process() actually applies, moved one step per sample. Keeping these apart is what stops a
   // parameter jump from clicking, which is the first audible bug in almost every new plugin.
   double smoothed;
} ${'plugin_t'};

// ── audio ports ──────────────────────────────────────────────────────────────────────────────────────
static uint32_t audio_ports_count(const clap_plugin_t *plugin, bool is_input) { return 1; }

static bool audio_ports_get(const clap_plugin_t *plugin, uint32_t index, bool is_input,
                            clap_audio_port_info_t *info) {
   if (index > 0) return false;
   info->id = is_input ? 0 : 1;
   snprintf(info->name, sizeof(info->name), "%s", is_input ? "Input" : "Output");
   info->channel_count = 2;
   info->flags = CLAP_AUDIO_PORT_IS_MAIN;
   info->port_type = CLAP_PORT_STEREO;
   info->in_place_pair = CLAP_INVALID_ID;
   return true;
}

static const clap_plugin_audio_ports_t s_audio_ports = {
   .count = audio_ports_count,
   .get = audio_ports_get,
};

// ── the params extension (what the SDK's own template leaves as a TODO) ──────────────────────────────
static uint32_t params_count(const clap_plugin_t *plugin) { return 1; }

static bool params_get_info(const clap_plugin_t *plugin, uint32_t index, clap_param_info_t *info) {
   if (index != 0) return false;
   memset(info, 0, sizeof(*info));
   info->id = 1;
   info->flags = CLAP_PARAM_IS_AUTOMATABLE;
   snprintf(info->name, sizeof(info->name), "%s", "${safeParam}");
   snprintf(info->module, sizeof(info->module), "%s", "");
   info->min_value = PARAM_MIN;
   info->max_value = PARAM_MAX;
   info->default_value = PARAM_DEFAULT;
   return true;
}

static bool params_get_value(const clap_plugin_t *plugin, clap_id id, double *out) {
   // plugin_data is void*, so C++ needs the cast spelled out. This is the most common first compile error.
   const ${'plugin_t'} *p = (const ${'plugin_t'} *)plugin->plugin_data;
   if (id != 1) return false;
   *out = p->value;
   return true;
}

static bool params_value_to_text(const clap_plugin_t *plugin, clap_id id, double value, char *out,
                                 uint32_t capacity) {
   if (id != 1) return false;
   snprintf(out, capacity, "%.2f dB", value);
   return true;
}

static bool params_text_to_value(const clap_plugin_t *plugin, clap_id id, const char *text,
                                 double *out) {
   if (id != 1) return false;
   char *end = NULL;
   const double v = strtod(text, &end);
   if (end == text) return false;  // nothing numeric was typed
   // Clamp rather than reject: a host that receives false here shows the user an error for typing "100",
   // which is an ordinary thing to type.
   *out = v < PARAM_MIN ? PARAM_MIN : (v > PARAM_MAX ? PARAM_MAX : v);
   return true;
}

static void apply_param_event(${'plugin_t'} *p, const clap_event_header_t *hdr) {
   // THERE IS NO PARAM EVENT SPACE. Parameter changes arrive in the CORE event space and are identified by
   // their type; assuming a dedicated space is a compile error, which is the good outcome.
   if (hdr->space_id != CLAP_CORE_EVENT_SPACE_ID || hdr->type != CLAP_EVENT_PARAM_VALUE) return;
   const clap_event_param_value_t *ev = (const clap_event_param_value_t *)hdr;
   if (ev->param_id != 1) return;
   const double v = ev->value;
   p->value = v < PARAM_MIN ? PARAM_MIN : (v > PARAM_MAX ? PARAM_MAX : v);
}

static void params_flush(const clap_plugin_t *plugin, const clap_input_events_t *in,
                         const clap_output_events_t *out) {
   ${'plugin_t'} *p = (${'plugin_t'} *)plugin->plugin_data;
   const uint32_t n = in->size(in);
   for (uint32_t i = 0; i < n; ++i) apply_param_event(p, in->get(in, i));
}

static const clap_plugin_params_t s_params = {
   .count = params_count,
   .get_info = params_get_info,
   .get_value = params_get_value,
   .value_to_text = params_value_to_text,
   .text_to_value = params_text_to_value,
   .flush = params_flush,
};

// ── the plugin ───────────────────────────────────────────────────────────────────────────────────────
static bool plug_init(const clap_plugin_t *plugin) {
   ${'plugin_t'} *p = (${'plugin_t'} *)plugin->plugin_data;
   p->value = PARAM_DEFAULT;
   p->smoothed = db_to_linear(PARAM_DEFAULT);
   return true;
}

static void plug_destroy(const clap_plugin_t *plugin) { free(plugin->plugin_data); }

static bool plug_activate(const clap_plugin_t *plugin, double sr, uint32_t min_frames,
                          uint32_t max_frames) { (void)sr; (void)min_frames; (void)max_frames; return true; }
static void plug_deactivate(const clap_plugin_t *plugin) {}
static bool plug_start_processing(const clap_plugin_t *plugin) { return true; }
static void plug_stop_processing(const clap_plugin_t *plugin) {}
static void plug_reset(const clap_plugin_t *plugin) {
   ${'plugin_t'} *p = (${'plugin_t'} *)plugin->plugin_data;
   p->smoothed = db_to_linear(p->value);
}
static void plug_on_main_thread(const clap_plugin_t *plugin) {}

static clap_process_status plug_process(const clap_plugin_t *plugin, const clap_process_t *process) {
   ${'plugin_t'} *p = (${'plugin_t'} *)plugin->plugin_data;
   const uint32_t nframes = process->frames_count;
   const uint32_t nev = process->in_events->size(process->in_events);

   uint32_t ev_index = 0;
   uint32_t next_ev_frame = nev > 0 ? 0 : nframes;

   for (uint32_t i = 0; i < nframes;) {
      while (ev_index < nev && next_ev_frame == i) {
         const clap_event_header_t *hdr = process->in_events->get(process->in_events, ev_index);
         if (hdr->time != i) { next_ev_frame = hdr->time; break; }
         apply_param_event(p, hdr);
         ++ev_index;
         if (ev_index == nev) { next_ev_frame = nframes; break; }
      }

      for (; i < next_ev_frame; ++i) {
         const double target = db_to_linear(p->value);
         const double in_l = process->audio_inputs[0].data32[0][i];
         const double in_r = process->audio_inputs[0].data32[1][i];
         // One smoothing step per sample. A production plugin would ramp over a fixed time; this is the
         // minimum that cannot click, and it is the right place to start.
         p->smoothed += (target - p->smoothed) * 0.001;
         process->audio_outputs[0].data32[0][i] = (float)(in_l * p->smoothed);
         process->audio_outputs[0].data32[1][i] = (float)(in_r * p->smoothed);
      }
   }
   return CLAP_PROCESS_CONTINUE;
}

static const void *plug_get_extension(const clap_plugin_t *plugin, const char *id) {
   if (!strcmp(id, CLAP_EXT_AUDIO_PORTS)) return &s_audio_ports;
   if (!strcmp(id, CLAP_EXT_PARAMS)) return &s_params;
   return NULL;
}

static const clap_plugin_t *factory_create(const clap_plugin_factory_t *factory,
                                           const clap_host_t *host, const char *plugin_id) {
   if (!clap_version_is_compatible(host->clap_version) || strcmp(plugin_id, s_desc.id)) return NULL;

   // calloc returns void*, which C++ will not convert implicitly — the cast is required, not style.
   ${'plugin_t'} *p = (${'plugin_t'} *)calloc(1, sizeof(*p));
   if (!p) return NULL;
   p->host = host;

   p->plugin.desc = &s_desc;
   p->plugin.plugin_data = (void *)p;
   p->plugin.init = plug_init;
   p->plugin.destroy = plug_destroy;
   p->plugin.activate = plug_activate;
   p->plugin.deactivate = plug_deactivate;
   p->plugin.start_processing = plug_start_processing;
   p->plugin.stop_processing = plug_stop_processing;
   p->plugin.reset = plug_reset;
   p->plugin.process = plug_process;
   p->plugin.get_extension = plug_get_extension;
   p->plugin.on_main_thread = plug_on_main_thread;
   return &p->plugin;
}

static uint32_t factory_count(const clap_plugin_factory_t *f) { return 1; }
static const clap_plugin_descriptor_t *factory_desc(const clap_plugin_factory_t *f, uint32_t index) {
   return index == 0 ? &s_desc : NULL;
}

static const clap_plugin_factory_t s_factory = {
   .get_plugin_count = factory_count,
   .get_plugin_descriptor = factory_desc,
   .create_plugin = factory_create,
};

// The wrapper's static library holds the implementation; the entry translation unit exports exactly one
// symbol. Kept separate so the bundle has a single \`clap_entry\`.
extern "C" {

bool morpheus_plugin_init(const char *plugin_path) { (void)plugin_path; return true; }
void morpheus_plugin_deinit(void) {}
const void *morpheus_plugin_get_factory(const char *factory_id) {
   return strcmp(factory_id, CLAP_PLUGIN_FACTORY_ID) ? NULL : &s_factory;
}

}  // extern "C"
`;
}

/** The one exported symbol. The host finds the plugin by this exact name, so it cannot be renamed. */
export function entrySource() {
  return `// The only symbol a CLAP bundle exports.
//
// \`clap_entry\` must be exactly this name with C linkage: a host resolves it with dlsym(), so a mangled or
// renamed symbol makes the plugin invisible with no error anywhere. The implementation lives in a static
// library (see CMakeLists.txt) so the bundle exports this and nothing else.
//
// SPDX-License-Identifier: MIT
#include <clap/clap.h>

extern "C" {

bool morpheus_plugin_init(const char *plugin_path);
void morpheus_plugin_deinit(void);
const void *morpheus_plugin_get_factory(const char *factory_id);

#ifdef __GNUC__
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wattributes"
#endif

const CLAP_EXPORT struct clap_plugin_entry clap_entry = {
    CLAP_VERSION,
    morpheus_plugin_init,
    morpheus_plugin_deinit,
    morpheus_plugin_get_factory,
};

#ifdef __GNUC__
#pragma GCC diagnostic pop
#endif

}  // extern "C"
`;
}

/** The CMake project: one CLAP source in, four formats out. */
export function cmakeLists({ name, id, version, auType, auSubtype, auManufacturer, auManufacturerName }) {
  return `# ${name} — built with Morpheus.
#
# ONE SOURCE, FOUR FORMATS. \`make_clapfirst_plugins\` takes the CLAP implementation in Source/ and produces
# a CLAP bundle, a VST3 bundle, an Audio Unit component and a standalone app from it. Everything it pulls
# in — clap-wrapper, the CLAP SDK, the VST3 SDK, Apple's AudioUnitSDK, RtAudio/RtMidi — is permissively
# licensed, so the plugin you build carries no licence obligation.
#
# Change the identity block below, not the machinery.

cmake_minimum_required(VERSION 3.21)

project(morpheus_plugin VERSION ${version} LANGUAGES C CXX)

# The standalone wrapper's macOS shell is Objective-C++, so the language must be enabled or configuration
# fails with "Missing variable is: CMAKE_OBJCXX_COMPILE_OBJECT" — an error that names CMake rather than the
# missing language.
if (APPLE)
  enable_language(OBJCXX)
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if (APPLE AND NOT CMAKE_OSX_DEPLOYMENT_TARGET)
  # FORCE, and the guard, are both load-bearing: CMake already puts CMAKE_OSX_DEPLOYMENT_TARGET in its
  # cache as an EMPTY string, and a plain \`set(... CACHE ...)\` will not overwrite an existing cache
  # entry. Without FORCE this line silently does nothing and a wrapper reading the variable sees "" —
  # which on at least one clap-wrapper version is a hard configure error. The build also passes
  # -DCMAKE_OSX_DEPLOYMENT_TARGET explicitly, so this only matters when you build the project by hand.
  set(CMAKE_OSX_DEPLOYMENT_TARGET "10.13" CACHE STRING "Minimum macOS version" FORCE)
endif()

# ── identity ─────────────────────────────────────────────────────────────────────────────────────────
set(PRODUCT_NAME ${JSON.stringify(name)})
set(BUNDLE_ID    ${JSON.stringify(id)})
set(PLUGIN_VERSION ${JSON.stringify(version)})

# The four-character AU codes. These are what the user sees and searches in Logic's plugin list, and a
# duplicate silently shadows another plugin, so they are derived from the plugin rather than copied.
set(AUV2_TYPE         ${JSON.stringify(auType)})
set(AUV2_SUBTYPE      ${JSON.stringify(auSubtype)})
set(AUV2_MANUFACTURER ${JSON.stringify(auManufacturer)})
set(AUV2_MANUFACTURER_NAME ${JSON.stringify(auManufacturerName)})

# ── the wrappers ─────────────────────────────────────────────────────────────────────────────────────
# CLAP_WRAPPER_DIR must point at a checkout of clap-wrapper; the build clones it. Downloading the SDKs at
# configure time is what makes this a single self-contained build with no vendored copies to go stale.
if (NOT DEFINED CLAP_WRAPPER_DIR)
  message(FATAL_ERROR "CLAP_WRAPPER_DIR is not set — point it at a clap-wrapper checkout.")
endif()
set(CLAP_WRAPPER_DOWNLOAD_DEPENDENCIES ON CACHE BOOL "" FORCE)
set(CLAP_WRAPPER_BUILD_AUV2 ON CACHE BOOL "" FORCE)
set(CLAP_WRAPPER_BUILD_STANDALONE ON CACHE BOOL "" FORCE)
set(CLAP_WRAPPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(CLAP_WRAPPER_BUILD_AAX OFF CACHE BOOL "" FORCE)
add_subdirectory(\${CLAP_WRAPPER_DIR} clap-wrapper)

# ── the plugin ───────────────────────────────────────────────────────────────────────────────────────
add_library(morpheus_plugin-impl STATIC Source/Plugin.cpp)
target_include_directories(morpheus_plugin-impl PRIVATE Source)
target_link_libraries(morpheus_plugin-impl PUBLIC clap clap-wrapper-extensions)

set(PLUGIN_FORMATS CLAP VST3 AUV2 WCLAP)
if (APPLE AND CMAKE_GENERATOR STREQUAL "Xcode")
    list(APPEND PLUGIN_FORMATS AUV3)
endif()

# STANDALONE_CONFIGURATIONS is not optional: CLAP_WRAPPER_BUILD_STANDALONE enables the machinery, and this
# argument is what actually asks for the app. Leaving it out produces a build with no standalone and no
# complaint. Syntax: <postfix> <output name> <clap id>
make_clapfirst_plugins(
        TARGET_NAME morpheus_plugin
        IMPL_TARGET morpheus_plugin-impl
        OUTPUT_NAME "\${PRODUCT_NAME}"
        ENTRY_SOURCE "Source/PluginEntry.cpp"
        BUNDLE_IDENTIFIER "\${BUNDLE_ID}"
        BUNDLE_VERSION \${PLUGIN_VERSION}
        COPY_AFTER_BUILD FALSE
        PLUGIN_FORMATS \${PLUGIN_FORMATS}
        ASSET_OUTPUT_DIRECTORY \${CMAKE_BINARY_DIR}/assets
        AUV2_MANUFACTURER_NAME "\${AUV2_MANUFACTURER_NAME}"
        AUV2_MANUFACTURER_CODE "\${AUV2_MANUFACTURER}"
        AUV2_SUBTYPE_CODE "\${AUV2_SUBTYPE}"
        AUV2_INSTRUMENT_TYPE "\${AUV2_TYPE}"
        STANDALONE_CONFIGURATIONS
        standalone "\${PRODUCT_NAME}" "\${BUNDLE_ID}"
)
`;
}
