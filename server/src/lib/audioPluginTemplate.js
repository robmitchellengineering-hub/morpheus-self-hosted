// The CLAP plugin source Morpheus generates, as text.
//
// IT LIVES OUTSIDE server/src/lib/compile-targets/ ON PURPOSE. That directory's contents ARE the target
// list — scripts/verify-seo-static.mjs derives the published buildTargets by listing the .js files in it —
// so a helper sitting there is counted as an eleventh target and the published list disagrees with the
// code. A template is not a target, so it does not live with them.
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

import {
  GATE_OFF_DB, PLAIN_CHAIN, blocksCpp, chainHas, chainParamsStable, eventCpp, gateDspCpp, legacyCabCpp,
  gateInitCpp, gateStageCpp, initCpp, paramsCpp, smoothCpp, smoothOneCpp, stageDispatchCpp, stageTableCpp,
  stateCpp, toneCpp, toneUpdateCpp,
} from './ampChain.js';
// The band count only, for the two loops that reset filter state. The filters themselves are emitted by
// ampChain.js, which reads this same module so the design and the build cannot disagree.
import { TONE_KEYS } from './audio/toneStack.js';
// The cabinet's DSP text lives with the cabinet, the way the model's does. Both are processors that exist
// when a file does, not parameters of the chain.
import { cabDestroyCpp, cabDspCpp, cabInitCpp, cabRigDestroyCpp, cabRigDspCpp, cabRigInitCpp, cabRigStageCpp, cabRigStateCpp, cabStageCpp, cabStateCpp } from './cabIr.js';

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

/**
 * The CLAP implementation: one stereo gain stage with one real parameter.
 *
 * ⚠️ `modelInPath` AND `cabInPath` EXIST FOR THE BOARD AND DEFAULT TO TRUE, which is the whole trick: for
 * every project that predates `lib/board.js` they are true, so the emitted text is unchanged to the byte —
 * and a board is the only caller that can say "this project has a .nam but the model is not in the signal
 * path", which is what removing or bypassing the Amp model block means. The file being in the project and
 * the block being in the path stopped being the same question the moment a user could remove one.
 */
export function pluginSource({ name, vendor, id, description = '', chain = PLAIN_CHAIN, params = null, modelInPath = true, cabInPath = true, blocks = null }) {
  const safeName = JSON.stringify(String(name));
  const safeVendor = JSON.stringify(String(vendor));
  const safeId = JSON.stringify(String(id));
  const safeDesc = JSON.stringify(String(description || `${name} — built with Morpheus.`));
  // The chain decides which parameters exist and what the signal path does with them. A project that did not
  // ask for one gets the single-Gain plugin, unchanged — see lib/ampChain.js for why that matters.
  const list = params || chainParamsStable(chain, { paramName: 'Gain' });
  const hasTone = chainHas(chain, 'tone');
  // WHETHER THE MODEL IS A BLOCK, which is a different question from whether it is IN THE PATH. A model
  // BLOCK has an `on_model` switch and a dry buffer to fade against; a legacy project whose `.nam` is simply
  // in the tree has neither — it runs, as it always has, and there is nothing to switch.
  const modelSwitch = chainHas(chain, 'model');
  // ⭐ WHETHER THE PROJECT'S RIG OFFERS A CHOICE, which is encoded in the parameter list itself. `rigSelectors`
  // emits a selector only for two or more USABLE members (see ampChain.js), so the presence of the parameter
  // IS the question — this file never gets a second copy of the count that could disagree with the table the
  // plugin switches between, and the `MORPHEUS_RIG_*` macros in the generated headers carry the range.
  //
  // ⚠️ EVERY EMISSION BELOW THAT DEPENDS ON THESE IS A JS CONDITIONAL, NOT A C++ `#ifdef`. A `#ifdef` would
  // leave the extra text in a one-capture Plugin.cpp even when the preprocessor drops it, and a one-capture
  // project must stay byte-identical to what every existing proof measured (see namPlugin.js).
  const modelSelect = list.some((p) => p.role === 'select' && p.kind === 'model');
  const cabSelect = list.some((p) => p.role === 'select' && p.kind === 'cab');
  // ⭐ THE BLOCKS THAT ARE NOT PART OF AN AMP, HANDED IN RATHER THAN KNOWN HERE. `board.js` decides which
  // blocks a project has and what C++ each one contributes; this file interpolates the four fragments and
  // replaces each marker. Empty by default, which is what keeps every project that predates the board
  // generating the same text to the byte.
  const extra = blocks || {};
  const extraDsp = extra.dsp || '';
  const extraState = extra.state || '';
  const extraInit = extra.init || '';
  const extraDestroy = extra.destroy || '';
  const extraMarkers = extra.markers || {};
  // One pass over both emitted halves, so a block's marker is replaced wherever the chain put it — before the
  // model or after it, which is a choice the user makes and this file must not have an opinion about.
  const emitStages = (text) => {
    let out = text.replace('__GATE_STAGE__', gateStageCpp).replace('__CAB_STAGE__', cabSelect ? cabRigStageCpp : cabStageCpp);
    for (const [marker, cpp] of Object.entries(extraMarkers)) out = out.split(marker).join(cpp);
    return out;
  };

  // ⭐ THE RIG'S INDEX HELPERS, emitted only when the rig offers a choice. Both take the RAW parameter value
  // (not the smoothed one): a selector is discrete, so a smoothed ramp would sweep through the intermediate
  // captures on its way, and the ten-percent-of-a-value it passes through is audible as a burst of the wrong
  // amp. Empty for every project with no selector, which is what keeps a one-capture plugin byte-identical.
  const selectorHelpers = [
    (modelSelect || cabSelect) ? `
// ⚠️ A RIG NAME IS NOT "On"/"Off". \`morpheus_text_is\` above treats its second argument as a LOWERCASE word
// and stops when that word ends, which is exactly right for two fixed states and wrong twice over for a
// capture: "Clean" would never match its own text (the table keeps the player's capital), and it would match
// "Clean Boost" as a prefix — the wrong amp, silently. This compares case-insensitively on BOTH sides and
// requires the WHOLE name, allowing only trailing spaces.
static bool morpheus_text_is_name(const char *text, const char *name) {
   while (*text == ' ') ++text;
   for (; *name; ++text, ++name) {
      const char a = (*text >= 'A' && *text <= 'Z') ? (char)(*text - 'A' + 'a') : *text;
      const char b = (*name >= 'A' && *name <= 'Z') ? (char)(*name - 'A' + 'a') : *name;
      if (a != b) return false;
   }
   while (*text == ' ') ++text;
   return *text == '\\0';
}` : '',
    modelSelect ? `
#if MORPHEUS_HAS_MODEL
// ⭐ A SELECTOR'S VALUE IS AN INDEX INTO THE RIG TABLE, CLAMPED HERE RATHER THAN TRUSTED. A preset saved
// against a different rig can carry an index past the end of this one, and an out-of-range subscript would
// play the wrong capture rather than report anything. \`+ 0.5\` is the round-to-nearest a stepped control
// wants; the clamp is what makes the pattern total.
// ⚠️ AND THE COMPARISON GUARDS THE CONVERSION: \`(int)\` of a NaN is UNDEFINED, and \`apply_param_event\`'s
// clamp passes a NaN straight through — every comparison against it is false. A non-positive value is the
// first capture, which is both the default and the only answer that cannot read past the table.
static int morpheus_model_index(double v) {
   int i = (v > 0.0) ? (int)(v + 0.5) : 0;
   if (i >= MORPHEUS_RIG_MODELS) i = MORPHEUS_RIG_MODELS - 1;
   return i;
}
#endif` : '',
    cabSelect ? `
#if MORPHEUS_HAS_CAB
// ⭐ …and the same clamp for the cabinet half of the rig.
static int morpheus_cab_index(double v) {
   int i = (v > 0.0) ? (int)(v + 0.5) : 0;
   if (i >= MORPHEUS_RIG_CABS) i = MORPHEUS_RIG_CABS - 1;
   return i;
}
#endif` : '',
  ].filter(Boolean).join('\n');

  // ⭐ WHAT THE HOST READS IN AN AUTOMATION LANE. The selector's numeric value is an index, and the rig table
  // is the only thing that knows what that index is CALLED — so the name a player sees comes from the same
  // row the DSP selects, and the two cannot drift. Empty for every project with no selector.
  const selectorNames = `${modelSelect ? `   // ⭐ THE CAPTURE'S OWN NAME, FROM THE RIG TABLE, so an automation lane reads "Crunch" rather than "1".
   // The table is the same one the DSP switches between (see lib/namPlugin.js), so the name and the sound
   // cannot come from two different lists.
   if (kParams[ix].id == PARAM_MODEL_SELECT) {
      snprintf(out, capacity, "%s", kMorpheusRigModels[morpheus_model_index(value)].name);
      return true;
   }
` : ''}${cabSelect ? `   // ⭐ …and the SPEAKER'S name, for the cabinet half of the rig.
   if (kParams[ix].id == PARAM_CAB_SELECT) {
      snprintf(out, capacity, "%s", kMorpheusRigCabs[morpheus_cab_index(value)].name);
      return true;
   }
` : ''}`;

  // ⭐ AND THE OTHER DIRECTION. A host that round-trips text would otherwise be refused the very word this
  // plugin just printed — the same argument the switch's On/Off branch makes below. The branch RETURNS either
  // way, which matters: without that, a selector's unmatched text would fall through to the On/Off branch and
  // "On" would silently mean the LAST capture.
  const selectorParse = `${modelSelect ? `   // ⭐ A CAPTURE SELECTOR ROUND-TRIPS ITS OWN NAMES...
   if (kParams[ix].id == PARAM_MODEL_SELECT) {
      for (int i = 0; i < MORPHEUS_RIG_MODELS; ++i) {
         if (morpheus_text_is_name(text, kMorpheusRigModels[i].name)) { *out = (double)i; return true; }
      }
      char *end = NULL;
      const double v = strtod(text, &end);
      if (end == text) return false;
      *out = v < kParams[ix].min ? kParams[ix].min : (v > kParams[ix].max ? kParams[ix].max : v);
      return true;
   }
` : ''}${cabSelect ? `   // ⭐ …and the same for the speaker's.
   if (kParams[ix].id == PARAM_CAB_SELECT) {
      for (int i = 0; i < MORPHEUS_RIG_CABS; ++i) {
         if (morpheus_text_is_name(text, kMorpheusRigCabs[i].name)) { *out = (double)i; return true; }
      }
      char *end = NULL;
      const double v = strtod(text, &end);
      if (end == text) return false;
      *out = v < kParams[ix].min ? kParams[ix].min : (v > kParams[ix].max ? kParams[ix].max : v);
      return true;
   }
` : ''}`;

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

// ── the model, when there is one ─────────────────────────────────────────────────────────────────────
// ALWAYS INCLUDED, WHETHER OR NOT THERE IS A MODEL. \`Source/ModelData.h\` is generated by the scaffold and
// defines MORPHEUS_HAS_MODEL, so this file is the same text either way — which is not tidiness: the test
// bench patches the gain application below to prove its own checks can fail, and a plugin source whose text
// changed shape when a model was present would make that proof depend on what was in the workspace.
#include "ModelData.h"

// ── the cabinet, when there is one ───────────────────────────────────────────────────────────────────
// ALWAYS INCLUDED, whether or not there is a cabinet, for the same reason as the model's header: the plugin
// source stays the same text either way.
#include "CabIr.h"

#if MORPHEUS_HAS_MODEL
// NeuralAmpModelerCore (MIT) — the reference implementation of the .nam format, and deliberately not a
// second implementation of WaveNet. See server/src/lib/namPlugin.js for why the engine is theirs.
#include <string>
#include "get_dsp.h"
#include "json.hpp"
#endif

// HOISTED OUT OF THE DESCRIPTOR, and this line is a portability fix rather than style. It used to read
// \`.features = (const char *[]){...}\` — a COMPOUND LITERAL, which is C99 and not C++ at all. Clang accepts
// it as an extension, so the macOS build never complained; MSVC refuses it outright with
// \`error C4576: a parenthesized type followed by an initializer list is a non-standard explicit type
// conversion syntax\`. A named array is the portable spelling and costs nothing.
static const char *const kFeatures[] = {
   CLAP_PLUGIN_FEATURE_AUDIO_EFFECT,
   CLAP_PLUGIN_FEATURE_STEREO,
   nullptr,
};

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
   .features = kFeatures,
};

// ── parameters ───────────────────────────────────────────────────────────────────────────────────────
${paramsCpp(list)}${selectorHelpers}

// ── the blocks, IN SIGNAL ORDER, for the panel to lay its rows out by ─────────────────────────────────
// The same list the DSP is wired from, so the panel's order and the audio's order cannot disagree.
${blocksCpp(chain)}

// ── the chain order AS DATA, and its compiled default ────────────────────────────────────────────────
// Emitted HERE, before \`plugin_t\`, because the struct sizes its own order table from MORPHEUS_NUM_STAGES.
// The dispatch that walks the order is emitted after the struct — see stageDispatchCpp.
${stageTableCpp(chain)}

static inline double db_to_linear(double db) { return pow(10.0, db / 20.0); }

#if MORPHEUS_HAS_CAB
${cabSelect ? cabRigDspCpp : cabDspCpp}
#endif
${chainHas(chain, 'gate') ? `#define MORPHEUS_GATE_OFF_DB ${GATE_OFF_DB}.0\n${gateDspCpp}` : ''}
${hasTone ? `\n${toneCpp()}\n` : ''}${extraDsp ? `\n${extraDsp}` : ''}
typedef struct {
   clap_plugin_t plugin;
   const clap_host_t *host;

   // ⚠️ THE ONLY PLACE TWO THREADS MEET. The panel runs on the main thread, \`process()\` on the audio thread,
   // and the audio thread may not wait for anything — so a GUI change does not take a lock. It writes the
   // value into a slot, raises a flag with RELEASE ordering, and asks the host to make it official (see
   // morpheus_gui_param_set below). The audio thread picks the slot up at the top of its next block with
   // ACQUIRE ordering, which is what makes the write visible without a fence on either side.
   void *gui;
   double gui_value[MORPHEUS_NUM_PARAMS];
   volatile unsigned char gui_pending[MORPHEUS_NUM_PARAMS];
   const clap_output_events_t *out_events;

   // ── THE CHAIN ORDER, AND WHERE THE MODEL SITS IN IT ────────────────────────────────────────────────
   // ⚠️ THE ORDER IS PER-INSTANCE STATE, NOT A CONSTANT, and that is the whole of Stage 1.
   // \`kMorpheusDefaultOrder\` is what a fresh instance starts with; a host's saved session can replace it
   // through the state extension below. It is ONE document that the plugin's panel, the app's board editor
   // and a phone talking to a headless Pi all read and write — see lib/ampChain.js.
   //
   // \`stage_order_pending\` is why a reorder is safe to hand over from another thread: the audio thread swaps
   // it in at the top of its next block, so a reorder takes effect BETWEEN BLOCKS and never mid-note. Half a
   // block on one order and half on another is the one outcome a permutation must never produce.
   unsigned char stage_order[MORPHEUS_NUM_STAGES];
   unsigned char stage_order_pending[MORPHEUS_NUM_STAGES];
   volatile unsigned char stage_order_pending_flag;
   // Where the model stage sits in the RUNNING order, or MORPHEUS_NUM_STAGES when this chain has no model.
   // Recomputed whenever the order changes rather than searched every block.
   unsigned char model_at;

${stateCpp(chain, list)}${extraState ? `\n${extraState}` : ''}
#if MORPHEUS_HAS_CAB
${cabSelect ? cabRigStateCpp : cabStateCpp}
#endif

#if MORPHEUS_HAS_MODEL
   // ONE MODEL INSTANCE PER CHANNEL, and it is a real decision rather than symmetry. A .nam is mono in and
   // mono out. Running a single instance and copying its output to both channels would quietly turn every
   // stereo source into mono — while the port declaration above still promises two channels — so the honest
   // choices were "one per channel" or "declare the plugin mono". This keeps the contract the descriptor
   // makes, at the cost of the model's CPU twice over; a Pi running a WaveNet amp is the case to watch.
   //
   // RAW POINTERS DELIBERATELY. The plugin's storage comes from \`calloc\` and goes back with \`free\`, which
   // runs no destructors — so a \`std::unique_ptr\` member would leak the model every time a host unloaded the
   // plugin. \`get_dsp\` returns a unique_ptr and \`.release()\` hands the ownership over on purpose.
${modelSelect ? `   // ⭐ ONE INSTANCE PER CAPTURE PER CHANNEL, and the shape is the whole point of the rig: every capture is
   // built in init(), where allocating is allowed, and switching is a pointer swap — never a load on the
   // audio thread, which is what a player switching mid-song would otherwise be asking for (see lib/rig.js).
   // The first dimension is MORPHEUS_RIG_MODELS, from the header the table is declared in.
   nam::DSP *model[MORPHEUS_RIG_MODELS][2];` : `   nam::DSP *model[2];`}
   double sample_rate;
${modelSwitch ? `   // ⭐ THE DRY COPY THE MODEL'S SWITCH FADES AGAINST, and it exists because of the model's SHAPE: it runs
   // a whole chunk at once and IN PLACE, so by the time the crossfade wants the signal it replaced, the
   // buffer holds the model's output. Sized in activate(), where the host has said how large a block it will
   // send — never in process(), which may not allocate. NULL means "no fade available", not "no model": see
   // the switch in plug_process, which falls back to switching hard rather than refusing to switch.
   float *model_dry[2];
   uint32_t model_dry_cap;` : ''}
#endif
} ${'plugin_t'};

// ── THE CHAIN ORDER, AS DATA, AND THE DISPATCH THAT WALKS IT ─────────────────────────────────────────
// The order is a table now rather than the shape of the emitted code, so a host's saved session can replace
// it and a drag in a panel can write it. See lib/ampChain.js — this is Stage 1 of PLUGIN-GUI-PLAN.md.
${emitStages(stageDispatchCpp(chain, list))}

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
static int param_index(clap_id id) {
   for (uint32_t i = 0; i < MORPHEUS_NUM_PARAMS; ++i) if (kParams[i].id == id) return (int)i;
   return -1;
}

static uint32_t params_count(const clap_plugin_t *plugin) { (void)plugin; return MORPHEUS_NUM_PARAMS; }

static bool params_get_info(const clap_plugin_t *plugin, uint32_t index, clap_param_info_t *info) {
   (void)plugin;
   if (index >= MORPHEUS_NUM_PARAMS) return false;
   memset(info, 0, sizeof(*info));
   info->id = kParams[index].id;
   // ⭐ A BLOCK'S SWITCH IS A DISCRETE CONTROL AND SAYS SO IN CLAP'S OWN VOCABULARY, rather than leaving the
   // host to infer it from a 0..1 range: \`CLAP_PARAM_IS_STEPPED\` is what makes a DAW draw a switch or a
   // two-entry list instead of a slider that happens to land on whole numbers. The plugin's own panel reads
   // the same flag (see PluginGuiLayout.h), so the two cannot disagree about which rows are switches.
   info->flags = CLAP_PARAM_IS_AUTOMATABLE | (kParams[index].stepped ? CLAP_PARAM_IS_STEPPED : 0);
   snprintf(info->name, sizeof(info->name), "%s", kParams[index].name);
   // THE BLOCK THE CONTROL BELONGS TO. A host groups its parameter list by this, which is the difference
   // between fifteen rows and six named sections — the same thing the plugin's own panel does with it.
   snprintf(info->module, sizeof(info->module), "%s", kParams[index].module);
   info->min_value = kParams[index].min;
   info->max_value = kParams[index].max;
   info->default_value = kParams[index].def;
   return true;
}

static bool params_get_value(const clap_plugin_t *plugin, clap_id id, double *out) {
   // plugin_data is void*, so C++ needs the cast spelled out. This is the most common first compile error.
   const plugin_t *p = (const plugin_t *)plugin->plugin_data;
   const int ix = param_index(id);
   if (ix < 0) return false;
   *out = p->value[ix];
   return true;
}

// ⚠️ THE UNIT IS THE PARAMETER'S OWN. This said "%.2f dB" for every control in every plugin, which was true
// while the only chain was an amp and became wrong the moment a block arrived whose control is a time in
// milliseconds or a mix in percent: the DELAY showed "340.00 dB". The unit now comes from the parameter table
// — the same table the panel draws from — so a control cannot be described in units it does not have.
//
// ⭐ AND A BLOCK'S SWITCH READS "On"/"Off" RATHER THAN "1.00". A discrete control whose text is a number is a
// control the host cannot draw and a player cannot read; CLAP carries the discreteness as a flag (see
// params_get_info) and this is the half that names the two states.
static bool params_value_to_text(const clap_plugin_t *plugin, clap_id id, double value, char *out,
                                 uint32_t capacity) {
   (void)plugin;
   const int ix = param_index(id);
   if (ix < 0) return false;
${selectorNames}   if (kParams[ix].stepped) {
      snprintf(out, capacity, "%s", value >= (kParams[ix].min + kParams[ix].max) * 0.5 ? "On" : "Off");
      return true;
   }
   const char *unit = kParams[ix].unit;
   if (unit && unit[0]) snprintf(out, capacity, "%.2f %s", value, unit);
   else snprintf(out, capacity, "%.2f", value);
   return true;
}

// ⚠️ PORTABLE ON PURPOSE. \`strncasecmp\` is POSIX and MSVC does not have it — it has \`_strnicmp\` — and this
// file is compiled by both (the Windows runner is where the \`__atomic_*\` builtins were found missing). Six
// lines of our own beat a platform branch for a comparison this small.
static bool morpheus_text_is(const char *text, const char *word) {
   while (*text == ' ') ++text;
   for (; *word; ++text, ++word) {
      const char c = (*text >= 'A' && *text <= 'Z') ? (char)(*text - 'A' + 'a') : *text;
      if (c != *word) return false;
   }
   return true;
}

static bool params_text_to_value(const clap_plugin_t *plugin, clap_id id, const char *text,
                                 double *out) {
   (void)plugin;
   const int ix = param_index(id);
   if (ix < 0) return false;
${selectorParse}   // A SWITCH IS TYPED AS A WORD. "On"/"Off" is what value_to_text just showed the user, so refusing it here
   // would be the plugin rejecting its own spelling — and a host that round-trips text would break on it.
   if (kParams[ix].stepped) {
      if (morpheus_text_is(text, "on")) { *out = kParams[ix].max; return true; }
      if (morpheus_text_is(text, "off")) { *out = kParams[ix].min; return true; }
   }
   char *end = NULL;
   const double v = strtod(text, &end);
   if (end == text) return false;  // nothing numeric was typed
   // Clamp rather than reject: a host that receives false here shows the user an error for typing "100",
   // which is an ordinary thing to type.
   *out = v < kParams[ix].min ? kParams[ix].min : (v > kParams[ix].max ? kParams[ix].max : v);
   return true;
}

static void apply_param_event(plugin_t *p, const clap_event_header_t *hdr) {
   // THERE IS NO PARAM EVENT SPACE. Parameter changes arrive in the CORE event space and are identified by
   // their type; assuming a dedicated space is a compile error, which is the good outcome.
${eventCpp()}
}

static void params_flush(const clap_plugin_t *plugin, const clap_input_events_t *in,
                         const clap_output_events_t *out) {
   ${'plugin_t'} *p = (${'plugin_t'} *)plugin->plugin_data;
   p->out_events = out;   // the GUI may need it before the first process() call
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
${initCpp(list)}
   p->fs = 48000.0;
   // THE DEFAULT ORDER, and where the model sits in it. A fresh instance runs the signal order the generator
   // emitted; only a host restoring a saved session replaces it (see the state extension below).
   for (unsigned char s = 0; s < MORPHEUS_NUM_STAGES; ++s) p->stage_order[s] = kMorpheusDefaultOrder[s];
   p->model_at = morpheus_model_at(p);
${chainHas(chain, 'gate') ? gateInitCpp : ''}
${cabSelect ? cabRigInitCpp : cabInitCpp}${extraInit ? `\n${extraInit}` : ''}
${hasTone ? `   // A sentinel rather than a value: the first frame recomputes every coefficient, so a plugin that starts
   // at 0 dB is not silent because its filters were never configured. calloc leaves these at zero, and a
   // zero-coefficient biquad passes nothing.
   for (int i = 0; i < ${TONE_KEYS.length}; ++i) p->tone_last[i] = 1e9;
` : ''}#if MORPHEUS_HAS_MODEL
${modelSelect ? `   p->sample_rate = 48000.0;
   // ⭐ EVERY CAPTURE IS LOADED HERE, ONCE, WHERE ALLOCATING IS ALLOWED. This is the whole point of a rig:
   // \`get_dsp\` parses JSON and allocates weights, which the audio thread may never do — and a player
   // switches captures WHILE PLAYING, so the switch has to be a pointer swap (see lib/rig.js). The table is
   // the same one the selector reports its names from, so what is loaded and what is offered cannot differ.
   for (int i = 0; i < MORPHEUS_RIG_MODELS; ++i) {
      try {
         const nlohmann::json config = nlohmann::json::parse(
            reinterpret_cast<const char *>(kMorpheusRigModels[i].data),
            reinterpret_cast<const char *>(kMorpheusRigModels[i].data) + kMorpheusRigModels[i].size);
         for (int c = 0; c < 2; ++c) p->model[i][c] = nam::get_dsp(config).release();
      } catch (const std::exception &e) {
         // ⚠️ ONE CAPTURE THAT WILL NOT LOAD DOES NOT TAKE THE RIG WITH IT, AND THE MESSAGE NAMES WHICH ONE.
         // The other captures still play and the selector still reaches them; this position plays the dry
         // signal, which is the same honest degradation the singular model has, one capture at a time.
         fprintf(stderr, "[%s] could not load the NAM capture %s (%s) — that position plays nothing\\n",
                 MORPHEUS_MODEL_NAME, kMorpheusRigModels[i].name, e.what());
         for (int c = 0; c < 2; ++c) { delete p->model[i][c]; p->model[i][c] = NULL; }
      }
   }` : `   p->sample_rate = 48000.0;
   try {
      // THE SAME BYTES THE FILE HOLDS, handed to the reference engine. Not a re-serialised model and not a
      // converted weight layout, so what this plugin runs is what the .nam says — which is also what makes
      // the offline comparison in CI possible: the reference renderer is given the same bytes.
      const nlohmann::json config = nlohmann::json::parse(
         reinterpret_cast<const char *>(morpheus_model_data),
         reinterpret_cast<const char *>(morpheus_model_data) + morpheus_model_size);
      for (int c = 0; c < 2; ++c) p->model[c] = nam::get_dsp(config).release();
   } catch (const std::exception &e) {
      // A MODEL THAT WILL NOT LOAD MUST NOT TAKE THE PLUGIN WITH IT. The host gets a working gain stage and
      // one line in its log, which is the difference between "this plugin is broken" and "this model is" —
      // and a silent fallback to a gain stage would be the worse failure of the two.
      fprintf(stderr, "[%s] could not load the NAM model from %s (%s) — running as a gain stage\\n",
              MORPHEUS_MODEL_NAME, MORPHEUS_MODEL_PATH, e.what());
      for (int c = 0; c < 2; ++c) { delete p->model[c]; p->model[c] = NULL; }
   }`}
#endif
   return true;
}

static void plug_destroy(const clap_plugin_t *plugin) {
   ${'plugin_t'} *p = (${'plugin_t'} *)plugin->plugin_data;
#if MORPHEUS_HAS_MODEL
${modelSelect ? `   // \`free\` runs no destructors, so EVERY capture is released here or not at all — the whole table, not
   // only the one the selector happened to be on.
   for (int i = 0; i < MORPHEUS_RIG_MODELS; ++i) {
      for (int c = 0; c < 2; ++c) { delete p->model[i][c]; p->model[i][c] = NULL; }
   }` : `   // \`free\` runs no destructors, so the models are released here or not at all.
   for (int c = 0; c < 2; ++c) { delete p->model[c]; p->model[c] = NULL; }`}
${modelSwitch ? '   for (int c = 0; c < 2; ++c) { free(p->model_dry[c]); p->model_dry[c] = NULL; }\n' : ''}#endif
${cabSelect ? cabRigDestroyCpp : cabDestroyCpp}${extraDestroy ? `\n${extraDestroy}` : ''}
   free(plugin->plugin_data);
}

static bool plug_activate(const clap_plugin_t *plugin, double sr, uint32_t min_frames,
                          uint32_t max_frames) {
   plugin_t *p = (plugin_t *)plugin->plugin_data;
   (void)min_frames;
   // The sample rate is needed by the tone stack as well as the model, so it is stored either way.
   p->fs = sr;
#if MORPHEUS_HAS_MODEL
   p->sample_rate = sr;
   // Reset() may ALLOCATE and it settles the model's initial conditions, so it belongs here and never in
   // process(). The buffer size is what the host says it will send; a model that has to grow later is a
   // model that allocates on the audio thread.
   const int max_buffer = max_frames ? (int)max_frames : 512;
${modelSelect ? `   // ⭐ EVERY CAPTURE IS RESET, not only the selected one: the selector may move to another capture at any
   // block, and a capture that was never told the sample rate is a capture that answers with the wrong
   // arithmetic the moment it is picked.
   for (int i = 0; i < MORPHEUS_RIG_MODELS; ++i) {
      for (int c = 0; c < 2; ++c) if (p->model[i][c]) p->model[i][c]->Reset(sr, max_buffer);
   }` : `   for (int c = 0; c < 2; ++c) if (p->model[c]) p->model[c]->Reset(sr, max_buffer);`}
${modelSwitch ? `   // ⭐ THE FADE BUFFER IS SIZED HERE, for the same reason and with the same number: the host has just said
   // how large a block it will send, and activate() is a place allocation is allowed. The previous
   // activation's is released first — a host may activate, deactivate and activate again at a new rate.
   // A failed allocation is not a failed plugin: the switch still works, it just cannot fade.
   for (int c = 0; c < 2; ++c) { free(p->model_dry[c]); p->model_dry[c] = NULL; }
   p->model_dry_cap = (uint32_t)max_buffer;
   for (int c = 0; c < 2; ++c) {
      p->model_dry[c] = (float *)malloc(sizeof(float) * (size_t)p->model_dry_cap);
      if (!p->model_dry[c]) { p->model_dry_cap = 0; break; }
   }
` : ''}#else
   (void)sr; (void)max_frames;
#endif
   return true;
}
static void plug_deactivate(const clap_plugin_t *plugin) {
#if MORPHEUS_HAS_MODEL
   ${'plugin_t'} *p = (${'plugin_t'} *)plugin->plugin_data;
   (void)p;   // no fade buffer when the chain has no model BLOCK
${modelSwitch ? `   for (int c = 0; c < 2; ++c) { free(p->model_dry[c]); p->model_dry[c] = NULL; }
   p->model_dry_cap = 0;` : ''}
#else
   (void)plugin;
#endif
}
static bool plug_start_processing(const clap_plugin_t *plugin) { return true; }
static void plug_stop_processing(const clap_plugin_t *plugin) {}
static void plug_reset(const clap_plugin_t *plugin) {
   plugin_t *p = (plugin_t *)plugin->plugin_data;
   // Snap the smoothers to their targets and drop the filters' history: a transport reset is the one moment
   // a jump is expected, and a filter holding the last bar's state is a click.
   for (uint32_t k = 0; k < MORPHEUS_NUM_PARAMS; ++k) p->smoothed[k] = p->value[k];
${hasTone ? `   for (int c = 0; c < 2; ++c) for (int b = 0; b < ${TONE_KEYS.length}; ++b) {
      p->tone[c][b].x1 = p->tone[c][b].x2 = p->tone[c][b].y1 = p->tone[c][b].y2 = 0.0;
   }
   for (int b = 0; b < ${TONE_KEYS.length}; ++b) p->tone_last[b] = 1e9;
` : ''}}
static void plug_on_main_thread(const clap_plugin_t *plugin) {}

// ── the handover's two operations, PORTABLY ──────────────────────────────────────────────────────────────
// ⚠️ \`__atomic_store_n\` AND ITS FAMILY ARE GCC/CLANG BUILTINS AND MSVC HAS NONE OF THEM. This file compiled
// on macOS with clang and was rejected by MSVC, on the Windows runner, with:
//
//    error C2065: '__ATOMIC_RELEASE': undeclared identifier
//    error C3861: '__atomic_store_n': identifier not found
//
// which is the whole reason the panel work was dispatched to all three runners rather than trusted. The MSVC
// spelling is an interlocked exchange, which is a FULL barrier — stronger than the release/acquire pair the
// other branch uses, and correct for both directions of this handover.
#if defined(_MSC_VER)
#include <intrin.h>
static inline void morpheus_gui_publish(volatile unsigned char *flag) {
   _InterlockedExchange8((volatile char *)flag, 1);
}
static inline bool morpheus_gui_consume(volatile unsigned char *flag) {
   return _InterlockedExchange8((volatile char *)flag, 0) != 0;
}
#else
static inline void morpheus_gui_publish(volatile unsigned char *flag) {
   __atomic_store_n(flag, 1, __ATOMIC_RELEASE);
}
static inline bool morpheus_gui_consume(volatile unsigned char *flag) {
   return __atomic_exchange_n(flag, 0, __ATOMIC_ACQ_REL) != 0;
}
#endif

// ── the GUI's half of the handover, and the ONLY functions in this file with C linkage ──────────────────
// The panel is a separate translation unit on purpose (Source/PluginGui.mm), so it cannot see plugin_t. These
// three functions are the whole interface between the panel and the plugin, and none of them is on the audio
// thread.
extern "C" void *morpheus_gui_state(const clap_plugin_t *plugin) {
   const ${'plugin_t'} *p = (const ${'plugin_t'} *)plugin->plugin_data;
   return p->gui;
}

extern "C" void morpheus_gui_set_state(const clap_plugin_t *plugin, void *state) {
   ${'plugin_t'} *p = (${'plugin_t'} *)plugin->plugin_data;
   p->gui = state;
}

// ⚠️ THE **RUNNING** ORDER, NOT THE COMPILED ONE. This used to return kMorpheusBlocks — the order the project
// was built with — which was right for exactly as long as the order could not change. Now that a drag can
// change it, a panel that drew the compiled order would show the player their drag being undone while the
// audio played the new one. It is filled on first use and kept in step by the two places that set an order
// (morpheus_gui_set_order and plug_state_load), both of which run on the main thread — the same thread every
// panel call comes from, so the array is never read and written at once.
static const char *s_gui_order_names[MORPHEUS_NUM_STAGES];
static int s_gui_order_names_valid = 0;

static void morpheus_gui_order_names_set(const unsigned char *order) {
   for (uint32_t i = 0; i < (uint32_t)MORPHEUS_NUM_STAGES; ++i) s_gui_order_names[i] = kMorpheusBlocks[order[i]];
   s_gui_order_names_valid = 1;
}

// The panel's block list, in signal order. Declared in PluginGuiLayout.h; the panel does the grouping.
extern "C" const char *const *morpheus_gui_chain_order(uint32_t *count) {
   if (count) *count = MORPHEUS_NUM_BLOCKS;
   // A FRESH INSTANCE RUNS THE ORDER IT WAS BUILT WITH, so the identity is the right first answer.
   if (!s_gui_order_names_valid) {
      unsigned char identity[MORPHEUS_NUM_STAGES];
      for (uint32_t i = 0; i < (uint32_t)MORPHEUS_NUM_STAGES; ++i) identity[i] = (unsigned char)i;
      morpheus_gui_order_names_set(identity);
   }
   return s_gui_order_names;
}

/**
 * A control moved on the panel. Three things happen, and all three are needed:
 *
 *   1. the value goes into a slot with the flag raised AFTER it, so the audio thread cannot see the flag
 *      without seeing the value;
 *   2. the host is told, as a PARAM_VALUE output event. This is how CLAP says a plugin's own interface
 *      changed a parameter — without it the host's automation display, its undo and its saved state would
 *      all still hold the old value;
 *   3. nothing is applied here. The audio thread applies it, at the top of its next block, because applying
 *      it here would be this thread writing state the audio thread is reading.
 */
extern "C" void morpheus_gui_param_set(const clap_plugin_t *plugin, clap_id id, double value) {
   ${'plugin_t'} *p = (${'plugin_t'} *)plugin->plugin_data;
   const int ix = param_index(id);
   if (ix < 0) return;
   const double clamped = value < kParams[ix].min ? kParams[ix].min
                        : (value > kParams[ix].max ? kParams[ix].max : value);
   p->gui_value[ix] = clamped;
   morpheus_gui_publish(&p->gui_pending[ix]);
   if (p->out_events) {
      clap_event_param_value_t ev;
      memset(&ev, 0, sizeof(ev));
      ev.header.size = sizeof(ev);
      ev.header.time = 0;
      ev.header.space_id = CLAP_CORE_EVENT_SPACE_ID;
      ev.header.type = CLAP_EVENT_PARAM_VALUE;
      ev.header.flags = 0;
      ev.param_id = id;
      ev.cookie = NULL;
      ev.note_id = -1;
      ev.port_index = -1;
      ev.channel = -1;
      ev.key = -1;
      ev.value = clamped;
      p->out_events->try_push(p->out_events, &ev.header);
   }
}

// ── the panel's half of the chain order ──────────────────────────────────────────────────────────────
// ⭐ THE PANEL MAY REORDER THE CHAIN, and these two are the only door it has. \`order\` is a permutation of the
// INDICES into kMorpheusBlocks — and that array is generated from the same stage list as the enum above, in
// the same order, so index i IS stage id i and a permutation of one is a permutation of the other.
//
// ⚠️ THE PIVOT RULE LIVES HERE AND NOT IN THE PANEL. The panel is one view; a host, a preset and a phone will
// all want to write this same document, and a rule that lived in one of them would be a rule the others do
// not have. The panel ASKS which blocks may move rather than deciding.
extern "C" int morpheus_gui_block_movable(uint32_t index) {
   if (index >= (uint32_t)MORPHEUS_NUM_STAGES) return 0;
   const char *kind = kMorpheusStageKinds[index];
   // The amp model and the cabinet are the PIVOT — every other block is positioned relative to them, so
   // "the delay in front of the amp" and "the delay in the loop" are two different sounds and both are
   // reachable. The output level is applied on the plugin's OUTPUT, after both channels, so a block placed
   // after it is processed by nothing at all.
   return (strcmp(kind, "model") && strcmp(kind, "cab") && strcmp(kind, "level")) ? 1 : 0;
}

extern "C" bool morpheus_gui_set_order(const clap_plugin_t *plugin, const uint32_t *order, uint32_t count) {
   ${'plugin_t'} *p = (${'plugin_t'} *)plugin->plugin_data;
   if (count != (uint32_t)MORPHEUS_NUM_STAGES) return false;
   unsigned char seen[MORPHEUS_NUM_STAGES];
   for (unsigned char s = 0; s < MORPHEUS_NUM_STAGES; ++s) seen[s] = 0;
   for (uint32_t s = 0; s < count; ++s) {
      if (order[s] >= count) return false;
      if (++seen[order[s]] > 1) return false;
      // AND A PINNED BLOCK DOES NOT MOVE — refused even though it is a legal permutation of the chain,
      // because it is not a legal rearrangement of the amplifier.
      if (!morpheus_gui_block_movable(order[s]) && order[s] != s) return false;
   }
   // ⚠️ HANDED OVER, NOT WRITTEN, for the reason the parameters are: the audio thread swaps it in at the top
   // of its next block, so a drag takes effect BETWEEN BLOCKS and never mid-note.
   for (uint32_t s = 0; s < count; ++s) p->stage_order_pending[s] = (unsigned char)order[s];
   morpheus_gui_publish(&p->stage_order_pending_flag);
   // …and the PANEL is told, so the column redraws in the new order rather than showing the drag undone.
   morpheus_gui_order_names_set(p->stage_order_pending);
   // ⭐ AND THE HOST IS TOLD, or the session would save the order the plugin was BUILT with and the drag would
   // be forgotten the moment the project was reopened. That is the other half of the state extension: \`save\`
   // gives the host the bytes, and \`mark_dirty\` is what makes it ask for them.
   const clap_host_state_t *hs = (const clap_host_state_t *)p->host->get_extension(p->host, CLAP_EXT_STATE);
   if (hs && hs->mark_dirty) hs->mark_dirty(p->host);
   return true;
}

// ── THE STATE EXTENSION — the first thing this plugin has ever saved ─────────────────────────────────
// ⚠️ UNTIL Stage 1 THERE WAS NO STATE EXTENSION AT ALL: nothing but the host's own parameter values survived
// a session, so a chain order had nowhere to live. That is the reason the order could not be a value, and
// therefore the reason a drag in a panel could not work. What is saved is the ORDER — one byte per stage —
// so the plugin, the app's board editor and a phone talking to a headless Pi can all edit one document.
//
// ⚠️ THE PARAMETERS ARE DELIBERATELY NOT IN HERE. CLAP hosts already save and restore parameter values
// through the params extension, and a second copy would be two sources of truth that disagree the moment a
// host restores one and not the other.
//
// ⚠️ AND IT IS A FORMAT, NOT A MEMCPY OF THE STRUCT. A host may save on one machine and load on another, so
// everything is written field by field, little-endian, with a magic and a version — a blob from a future
// build is refused rather than interpreted.
#define MORPHEUS_STATE_MAGIC 0x4D4F5250u   /* 'MORP' */
#define MORPHEUS_STATE_VERSION 1u

// ⚠️ DECLARED HERE, DEFINED WITH THE REST OF THE PANEL'S INTERFACE FURTHER DOWN, because plug_state_load needs
// it: the pivot rule is applied at BOTH doors an order can come through — a drag and a saved session — and a
// rule enforced at one door is not a rule.
extern "C" int morpheus_gui_block_movable(uint32_t index);

// CLAP's streams are counted writes, not writes: a short write is legal, so these loop until the buffer is
// done rather than assuming one call is the whole of it.
static bool morpheus_write_all(const clap_ostream_t *stream, const void *src, uint64_t n) {
   const char *at = (const char *)src;
   while (n > 0) {
      const int64_t wrote = stream->write(stream, at, n);
      if (wrote <= 0) return false;
      at += wrote;
      n -= (uint64_t)wrote;
   }
   return true;
}

static bool morpheus_read_all(const clap_istream_t *stream, void *dst, uint64_t n) {
   char *at = (char *)dst;
   while (n > 0) {
      const int64_t got = stream->read(stream, at, n);
      if (got <= 0) return false;
      at += got;
      n -= (uint64_t)got;
   }
   return true;
}

static bool morpheus_u32_write(const clap_ostream_t *stream, uint32_t v) {
   const unsigned char b[4] = {(unsigned char)(v & 0xFFu), (unsigned char)((v >> 8) & 0xFFu),
                               (unsigned char)((v >> 16) & 0xFFu), (unsigned char)((v >> 24) & 0xFFu)};
   return morpheus_write_all(stream, b, 4);
}

static bool morpheus_u32_read(const clap_istream_t *stream, uint32_t *out) {
   unsigned char b[4];
   if (!morpheus_read_all(stream, b, 4)) return false;
   *out = (uint32_t)b[0] | ((uint32_t)b[1] << 8) | ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24);
   return true;
}

static bool plug_state_save(const clap_plugin_t *plugin, const clap_ostream_t *stream) {
   const ${'plugin_t'} *p = (const ${'plugin_t'} *)plugin->plugin_data;
   if (!morpheus_u32_write(stream, MORPHEUS_STATE_MAGIC)) return false;
   if (!morpheus_u32_write(stream, MORPHEUS_STATE_VERSION)) return false;
   if (!morpheus_u32_write(stream, (uint32_t)MORPHEUS_NUM_STAGES)) return false;
   // THE RUNNING ORDER, NOT THE DEFAULT ONE: a session that saved a reordered chain and loaded the compiled
   // order back would be a reorder that silently undid itself.
   return morpheus_write_all(stream, p->stage_order, MORPHEUS_NUM_STAGES);
}

static bool plug_state_load(const clap_plugin_t *plugin, const clap_istream_t *stream) {
   ${'plugin_t'} *p = (${'plugin_t'} *)plugin->plugin_data;
   uint32_t magic = 0, version = 0, count = 0;
   if (!morpheus_u32_read(stream, &magic) || !morpheus_u32_read(stream, &version)) return false;
   if (magic != MORPHEUS_STATE_MAGIC || version != MORPHEUS_STATE_VERSION) return false;
   if (!morpheus_u32_read(stream, &count)) return false;
   // A BLOB FROM A DIFFERENT BUILD IS REFUSED, NOT PARTLY APPLIED. The stage count belongs to the BUILD — a
   // project with a delay has one more stage than one without — so a permutation of the wrong length would
   // index past the end of the table. Refusing leaves the compiled order running: a plugin that works.
   if (count != (uint32_t)MORPHEUS_NUM_STAGES) return false;
   unsigned char order[MORPHEUS_NUM_STAGES];
   if (!morpheus_read_all(stream, order, MORPHEUS_NUM_STAGES)) return false;
   // ⚠️ IT MUST BE A PERMUTATION, and this is the check that makes the dispatch above total. One byte per
   // stage with no repeats means every case is reached exactly once; a duplicate would run one block twice
   // and drop another — a wrong SOUND rather than an error, which is what a corrupted or hand-edited file
   // produces. \`seen\` counts rather than flags so the test is the count, not the shape.
   unsigned char seen[MORPHEUS_NUM_STAGES];
   for (unsigned char s = 0; s < MORPHEUS_NUM_STAGES; ++s) seen[s] = 0;
   for (unsigned char s = 0; s < MORPHEUS_NUM_STAGES; ++s) {
      if (order[s] >= MORPHEUS_NUM_STAGES) return false;
      if (++seen[order[s]] > 1) return false;
      // ⚠️ AND THE PIVOT DOES NOT MOVE HERE EITHER. The panel indexes the block column by POSITION, so it asks
      // "may the block at position 4 move?" — which is only the same question as "may THIS block move?" while
      // the pinned blocks keep their positions. A legal permutation that swapped the cabinet with a delay would
      // leave the panel labelling one block as locked while the audio ran a different arrangement.
      //
      // ONE RULE, APPLIED AT EVERY DOOR. It lives in morpheus_gui_block_movable (declared below) and it is
      // checked here as well as in morpheus_gui_set_order, because a saved session is the other way an order
      // arrives and a rule enforced at one door is not a rule.
      if (!morpheus_gui_block_movable(order[s]) && order[s] != s) return false;
   }
   // HANDED OVER, NOT WRITTEN. The audio thread swaps it in at the top of its next block, so a reorder takes
   // effect BETWEEN BLOCKS — see the note on \`stage_order_pending\` in plugin_t.
   for (unsigned char s = 0; s < MORPHEUS_NUM_STAGES; ++s) p->stage_order_pending[s] = order[s];
   morpheus_gui_publish(&p->stage_order_pending_flag);
   // …and the PANEL is told, so a session that reopens with a saved order DRAWS that order rather than the one
   // the plugin was compiled with. A panel showing a different chain from the one playing is worse than no
   // panel at all.
   morpheus_gui_order_names_set(p->stage_order_pending);
   return true;
}

static const clap_plugin_state_t s_state = {.save = plug_state_save, .load = plug_state_load};

// The output queue, remembered rather than asked for. CLAP hands it to process() and to params.flush() and
// nowhere else, and a plugin whose own GUI changes a parameter needs it between blocks.
static clap_process_status plug_process(const clap_plugin_t *plugin, const clap_process_t *process) {
   ${'plugin_t'} *p = (${'plugin_t'} *)plugin->plugin_data;
   const uint32_t nframes = process->frames_count;
   p->out_events = process->out_events;
   // Whatever the panel changed since the last block, applied HERE — on the audio thread, where the value is
   // read, rather than on the main thread where it was written.
   for (uint32_t k = 0; k < MORPHEUS_NUM_PARAMS; ++k) {
      if (morpheus_gui_consume(&p->gui_pending[k])) p->value[k] = p->gui_value[k];
   }
   // THE ORDER A HOST RESTORED, APPLIED HERE — the same handover as the GUI values above, and for the same
   // reason plus one more: a reorder must take effect BETWEEN BLOCKS, never mid-note. Swapping a table the
   // audio thread is walking would run part of a block on one order and part on another.
   if (morpheus_gui_consume(&p->stage_order_pending_flag)) {
      for (unsigned char s = 0; s < MORPHEUS_NUM_STAGES; ++s) p->stage_order[s] = p->stage_order_pending[s];
      p->model_at = morpheus_model_at(p);
   }
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

      const uint32_t chunk_start = i;
      const uint32_t chunk_end = next_ev_frame;

      // ── PASS 1 — every stage BEFORE the model, in the running order ───────────────────────────────────
      // ⭐ IT IS WRITTEN STRAIGHT INTO THE OUTPUT BUFFER, which is not a shortcut: that port is float32 and
      // NAM_SAMPLE is float (asserted below), so the model can then run IN PLACE over the chunk and the
      // plugin needs no scratch buffer, no allocation and no field in plugin_t. In place is safe with this
      // engine and it was CHECKED rather than assumed — every architecture copies its input into its own
      // working state before it writes an output sample (NAM/wavenet/model.cpp's _set_condition_array,
      // NAM/wavenet/a2_fast.cpp's rechannel, NAM/lstm.cpp frame by frame), so input == output aliases
      // nothing the model still has to read.
      //
      // IDX_OUTPUT IS SKIPPED HERE and stepped in pass 2 instead, so its ramp stays per-sample: stepped
      // once per sample in pass 1 it would run a whole block ahead and apply a block-early value to every
      // sample in it.
      for (; i < chunk_end; ++i) {
${smoothCpp('IDX_OUTPUT')}
${hasTone ? `${toneUpdateCpp()}\n` : ''}         double in_l = process->audio_inputs[0].data32[0][i];
         double in_r = process->audio_inputs[0].data32[1][i];
         // ONE CHANNEL AT A TIME through the same chain, so the two paths cannot drift: a channel that took
         // a different route would be a stereo image that moves when a control does.
         for (int c = 0; c < 2; ++c) {
            double x = (c == 0) ? in_l : in_r;
            // ⭐ THE ORDER WALK, and the reason this is a loop rather than written-out code: the order is a
            // VALUE now, so a block can be on either side of the model without the plugin being rebuilt.
            for (unsigned char s = 0; s < p->model_at; ++s) {
               x = morpheus_stage_dsp(p, c, x, (int)p->stage_order[s]);
            }
            process->audio_outputs[0].data32[c][i] = (float)x;
         }
      }

${modelInPath ? '#if MORPHEUS_HAS_MODEL' : '#if 0'}
      // ── THE MODEL, ONCE PER CHUNK PER CHANNEL ─────────────────────────────────────────────────────────
      // ⚠️ THIS WAS ONE SAMPLE AT A TIME, AND IT COST MOST OF THE PLUGIN'S REAL-TIME BUDGET. Measured on the
      // engine alone, same model, same 48 kHz, 64-frame host blocks (scripts/audio-model-bench.mjs):
      //
      //     block size    wavenet_a1_standard    A2.nam (full submodel)
      //        1 frame            2.58x                   1.96x   faster than real time
      //       64 frames           6.23x                   8.85x
      //
      // so calling process() once per sample was 2.4x-4.5x of the model's cost, multiplied by two because
      // the plugin runs one instance per channel. A block is the shape the engine is written for: its own
      // renderer uses 64, and the per-call setup is what the extra calls were paying for.
      {
         // The in-place call below reinterprets the port's float buffer as NAM_SAMPLE. If NAM_SAMPLE_FLOAT
         // ever came off, NAM_SAMPLE would be double and that cast would be undefined behaviour rather than
         // a compile error — so it is a compile error.
         static_assert(sizeof(NAM_SAMPLE) == sizeof(float), "the model runs in place on a float32 port");
         const int model_frames = (int)(chunk_end - chunk_start);
${modelSelect ? (modelSwitch ? `         // ⭐ THE CAPTURE IS CHOSEN BY POINTER, NEVER LOADED — the whole reason the rig exists (see lib/rig.js).
         // Every capture was built in init(); the selector only says which one runs. \`model_dry\` is per
         // channel and shared across captures, which is exactly right — it is a copy of the CHUNK's input, the
         // same signal for every capture, so the fade works whichever one is selected.
         // ⚠️ THE RAW VALUE, NOT THE SMOOTHED ONE: a stepped control's smoothed value sweeps through the
         // captures between the old one and the new one, which would play a burst of each on the way.
         const int model_sel = morpheus_model_index(p->value[IDX_MODEL_SELECT]);
         const double on_model = p->smoothed[IDX_ON_MODEL];
         if (model_frames > 0 && on_model > 0.0) {
            for (int c = 0; c < 2; ++c) {
               nam::DSP *m = p->model[model_sel][c];
               if (!m) continue;
               NAM_SAMPLE *io[1] = {(NAM_SAMPLE *)process->audio_outputs[0].data32[c] + chunk_start};
               if (on_model >= 1.0 || !p->model_dry[c] || model_frames > (int)p->model_dry_cap) {
                  m->process(io, io, model_frames);
                  continue;
               }
               for (int k = 0; k < model_frames; ++k) p->model_dry[c][k] = io[0][k];
               m->process(io, io, model_frames);
               for (int k = 0; k < model_frames; ++k) {
                  io[0][k] = (NAM_SAMPLE)(p->model_dry[c][k] + on_model * ((double)io[0][k] - p->model_dry[c][k]));
               }
            }
         }` : `         // ⭐ THE CAPTURE IS CHOSEN BY POINTER, NEVER LOADED — see the rig note in lib/rig.js. There is no
         // on/off switch in this chain, so the selected capture simply runs.
         const int model_sel = morpheus_model_index(p->value[IDX_MODEL_SELECT]);
         if (model_frames > 0) {
            for (int c = 0; c < 2; ++c) {
               nam::DSP *m = p->model[model_sel][c];
               if (!m) continue;
               NAM_SAMPLE *io[1] = {(NAM_SAMPLE *)process->audio_outputs[0].data32[c] + chunk_start};
               m->process(io, io, model_frames);
            }
         }`) : modelSwitch ? `         // ⭐ THE AMP IS A SWITCH LIKE EVERY OTHER BLOCK, WITH ONE DIFFERENCE THAT MATTERS: it is the only
         // stage that runs a WHOLE CHUNK at once and IN PLACE, so the signal it replaced is gone by the time
         // a crossfade would want it. \`model_dry\` is that copy — sized in activate(), where allocation is
         // allowed. When it is missing the switch still works and simply drops the fade, which is a click
         // rather than a refusal, and never a silent no-op.
         const double on_model = p->smoothed[IDX_ON_MODEL];
         if (model_frames > 0 && on_model > 0.0) {
            for (int c = 0; c < 2; ++c) {
               if (!p->model[c]) continue;
               NAM_SAMPLE *io[1] = {(NAM_SAMPLE *)process->audio_outputs[0].data32[c] + chunk_start};
               // ⚠️ FULLY ON IS ITS OWN PATH, and it is the path every existing proof takes. \`dry + 1.0 *
               // (wet - dry)\` is NOT bit-identical to \`wet\` in floating point, and the runner render checks
               // null the plugin against the reference engine — so \`on == 1\` must not go through the
               // arithmetic at all, exactly as a per-sample stage skips its blend line. A block larger than
               // the buffer the host promised takes the same path, rather than writing past the end of it.
               if (on_model >= 1.0 || !p->model_dry[c] || model_frames > (int)p->model_dry_cap) {
                  p->model[c]->process(io, io, model_frames);
                  continue;
               }
               for (int k = 0; k < model_frames; ++k) p->model_dry[c][k] = io[0][k];
               p->model[c]->process(io, io, model_frames);
               for (int k = 0; k < model_frames; ++k) {
                  io[0][k] = (NAM_SAMPLE)(p->model_dry[c][k] + on_model * ((double)io[0][k] - p->model_dry[c][k]));
               }
            }
         }` : `         if (model_frames > 0) {
            for (int c = 0; c < 2; ++c) {
               if (!p->model[c]) continue;
               NAM_SAMPLE *io[1] = {(NAM_SAMPLE *)process->audio_outputs[0].data32[c] + chunk_start};
               p->model[c]->process(io, io, model_frames);
            }
         }`}
      }
#endif

      // ── PASS 2 — everything per-sample that comes AFTER the model ─────────────────────────────────────
      for (uint32_t k = chunk_start; k < chunk_end; ++k) {
${smoothOneCpp('IDX_OUTPUT')}
         double in_l = process->audio_outputs[0].data32[0][k];
         double in_r = process->audio_outputs[0].data32[1][k];
         for (int c = 0; c < 2; ++c) {
            double x = (c == 0) ? in_l : in_r;
            // ⭐ THE ORDER WALK, resumed on the other side of the model. \`model_at\` is where the model sits
            // in the RUNNING order, so a block that was dragged across it changes which pass it runs in —
            // which is exactly what "a delay in front of the amp" means.
            for (unsigned char s = p->model_at; s < MORPHEUS_NUM_STAGES; ++s) {
               x = morpheus_stage_dsp(p, c, x, (int)p->stage_order[s]);
            }
${emitStages(legacyCabCpp(chain, cabInPath))}
            if (c == 0) in_l = x; else in_r = x;
         }
         // The output level is applied last, so moving it changes how loud the plugin is and NOT how hard
         // the model is driven — the difference between an output control and a drive control. This line is
         // what scripts/audio-testbench.mjs patches to prove its own checks can fail.
         process->audio_outputs[0].data32[0][k] = (float)(in_l * db_to_linear(p->smoothed[IDX_OUTPUT]));
         process->audio_outputs[0].data32[1][k] = (float)(in_r * db_to_linear(p->smoothed[IDX_OUTPUT]));
      }
   }
   return CLAP_PROCESS_CONTINUE;
}

// Defined in Source/PluginGui.mm on Apple and Source/PluginGui.cpp everywhere else. The stub returns NULL,
// which is how a plugin says "no panel" — so a platform without one keeps the host's generic parameter list
// rather than claiming a window it cannot draw.
extern "C" const clap_plugin_gui_t *morpheus_gui_extension(void);

static const void *plug_get_extension(const clap_plugin_t *plugin, const char *id) {
   if (!strcmp(id, CLAP_EXT_AUDIO_PORTS)) return &s_audio_ports;
   if (!strcmp(id, CLAP_EXT_PARAMS)) return &s_params;
   if (!strcmp(id, CLAP_EXT_GUI)) return morpheus_gui_extension();
   // ⭐ THE ORDER A HOST SAVES. Without this the chain order would be a value with nowhere to live, which is
   // exactly why the plugin had none before Stage 1 — see the state block above.
   if (!strcmp(id, CLAP_EXT_STATE)) return &s_state;
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
export function cmakeLists({ name, id, version, auType, auSubtype, auManufacturer, auManufacturerName, hasModel = false, modelPath = null, modelArchitecture = null, hasCab = false }) {
  return `# ${name} — built with Morpheus.
#
# ONE SOURCE, FOUR FORMATS ON APPLE — THREE EVERYWHERE ELSE. \`make_clapfirst_plugins\` takes the CLAP implementation in Source/ and produces
# a CLAP bundle, a VST3 bundle, an Audio Unit component and a standalone app from it. THE AU IS APPLE-ONLY
# — there is no Audio Unit on Windows or Linux — so the format list, the wrapper flag and the AU arguments
# are all gated on APPLE rather than left to the wrapper to skip. Gating the FLAG matters as much as the
# list: leaving the AU wrapper on makes a Windows configure fetch Apple's AudioUnitSDK. Everything it pulls
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

# ⚠️ C++20, AND IT IS NOT A PREFERENCE. The plugin source below initialises its CLAP structs with DESIGNATED
# INITIALIZERS (\`.id = ...\`), which is a C++20 feature. The standard used to say 17 here, and the macOS build
# worked anyway because clang accepts them as an extension — so the first Windows build was the first time
# anything checked, and MSVC answered \`error C7555: use of designated initializers requires at least
# '/std:c++20'\`. Declaring 20 is the accurate statement of what this source is written in.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if (APPLE AND NOT CMAKE_OSX_DEPLOYMENT_TARGET)
  # FORCE, and the guard, are both load-bearing: CMake already puts CMAKE_OSX_DEPLOYMENT_TARGET in its
  # cache as an EMPTY string, and a plain \`set(... CACHE ...)\` will not overwrite an existing cache
  # entry. Without FORCE this line silently does nothing and a wrapper reading the variable sees "" —
  # which on at least one clap-wrapper version is a hard configure error. The build also passes
  # -DCMAKE_OSX_DEPLOYMENT_TARGET explicitly, so this only matters when you build the project by hand.
  set(CMAKE_OSX_DEPLOYMENT_TARGET "10.15" CACHE STRING "Minimum macOS version" FORCE)
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
# APPLE ONLY. On Windows this must be OFF, not merely unused: the flag makes configure fetch Apple's
# AudioUnitSDK, which is an Apple framework and has no business in a Windows build.
if (APPLE)
  set(CLAP_WRAPPER_BUILD_AUV2 ON CACHE BOOL "" FORCE)
else()
  set(CLAP_WRAPPER_BUILD_AUV2 OFF CACHE BOOL "" FORCE)
endif()
set(CLAP_WRAPPER_BUILD_STANDALONE ON CACHE BOOL "" FORCE)
set(CLAP_WRAPPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(CLAP_WRAPPER_BUILD_AAX OFF CACHE BOOL "" FORCE)
# MSVC's C++ RUNTIME MUST BE CHOSEN ONCE, FOR THE WHOLE BUILD — and this line exists because the first
# Windows build failed without it:
#
#   error LNK2038: mismatch detected for 'RuntimeLibrary': value 'MT_StaticRelease' doesn't match value
#                  'MD_DynamicRelease' in wrapasvst3_export_entry.obj
#
# clap-wrapper sets the static runtime (and says so: "Setting to static link"), but a \`set()\` inside its
# directory scope does not reach the targets created HERE — so the VST3 SDK's libraries were static while our
# own wrapper entry object took CMake's MSVC default of the DLL runtime, and the link mixed the two C++
# runtimes. Static also means the plugin does not need the Visual C++ redistributable on the user's machine,
# which is what clap-wrapper intends for a plugin anyway. No effect off MSVC.
if (MSVC)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>" CACHE STRING "MSVC runtime" FORCE)
endif()

# LINUX ONLY, AND PINNED FOR THE SAME REASON THE MSVC LINE IS. RtMidi's own default on Linux is to probe
# for JACK and build against it when it finds one, and a build that changes shape depending on what happens
# to be installed on the machine is not a build anyone can reproduce. This plugin opens no MIDI ports and
# no audio device of its own — the STANDALONE does, and on Linux that is RtAudio over ALSA, which is what a
# Raspberry Pi image has. Setting it in the cache with FORCE before add_subdirectory means the wrapper's own
# \`set(... CACHE ...)\` cannot overwrite it, which is exactly how the MSVC runtime fix above works.
if (UNIX AND NOT APPLE)
  set(RTAUDIO_API_JACK FALSE CACHE BOOL "no JACK — ALSA only" FORCE)
  set(RTMIDI_API_JACK FALSE CACHE BOOL "no JACK — the plugin opens no MIDI ports" FORCE)

  # ⚠️ AND THE SAME LESSON, LEARNED FROM THE FIRST LINUX BUILD. The VST3 SDK is compiled into a STATIC
  # library (base-sdk-vst3), and CMake does not build static libraries position-independent by default. The
  # VST3 wrapper here is a SHARED OBJECT, so the link failed on the runner:
  #
  #   /usr/bin/ld: libbase-sdk-vst3.a(vstparameters.cpp.o): relocation R_AARCH64_ADR_PREL_PG_HI21 against
  #   symbol '_ZSt19piecewise_construct' ... can not be used when making a shared object; recompile with -fPIC
  #
  # It is not an ARM problem — x86-64 Linux fails the same way with R_X86_64_32S, and the two platforms
  # this project built on before do not have it because MSVC and clang compile position-independent code by
  # default. So it is set for the WHOLE subtree here, before add_subdirectory, where it reaches the SDK's
  # static libraries as well as our own targets; setting it on our target alone would not help, because the
  # relocations that fail are inside the SDK's objects.
  set(CMAKE_POSITION_INDEPENDENT_CODE ON CACHE BOOL "Linux plugins are shared objects" FORCE)
endif()

add_subdirectory(\${CLAP_WRAPPER_DIR} clap-wrapper)

# ── the plugin ───────────────────────────────────────────────────────────────────────────────────────
# ModelData.cpp and CabIr.cpp ALWAYS EXIST, whether or not they hold anything: the plugin includes their
# headers unconditionally and branches on the flags inside, so there is no configuration in which one of a
# pair is present and the other is not.
# ⚠️ THE PANEL IS ONE OF TWO FILES AND THE PLATFORM PICKS WHICH. \`PluginGui.mm\` is the Cocoa view;
# \`PluginGui.cpp\` is a stub whose \`morpheus_gui_extension()\` returns NULL, which is how CLAP says "this
# plugin has no GUI" — so Windows and Linux keep the host's own generic parameter list rather than claiming a
# window they cannot draw. EITHER WAY ONE OF THEM MUST COMPILE: Plugin.cpp references the symbol
# unconditionally, so a build that picked neither would fail at link rather than at runtime.
# Cocoa on Apple, a child HWND and GDI on Windows, a child X11 window with its own event thread on Linux, and
# a NULL stub for a platform nobody has written a panel for yet.
if (APPLE)
  set(MORPHEUS_GUI_SOURCE Source/PluginGui.mm)
elseif (WIN32)
  set(MORPHEUS_GUI_SOURCE Source/PluginGuiWin.cpp)
elseif (UNIX)
  set(MORPHEUS_GUI_SOURCE Source/PluginGuiX11.cpp)
else()
  set(MORPHEUS_GUI_SOURCE Source/PluginGui.cpp)
endif()

# ⚠️ OBJECT, NOT STATIC, AND THE DIFFERENCE IS WHETHER THE MODEL LOADS AT ALL.
#
# The engine's architectures register themselves in a static initializer — nam::factory::Helper in
# NAM/wavenet/model.cpp calls ConfigParserRegistry::instance().registerParser(...) at program start. A
# STATIC library is an ARCHIVE, and the linker pulls an object out of an archive only when something references
# a symbol in it. Nothing references anything in wavenet/model.cpp — the only thing it exports is a
# constructor — so the object was never linked, the WaveNet parser was never registered, and every build of
# this plugin answered:
#
#     No config parser registered for architecture: WaveNet
#
# and fell back to the gain stage. The plugin still loaded, still opened in a DAW, still made sound: it just
# was not the amplifier, and the BUILD-PROOF listed the right parameter names the whole time.
#
# ⚠️ AND THE PROOF DID NOT CATCH IT because the proof compiles the sources ITSELF, straight into a test binary
# — the same way NeuralAmpModelerCore's own tools do, compiling NAM_SOURCES straight into an executable
# — so the registration was always present there. The plugin people download is built by THIS file, and it was
# never run anywhere until the AU was opened on a Mac and asked to load a model.
#
# An OBJECT library links every object unconditionally, which is what "the engine is part of this plugin"
# actually means.
add_library(morpheus_plugin-impl OBJECT Source/Plugin.cpp Source/ModelData.cpp Source/CabIr.cpp \${MORPHEUS_GUI_SOURCE})
target_include_directories(morpheus_plugin-impl PRIVATE Source)
target_link_libraries(morpheus_plugin-impl PUBLIC clap clap-wrapper-extensions)
# The panel is drawn with the system's own frameworks — no toolkit, no GPU context, and therefore nothing to
# go wrong inside a host's window. QuartzCore is for the layer-backed drawing path Cocoa uses on Retina.
if (APPLE)
  target_link_libraries(morpheus_plugin-impl PUBLIC "-framework Cocoa" "-framework QuartzCore")
elseif (WIN32)
  # GDI for the drawing; both are part of the Windows SDK and every MSVC toolchain already has them.
  target_link_libraries(morpheus_plugin-impl PUBLIC gdi32 user32)
elseif (UNIX)
  # X11 for the drawing, and Threads because the Linux panel runs its own event loop — see
  # server/src/lib/pluginGui.js for why it has to. libx11-dev is what the Linux ARM route already installs.
  find_package(Threads REQUIRED)
  target_link_libraries(morpheus_plugin-impl PUBLIC X11 Threads::Threads)
endif()
${hasCab ? `
# The cabinet needs nothing fetched — the taps are compiled in. This line exists so the configure cannot
# quietly build a project whose CabIr.cpp was generated without a cabinet.
if (NOT EXISTS "\${CMAKE_CURRENT_SOURCE_DIR}/Source/CabIr.cpp")
  message(FATAL_ERROR "Source/CabIr.cpp is missing; the scaffold did not run.")
endif()
` : ''}${hasModel ? `
# ── the neural model ─────────────────────────────────────────────────────────────────────────────────
# ${JSON.stringify(modelPath)} — a ${JSON.stringify(modelArchitecture || 'NAM')} model, embedded in Source/ModelData.cpp and
# run by NeuralAmpModelerCore (MIT), the reference implementation of the .nam format. The engine is NOT
# vendored: MORPHEUS_NAM_DIR points at a checkout, exactly as CLAP_WRAPPER_DIR does for the wrappers, so the
# pin lives in one place (server/src/lib/audioPluginProject.js) and cannot drift from the copy the
# measurement CLI builds.
#
# The sources are globbed rather than added through add_subdirectory because NAMCore's own CMakeLists builds
# its tools — four executables we do not want, and a configure that would fail on a machine without the
# AudioDSPTools submodule. What is needed here is the library and two header-only dependencies.
if (NOT DEFINED MORPHEUS_NAM_DIR)
  message(FATAL_ERROR "MORPHEUS_NAM_DIR is not set — this project carries a model and needs the reference engine.")
endif()
file(GLOB MORPHEUS_NAM_SOURCES "\${MORPHEUS_NAM_DIR}/NAM/*.cpp" "\${MORPHEUS_NAM_DIR}/NAM/*/*.cpp")
if (NOT MORPHEUS_NAM_SOURCES)
  message(FATAL_ERROR "No NAM sources under \${MORPHEUS_NAM_DIR}/NAM — is MORPHEUS_NAM_DIR a NeuralAmpModelerCore checkout?")
endif()
target_sources(morpheus_plugin-impl PRIVATE \${MORPHEUS_NAM_SOURCES})
target_include_directories(morpheus_plugin-impl PRIVATE
        "\${MORPHEUS_NAM_DIR}"
        "\${MORPHEUS_NAM_DIR}/NAM"
        "\${MORPHEUS_NAM_DIR}/Dependencies/eigen"
        "\${MORPHEUS_NAM_DIR}/Dependencies/nlohmann")
# FLOAT SAMPLES, and it is a compile-time choice inside the library rather than a preference: dsp.h defines
# \`NAM_SAMPLE\` from this macro, so a plugin that defined it and a library that did not would disagree about
# the signature of the very function it calls. It also halves the model's working memory, which is the
# difference between a WaveNet on a Raspberry Pi and a WaveNet on a workstation.
target_compile_definitions(morpheus_plugin-impl PRIVATE NAM_SAMPLE_FLOAT)
` : ''}

# The AU is APPLE ONLY — there is no Audio Unit on Windows, so a Windows build that names it here gets the
# wrapper skipped by clap-wrapper and, worse, could still fetch Apple's AudioUnitSDK.
set(PLUGIN_FORMATS CLAP VST3 WCLAP)
if (APPLE)
  list(APPEND PLUGIN_FORMATS AUV2)
endif()
if (APPLE AND CMAKE_GENERATOR STREQUAL "Xcode")
    list(APPEND PLUGIN_FORMATS AUV3)
endif()

# The AU arguments are passed ONLY where an AU is built. Handing them to a Windows configure is noise at
# best — and the list is built rather than written out so the same function call serves both platforms.
set(AU_ARGS "")
if (APPLE)
  set(AU_ARGS
        AUV2_MANUFACTURER_NAME "\${AUV2_MANUFACTURER_NAME}"
        AUV2_MANUFACTURER_CODE "\${AUV2_MANUFACTURER}"
        AUV2_SUBTYPE_CODE "\${AUV2_SUBTYPE}"
        AUV2_INSTRUMENT_TYPE "\${AUV2_TYPE}")
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
        \${AU_ARGS}
        STANDALONE_CONFIGURATIONS
        standalone "\${PRODUCT_NAME}" "\${BUNDLE_ID}"
)
`;
}
