// The plugin's own control panel — what makes a standalone window more than a window.
//
// ── WHY A PLUGIN NEEDS A GUI AT ALL, WHICH SOUNDS OBVIOUS AND IS NOT ─────────────────────────────────────
// A DAW draws its own generic panel for any plugin that has none — every parameter as a row of sliders — so
// inside a host, a plugin without a GUI is survivable. A STANDALONE is not a host with a generic panel: it is
// clap-wrapper opening a window and asking the plugin for a `clap_plugin_gui`. Without one there is nothing to
// put in the window, and the user gets sound and no knobs.
//
// ── ⚠️ ONE LAYOUT, THREE DRAWING BACKENDS, AND THE SPLIT IS THE WHOLE DESIGN ─────────────────────────────
// What a panel *says* — which rows there are, what they are called, where each sits, what its number reads,
// and what a click at a given x means — is identical on every platform and lives once, in
// `Source/PluginGuiLayout.h`. What differs is only how a rectangle, a circle and a piece of text get onto the
// screen: NSBezierPath on Cocoa, GDI on Windows, Xlib on Linux.
//
// That split is not tidiness. Three copies of "which parameter is under this point" is three places for the
// hit test to disagree with the drawing, and the failure is a slider that moves when you click a different
// one — which looks like a broken plugin and is unreproducible on the machine you develop on.
//
// ── NO THIRD-PARTY GUI TOOLKIT, AND THAT IS ALSO A DECISION ──────────────────────────────────────────────
// The obvious choice is an immediate-mode toolkit (Dear ImGui is MIT and would work). It is not taken here
// because a toolkit needs a RENDERER — OpenGL, Metal or DirectX — and therefore a GPU context inside a window
// the HOST owns. That is the single most common source of "the plugin window is black in my DAW", and it is a
// class of bug that cannot exist when the drawing is the platform's own.
//
// ── IT IS NOT A SECOND SOURCE OF TRUTH FOR THE PARAMETERS EITHER ─────────────────────────────────────────
// The panel asks the plugin's own `clap_plugin_params` extension for the count, the names, the ranges, the
// current values and the display text. It never reads the parameter table directly, which is why no panel
// needs a header from Plugin.cpp and why a parameter that changes there changes here. That is exactly the
// interface a host uses, so a panel cannot describe a plugin that is not the one running.
//
// ── ⚠️ AND THE ONE PLACE TWO THREADS MEET ────────────────────────────────────────────────────────────────
// A drag runs on the GUI thread; `process()` runs on the audio thread. Three things then happen, and all three
// are needed:
//
//   1. the value is handed to Plugin.cpp, which writes it into a slot and raises a flag — the audio thread
//      picks it up at the top of its next block. This is what makes the sound change even in a host that does
//      not echo a plugin-set parameter;
//   2. the same change is pushed to the host as a PARAM_VALUE output event, which is how CLAP says a plugin
//      tells its host that a control moved — without it the host's automation display, undo and saved state
//      would not know;
//   3. the panel redraws from `get_value`, so what you see is what the host actually holds.
//
// See `morpheus_gui_param_set` in Plugin.cpp for why the handover is a flag and a slot rather than a lock: the
// audio thread may not wait for anything, ever.
export const PLUGIN_GUI_LAYOUT = 'Source/PluginGuiLayout.h';
export const PLUGIN_GUI_APPLE = 'Source/PluginGui.mm';
export const PLUGIN_GUI_WINDOWS = 'Source/PluginGuiWin.cpp';
export const PLUGIN_GUI_X11 = 'Source/PluginGuiX11.cpp';
export const PLUGIN_GUI_STUB = 'Source/PluginGui.cpp';

/** The panel's geometry, in points. One source, so a backend cannot lay out a different panel. */
export const PANEL = {
  row: 34, pad: 14, width: 460, trackX: 168, valueW: 78, knobR: 6,
  // ⭐ THE BLOCK COLUMN. A box per block down the left, the selected block's controls to the right of it —
  // see the note on MORPHEUS_BOX_X in the layout for why the panel is ONE FIXED HEIGHT rather than a window
  // that grows when a block is opened.
  boxX: 12, boxW: 142, boxH: 30, boxGap: 10,
  // ⭐ TWO THINGS THE PANEL GREW WHEN THE BLOCKS GAINED SWITCHES. A SWITCH is not a track: it is a pill with
  // a knob at one end, and it needs its own width rather than the width of a slider. A GROUP band is the
  // strip above the first row of each block that carries the block's name — the thing that answers "I can't
  // tell what's what", which is why it is height rather than a colour.
  groupH: 20, switchW: 44, switchH: 16,
  maxRows: 256, maxBlocks: 64,
  // ⭐ THE BADGE, in the space under the controls: an amp head, a cabinet and a pedalboard, drawn from the same
  // primitives as everything else. Rob: "In that spare space You could add a cool looking amp head cab and
  // pedal board in morpheus style as a bit of a logo for the plugin with the morpheus from the homepage under
  // the picture." It is DECORATION — it reads no parameter, answers no click, and every project gets it.
  badgeX: 178, badgeY: 186, badgeW: 232, badgeH: 138,
};

/**
 * The shared layout, included by every backend.
 *
 * It carries the geometry constants, the row builder that reads the plugin's own params extension, the hit
 * test and the x-of-value arithmetic. A backend that draws has nothing left to decide except pixels.
 */
export const pluginGuiLayout = `// ${PLUGIN_GUI_LAYOUT} — generated by Morpheus. This file is yours: edit it freely, and the build picks up
// your changes. See server/src/lib/pluginGui.js for why the layout is shared and the drawing is not.
#ifndef MORPHEUS_PLUGIN_GUI_LAYOUT_H
#define MORPHEUS_PLUGIN_GUI_LAYOUT_H

#include <clap/clap.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

// The three things a panel needs from Plugin.cpp, and nothing else. Declared here rather than in a header of
// its own so that a panel is one file to add, remove or replace.
extern "C" {
void *morpheus_gui_state(const clap_plugin_t *plugin);
void morpheus_gui_set_state(const clap_plugin_t *plugin, void *state);
void morpheus_gui_param_set(const clap_plugin_t *plugin, clap_id id, double value);
// The blocks IN SIGNAL ORDER, from the plugin's own chain — see kMorpheusBlocks in Plugin.cpp. The panel
// groups its rows by this rather than by where a block first appears in the parameter list; that was the bug.
const char *const *morpheus_gui_chain_order(uint32_t *count);
// ⭐ THE ORDER IS EDITABLE FROM THE PANEL NOW. \`order\` is a permutation of the INDICES into the array
// morpheus_gui_chain_order returns — and that array is generated from the same stage list as the enum in
// Plugin.cpp, so index i IS stage id i. A permutation here is a permutation of the DSP's own order table.
// Returns false when the plugin refuses it: not a permutation, or it moves the amp/cabinet pivot or the
// output, which are not the panel's to move.
bool morpheus_gui_set_order(const clap_plugin_t *plugin, const uint32_t *order, uint32_t count);
// Whether the block at this index may be dragged. The PLUGIN answers, because which blocks are the pivot is a
// fact about the chain and not about the panel — the panel must not be the only thing that knows.
int morpheus_gui_block_movable(uint32_t index);
}

// ── the layout, and the only place a row's position is written down ──────────────────────────────────────
#define MORPHEUS_ROW ${PANEL.row}
#define MORPHEUS_PAD ${PANEL.pad}
#define MORPHEUS_PANEL_WIDTH ${PANEL.width}
#define MORPHEUS_TRACK_X ${PANEL.trackX}
#define MORPHEUS_VALUE_W ${PANEL.valueW}
#define MORPHEUS_KNOB_R ${PANEL.knobR}
// ⚠️ THE ROW'S NAME IS IN THE CONTROL AREA TOO, because the box column has taken the left of the panel. It is
// a COLUMN rather than a caption above the control: a caption would make every row two lines tall for no
// gain, since the value already sits on the right — and the first version of this drew the name AT the
// control's own x, so every label landed on top of its own slider. Photographed, not guessed.
#define MORPHEUS_LABEL_X MORPHEUS_TRACK_X
#define MORPHEUS_CONTROL_X (MORPHEUS_TRACK_X + 96)
#define MORPHEUS_TRACK_W (MORPHEUS_PANEL_WIDTH - MORPHEUS_CONTROL_X - MORPHEUS_VALUE_W - MORPHEUS_PAD)
// The band above the first row of a block, carrying the block's name — see morpheus_gui_row_y.
#define MORPHEUS_GROUP_H ${PANEL.groupH}
// A switch, rather than the width of a slider: a two-state control drawn as a full-width track reads as a
// slider that will not move.
#define MORPHEUS_SWITCH_W ${PANEL.switchW}
#define MORPHEUS_SWITCH_H ${PANEL.switchH}
// The most rows a panel will draw. Every backend allocates this on the stack ONCE and the row builder is the
// only thing that writes it, so the three of them cannot disagree about the bound.
#define MORPHEUS_GUI_MAX_ROWS ${PANEL.maxRows}
// The most blocks a panel will draw, for the same reason and with the same shape.
#define MORPHEUS_GUI_MAX_BLOCKS ${PANEL.maxBlocks}

// ── THE BLOCK COLUMN, AND WHY THE PANEL'S HEIGHT IS FIXED ────────────────────────────────────────────────
// ⚠️ THE HEIGHT CANNOT DEPEND ON WHAT IS OPEN, AND THAT IS A CONSTRAINT RATHER THAN A CHOICE. A panel whose
// height changed when a block was opened would have to ask the host to resize it — but \`gui_set_size\` and
// \`gui_can_resize\` are false, and the offscreen host that photographs this panel answers NO host extensions
// at all. A design we cannot photograph is a design we verify by hope, which is exactly how the block order
// shipped wrong once already. So the panel is one fixed height: every block is a box in a column down the
// left, and the SELECTED block's controls are drawn beside them. The whole signal path is visible at once,
// which is what "I can't tell what's what" was asking for in the first place.
#define MORPHEUS_BOX_X ${PANEL.boxX}
#define MORPHEUS_BOX_W ${PANEL.boxW}
#define MORPHEUS_BOX_H ${PANEL.boxH}
#define MORPHEUS_BOX_GAP ${PANEL.boxGap}
// Where the control area starts: a title strip, then the selected block's rows.
#define MORPHEUS_CTRL_TOP (MORPHEUS_PAD + 20)

/** One row: what to draw, and where its control is. Built from the plugin's own params extension. */
typedef struct {
   clap_id id;               // the parameter this row addresses — the switch and the slider both need it
   double t;                 // 0..1 along the track, for a continuous control
   double setting;           // the raw value, so a switch can draw its position without re-reading anything
   double min, max, def;     // the range, so acting on a click never re-reads the params extension
   int stepped;              // CLAP_PARAM_IS_STEPPED: draw a SWITCH, not a track
   int first;                // the first row of its block — the block layer groups on this
   char name[64];
   char value[64];
   char group[64];           // the block this row belongs to, from clap_param_info_t.module
} morpheus_gui_row_t;

/** One block: a box in the column, and the rows it owns in the control area. */
typedef struct {
   char name[64];
   uint32_t first_row;       // index into the row array
   uint32_t row_count;
   int movable;              // 0 for the amp/cabinet pivot and the output — ASKED OF THE PLUGIN, never assumed
   // ⚠️ WHETHER THE CONTROL AREA NEEDS A HEADING AT ALL. A block whose first control shares the block's own
   // name — Input, Gate, Output — would otherwise print it twice, once in amber and once in white, and the
   // heading reads as a second control rather than as a heading. Rob: "drop it when it repeats". Decided HERE
   // rather than in each backend, for the same reason the geometry is.
   int title;
} morpheus_gui_block_t;

/**
 * How tall the panel is: the taller of the box column and the control area.
 *
 * \`max_rows\` is the largest row_count over the blocks, so the control area is sized for the biggest block
 * any of them could show. The height is therefore a function of the CHAIN, not of what the user has open.
 */
static uint32_t morpheus_gui_total_height(const morpheus_gui_block_t *blocks, const uint32_t count,
                                          const uint32_t max_rows) {
   const uint32_t column = count ? MORPHEUS_BOX_H * count + MORPHEUS_BOX_GAP * (count - 1) : 0;
   const uint32_t controls = MORPHEUS_CTRL_TOP + max_rows * MORPHEUS_ROW;
   return MORPHEUS_PAD + (column > controls ? column : controls) + MORPHEUS_PAD;
}

/** The y of a block's box top, in the fixed column. */
static uint32_t morpheus_gui_box_y(const uint32_t at) {
   return MORPHEUS_PAD + at * (MORPHEUS_BOX_H + MORPHEUS_BOX_GAP);
}

/**
 * The y of a row's top, inside the control area.
 *
 * ⚠️ IT TAKES THE ROW'S POSITION WITHIN ITS BLOCK, NOT ITS INDEX IN THE ROW ARRAY. The control area shows ONE
 * block, so the rows drawn there are always 0..row_count-1 — and the group bands are gone, because the box
 * beside them is what names the block now.
 */
static uint32_t morpheus_gui_row_y(const uint32_t within) {
   return MORPHEUS_CTRL_TOP + within * MORPHEUS_ROW;
}

/**
 * Fill in every row from the plugin's own params extension. Returns how many were written.
 *
 * The value text is the plugin's own \`value_to_text\`, so a panel cannot show a unit the plugin does not agree
 * with — a control whose unit is milliseconds reads "340.00 ms" here for the same reason it does in a DAW, and
 * a block's switch reads "On"/"Off" for the same reason too.
 *
 * ⭐ AND IT GROUPS BY BLOCK. The plugin lists its parameters in IDENTITY order — every control in the order a
 * host stores automation against — which puts the blocks' switches at the END, because inserting one beside
 * its block would renumber everything after it. That order is right for a host and wrong for a human, so the
 * rows are re-ordered HERE, for display only: blocks in the order they first appear, each block's own rows in
 * the order the plugin listed them. Nothing about the identity order changes; a row addresses its parameter
 * by id, never by position.
 */
static uint32_t morpheus_gui_rows(const clap_plugin_t *plugin, const clap_plugin_params_t *params,
                                  morpheus_gui_row_t *out, const uint32_t max) {
   morpheus_gui_row_t raw[MORPHEUS_GUI_MAX_ROWS];
   const uint32_t n = params->count(plugin);
   uint32_t nr = 0;
   for (uint32_t i = 0; i < n && nr < MORPHEUS_GUI_MAX_ROWS; ++i) {
      clap_param_info_t info;
      memset(&info, 0, sizeof(info));
      if (!params->get_info(plugin, i, &info)) continue;
      double value = info.default_value;
      params->get_value(plugin, info.id, &value);
      morpheus_gui_row_t *row = &raw[nr++];
      memset(row, 0, sizeof(*row));
      row->id = info.id;
      const double span = info.max_value - info.min_value;
      row->t = span > 0.0 ? (value - info.min_value) / span : 0.0;
      row->setting = value;
      row->min = info.min_value;
      row->max = info.max_value;
      row->def = info.default_value;
      // ⚠️ CLAP'S OWN FLAG, NOT A CONVENTION OF OURS. \`CLAP_PARAM_IS_STEPPED\` is how the plugin says "this
      // control is discrete", and reading it here is what makes the panel draw the same control the host does.
      row->stepped = (info.flags & CLAP_PARAM_IS_STEPPED) ? 1 : 0;
      // %.63s RATHER THAN %s: the field is 64 bytes and a host's parameter name is up to 256, so the
      // truncation is INTENDED — and gcc says so at -Wformat-truncation, on a build where clap-wrapper turns
      // warnings into errors. Saying how much to take is both quieter and a more honest statement of intent.
      snprintf(row->name, sizeof(row->name), "%.63s", info.name);
      snprintf(row->group, sizeof(row->group), "%.63s", info.module);
      if (!params->value_to_text(plugin, info.id, value, row->value, sizeof(row->value))) {
         snprintf(row->value, sizeof(row->value), "%.2f", value);
      }
   }
   uint32_t written = 0;
   // ⭐ THE BLOCKS THE PLUGIN NAMES, IN SIGNAL ORDER — which is the order the audio runs in and the order a
   // player drew, not the order the parameters happen to be listed in. See morpheus_gui_chain_order.
   uint32_t orderCount = 0;
   const char *const *order = morpheus_gui_chain_order(&orderCount);
   for (uint32_t g = 0; g < orderCount && written < max; ++g) {
      int first = 1;
      for (uint32_t j = 0; j < nr && written < max; ++j) {
         if (strcmp(raw[j].group, order[g])) continue;
         out[written] = raw[j];
         // A block with no name — every project that predates the board — gets no band, rather than a blank
         // one. The height arithmetic reads this same flag, so the two cannot disagree.
         out[written].first = (first && raw[j].group[0]) ? 1 : 0;
         first = 0;
         ++written;
      }
   }
   // AND THEN ANYTHING THE TABLE DID NOT NAME, in the order the plugin listed it. A chain with no order table,
   // or a module the plugin grew without telling the panel, still draws — a row that is never emitted is a
   // control a user cannot reach, which is worse than one in the wrong place.
   for (uint32_t i = 0; i < nr && written < max; ++i) {
      int named = 0;
      for (uint32_t g = 0; g < orderCount; ++g) if (!strcmp(raw[i].group, order[g])) { named = 1; break; }
      if (named) continue;
      int seen = 0;
      for (uint32_t j = 0; j < i; ++j) if (!strcmp(raw[j].group, raw[i].group)) { seen = 1; break; }
      if (seen) continue;
      int first = 1;
      for (uint32_t j = i; j < nr && written < max; ++j) {
         if (strcmp(raw[j].group, raw[i].group)) continue;
         out[written] = raw[j];
         out[written].first = (first && raw[j].group[0]) ? 1 : 0;
         first = 0;
         ++written;
      }
   }
   return written;
}

/**
 * Group the rows into BLOCKS, in the order morpheus_gui_rows already put them in — which is SIGNAL order.
 * The rows arrive grouped (a \`first\` flag opens each block), so this is a walk and not a sort.
 *
 * \`movable\` is ASKED OF THE PLUGIN, one block at a time. Which blocks are the pivot is a fact about the
 * chain, and a panel that decided it for itself would be a second place for it to be wrong.
 *
 * ⚠️ IT ASKS BY POSITION, AND THAT IS SOUND ONLY BECAUSE THE PLUGIN FIXES THE PINNED POSITIONS. The block at
 * index b is whatever the RUNNING order puts there, so "may the block at b move?" and "may THIS block move?"
 * are the same question exactly while a pinned block keeps its own position — which the plugin enforces at
 * both doors an order can come through (morpheus_gui_set_order and plug_state_load). If that ever stops being
 * true, this is the line that goes quietly wrong.
 */
static uint32_t morpheus_gui_blocks(const morpheus_gui_row_t *rows, const uint32_t count,
                                    morpheus_gui_block_t *out, const uint32_t max) {
   uint32_t nb = 0;
   for (uint32_t i = 0; i < count; ++i) {
      if (!rows[i].first && nb > 0) { out[nb - 1].row_count++; continue; }
      if (nb >= max) break;
      memset(&out[nb], 0, sizeof(out[nb]));
      snprintf(out[nb].name, sizeof(out[nb].name), "%.63s", rows[i].group);
      out[nb].first_row = i;
      out[nb].row_count = 1;
      out[nb].movable = morpheus_gui_block_movable(nb);
      // …and whether a heading would say anything the first row does not.
      out[nb].title = strcmp(out[nb].name, rows[i].name) != 0;
      ++nb;
   }
   return nb;
}

/** The largest row_count over the blocks: the control area is sized for the biggest block there is. */
static uint32_t morpheus_gui_most_rows(const morpheus_gui_block_t *blocks, const uint32_t count) {
   uint32_t most = 0;
   for (uint32_t b = 0; b < count; ++b) if (blocks[b].row_count > most) most = blocks[b].row_count;
   return most;
}

/** How tall the panel is for this plugin — a function of the CHAIN, and never of what is open. */
static uint32_t morpheus_gui_height(const clap_plugin_t *plugin, const clap_plugin_params_t *params) {
   morpheus_gui_row_t rows[MORPHEUS_GUI_MAX_ROWS];
   morpheus_gui_block_t blocks[MORPHEUS_GUI_MAX_BLOCKS];
   const uint32_t n = morpheus_gui_rows(plugin, params, rows, MORPHEUS_GUI_MAX_ROWS);
   const uint32_t nb = morpheus_gui_blocks(rows, n, blocks, MORPHEUS_GUI_MAX_BLOCKS);
   return morpheus_gui_total_height(blocks, nb, morpheus_gui_most_rows(blocks, nb));
}

/**
 * The BOX a point is over, or -1. The whole box is the target, because a control you have to aim at is a
 * control that feels broken.
 */
static int morpheus_gui_box_at(const double x, const double y, const uint32_t count) {
   if (x < MORPHEUS_BOX_X || x >= MORPHEUS_BOX_X + MORPHEUS_BOX_W) return -1;
   for (uint32_t b = 0; b < count; ++b) {
      const double top = (double)morpheus_gui_box_y(b);
      if (y >= top && y < top + (double)MORPHEUS_BOX_H) return (int)b;
   }
   return -1;
}

/**
 * The row a point is over in the CONTROL AREA, or -1.
 *
 * ⚠️ THE INDEX IT RETURNS IS WITHIN THE SELECTED BLOCK, not within the whole row array — the caller adds
 * blocks[open].first_row. One function, so a click cannot land on a different slider depending on which
 * operating system drew the panel, which is a bug you cannot reproduce on the machine you develop on.
 */
static int morpheus_gui_row_at(const double x, const double y, const uint32_t row_count) {
   if (x < MORPHEUS_CONTROL_X - 8) return -1;
   for (uint32_t i = 0; i < row_count; ++i) {
      const double top = (double)morpheus_gui_row_y(i);
      if (y >= top && y < top + (double)MORPHEUS_ROW) return (int)i;
   }
   return -1;
}

/**
 * ⭐ THE DRAG, AS ARITHMETIC — and the one place the pivot rule lives.
 *
 * \`out\` becomes the permutation to hand the plugin: \`out[position] = block\`. The MOVABLE blocks are
 * rearranged among the slots they already occupy, so a block dragged up or down swaps with the movable blocks
 * it passed. The pinned ones — the amp model, the cabinet and the output, which the PLUGIN names — keep the
 * position they were built with, and no block ever lands between them. Rob: *"amp and cab pivot point"*.
 *
 * ⚠️ IT PRODUCES A PERMUTATION AND NOTHING ELSE, and the plugin checks that anyway. A drag that produced a
 * non-permutation would be a bug in this arithmetic, and the plugin's refusal is what turns it into a no-op
 * rather than a block that runs twice.
 */
static void morpheus_gui_reorder(const morpheus_gui_block_t *blocks, const uint32_t count,
                                 const uint32_t from, const uint32_t to, uint32_t *out) {
   uint32_t slot[MORPHEUS_GUI_MAX_BLOCKS];   // the positions a drag may rearrange, ascending — these never move
   uint32_t seq[MORPHEUS_GUI_MAX_BLOCKS];    // the movable blocks, in the order they currently run
   uint32_t nf = 0;
   for (uint32_t b = 0; b < count; ++b) {
      out[b] = b;                            // the pinned blocks keep their own positions, by construction
      if (blocks[b].movable) { slot[nf] = b; seq[nf] = b; ++nf; }
   }
   if (nf < 2 || from >= count || !blocks[from].movable) return;
   uint32_t a = 0;
   for (uint32_t i = 0; i < nf; ++i) if (seq[i] == from) { a = i; break; }
   // WHERE IT IS GOING, snapped to the nearest slot it is ALLOWED to occupy: a drop onto a pinned box has to
   // mean something, and "the nearest place you could have meant" is the only answer that does not lose it.
   uint32_t z = 0, best = 0xFFFFFFFFu;
   for (uint32_t i = 0; i < nf; ++i) {
      const uint32_t d = slot[i] > to ? slot[i] - to : to - slot[i];
      if (d < best) { best = d; z = i; }
   }
   const uint32_t moved = seq[a];
   if (z > a) for (uint32_t i = a; i < z; ++i) seq[i] = seq[i + 1];
   else if (z < a) for (uint32_t i = a; i > z; --i) seq[i] = seq[i - 1];
   seq[z] = moved;
   for (uint32_t i = 0; i < nf; ++i) out[slot[i]] = seq[i];
}

/** What a click at \`x\` means: 0..1 along the track, clamped. */
static double morpheus_gui_t_at(const double x) {
   const double t = (x - MORPHEUS_CONTROL_X) / (double)MORPHEUS_TRACK_W;
   return t < 0.0 ? 0.0 : (t > 1.0 ? 1.0 : t);
}

/** The x pixel a value sits at — the same arithmetic as \`morpheus_gui_t_at\` backwards, for the drawing. */
static double morpheus_gui_x_of(const double t) {
   return MORPHEUS_CONTROL_X + MORPHEUS_TRACK_W * (t < 0.0 ? 0.0 : (t > 1.0 ? 1.0 : t));
}

/**
 * Put a row's control where the click asked, or back to its default. Values go through Plugin.cpp.
 *
 * ⚠️ A SWITCH IGNORES WHERE INSIDE THE ROW the click landed. It has two states, and making a user hit the
 * right half of a switch is making them miss it; the row is the target and the click is the toggle. A
 * double-click still returns the control to its DEFAULT — which for a block's switch is the state the project
 * was built with, so a player can undo a switch without knowing what it was.
 */
static void morpheus_gui_set_row(const clap_plugin_t *plugin, const morpheus_gui_row_t *rows,
                                 const uint32_t row, const double t, const bool to_default) {
   const morpheus_gui_row_t *r = &rows[row];
   double v;
   if (r->stepped) {
      v = to_default ? r->def : (r->setting >= (r->min + r->max) * 0.5 ? r->min : r->max);
   } else {
      const double span = r->max - r->min;
      v = to_default ? r->def : r->min + morpheus_gui_t_at(t) * span;
   }
   morpheus_gui_param_set(plugin, r->id, v);
}
// ── THE BADGE ────────────────────────────────────────────────────────────────────────────────────────────
// ⚠️ IT IS A TABLE OF PRIMITIVES, NOT THREE DRAWINGS. One geometry, drawn by each backend with the rectangle
// and circle calls it already has — so the Windows badge and the Mac badge cannot drift into two pictures,
// which is the same reason the rows and the blocks live here.
//
// Coordinates are relative to the badge's own top-left; a backend adds MORPHEUS_BADGE_X and _Y. It is
// DECORATION: it reads no parameter, answers no click, and every project gets the same one.
#define MORPHEUS_BADGE_X ${PANEL.badgeX}
#define MORPHEUS_BADGE_Y ${PANEL.badgeY}
#define MORPHEUS_BADGE_W ${PANEL.badgeW}
#define MORPHEUS_BADGE_H ${PANEL.badgeH}
enum {
   MORPHEUS_BADGE_BOX = 0,     // outline, dim
   MORPHEUS_BADGE_BAR,         // filled, dim   — a panel recess, a grille line
   MORPHEUS_BADGE_DOT,         // filled circle, green — a knob, a speaker centre
   MORPHEUS_BADGE_LAMP,        // filled circle, amber — the pilot light, and the middle pedal's knob
   MORPHEUS_BADGE_RING,        // outlined circle, green
   MORPHEUS_BADGE_CYAN,        // filled circle, cyan — the third pedal, so no two of them are the same colour
   // ⚠️ A LINE, WHERE (x,y) IS ONE END AND (w,h) IS THE OFFSET TO THE OTHER — so w or h may be NEGATIVE, which
   // is what lets the guitar run up to the right at 45 degrees. Axis-aligned rectangles cannot draw a diagonal,
   // and a staircase of small boxes reads as a staircase.
   MORPHEUS_BADGE_LINE,
};
typedef struct { short x, y, w, h; unsigned char kind; } morpheus_gui_badge_t;

static const morpheus_gui_badge_t kMorpheusBadge[] = {
   // ── the amp head: a panel recess with five knobs and a pilot light, and a grille under it ──
   {0, 0, 120, 50, MORPHEUS_BADGE_BOX},
   {4, 4, 112, 15, MORPHEUS_BADGE_BAR},
   {10, 9, 6, 6, MORPHEUS_BADGE_DOT},
   {28, 9, 6, 6, MORPHEUS_BADGE_DOT},
   {46, 9, 6, 6, MORPHEUS_BADGE_DOT},
   {64, 9, 6, 6, MORPHEUS_BADGE_DOT},
   {82, 9, 6, 6, MORPHEUS_BADGE_DOT},
   {104, 8, 8, 8, MORPHEUS_BADGE_LAMP},
   {6, 25, 108, 3, MORPHEUS_BADGE_BAR},
   {6, 32, 108, 3, MORPHEUS_BADGE_BAR},
   {6, 39, 108, 3, MORPHEUS_BADGE_BAR},
   // ── the cabinet: THE SAME WIDTH AS THE HEAD, and a QUAD — four speakers, not one ──
   {0, 56, 120, 82, MORPHEUS_BADGE_BOX},
   {4, 60, 112, 74, MORPHEUS_BADGE_BAR},
   {12, 64, 34, 34, MORPHEUS_BADGE_RING},
   {68, 64, 34, 34, MORPHEUS_BADGE_RING},
   {12, 100, 34, 34, MORPHEUS_BADGE_RING},
   {68, 100, 34, 34, MORPHEUS_BADGE_RING},
   {24, 76, 10, 10, MORPHEUS_BADGE_DOT},
   {80, 76, 10, 10, MORPHEUS_BADGE_DOT},
   {24, 112, 10, 10, MORPHEUS_BADGE_DOT},
   {80, 112, 10, 10, MORPHEUS_BADGE_DOT},
   // ── the pedalboard: three pedals, and NO TWO THE SAME COLOUR ──
   {132, 100, 100, 38, MORPHEUS_BADGE_BOX},
   {138, 106, 26, 26, MORPHEUS_BADGE_BOX},
   {167, 106, 26, 26, MORPHEUS_BADGE_BOX},
   {196, 106, 26, 26, MORPHEUS_BADGE_BOX},
   {146, 110, 10, 4, MORPHEUS_BADGE_BAR},
   {175, 110, 10, 4, MORPHEUS_BADGE_BAR},
   {204, 110, 10, 4, MORPHEUS_BADGE_BAR},
   {146, 120, 8, 8, MORPHEUS_BADGE_DOT},
   {175, 120, 8, 8, MORPHEUS_BADGE_LAMP},
   {204, 120, 8, 8, MORPHEUS_BADGE_CYAN},
   // ── THE GUITAR: A FLYING V, leaning in the space above the board, up to the right at 45 degrees ──
   // ⚠️ IT IS AN OUTLINE, NOT A SHAPE. A round body on a straight neck read as a lollipop — Rob: "the guitar
   // looks nothing like a guitar" — because what makes a guitar recognisable at this size is its SILHOUETTE.
   // The V's two wings sweep back from the joint with the notch between them, and that concave back edge is
   // the whole shape; nothing else here would say "guitar" at 100 pixels.
   //
   // The coordinates are COMPUTED, not eyeballed: a Flying V in its own frame, rotated 45 degrees and placed.
   // The rotation is the reason MORPHEUS_BADGE_LINE exists — an axis-aligned rectangle cannot draw a diagonal.
   {166, 52, -34, 11, MORPHEUS_BADGE_LINE},
   {132, 63, 30, 1, MORPHEUS_BADGE_LINE},
   {162, 64, 1, 30, MORPHEUS_BADGE_LINE},
   {163, 94, 11, -34, MORPHEUS_BADGE_LINE},
   {174, 60, -8, -8, MORPHEUS_BADGE_LINE},
   {168, 54, 36, -37, MORPHEUS_BADGE_LINE},
   {172, 58, 37, -36, MORPHEUS_BADGE_LINE},
   {201, 14, 9, -9, MORPHEUS_BADGE_LINE},
   {210, 5, 11, 11, MORPHEUS_BADGE_LINE},
   {221, 16, -9, 9, MORPHEUS_BADGE_LINE},
   {212, 25, -11, -11, MORPHEUS_BADGE_LINE},
   {174, 44, 8, 8, MORPHEUS_BADGE_DOT},
};
// sizeof, not a count written down twice: a primitive added to the table above cannot be left undrawn.
#define MORPHEUS_BADGE_PRIMITIVES (sizeof(kMorpheusBadge) / sizeof(kMorpheusBadge[0]))

// ⭐ AND THE WORDMARK UNDER IT, which is the one part that has to be TEXT: the homepage's mark is mono,
// letter-spaced and green, so this is the same claim in the font the panel already uses. Each backend draws
// the string itself because a string is the one genuinely per-platform thing here.
#define MORPHEUS_BADGE_WORD "M O R P H E U S"
// ⚠️ A LEFT EDGE, NOT A CENTRE. Centring means measuring the string, and the three platforms measure it with
// three different calls (and X11 only if a font was loaded) — so the one thing that would drift between the
// Mac badge and the Windows badge is the one thing that has to be text. The spacing is in the string instead.
#define MORPHEUS_BADGE_WORD_X (MORPHEUS_BADGE_X + 58)
#define MORPHEUS_BADGE_WORD_Y (MORPHEUS_BADGE_Y + MORPHEUS_BADGE_H + 12)

#endif  // MORPHEUS_PLUGIN_GUI_LAYOUT_H
`;

/** The Cocoa panel. Compiled only on Apple, where the CLAP window API is `CLAP_WINDOW_API_COCOA` (an NSView). */
export const pluginGuiApple = `// ${PLUGIN_GUI_APPLE} — generated by Morpheus. This file is yours: edit it freely, and the build picks up
// your changes.
//
// The COCOA drawing backend. Everything it knows about this plugin — which rows, what they say, where the
// control is — comes from Source/PluginGuiLayout.h; what is here is NSBezierPath and a font.

#import <Cocoa/Cocoa.h>
#include "PluginGuiLayout.h"

// The panel's colours, and the same green the rest of Morpheus uses. A plugin that looks like the thing that
// built it is worth the four lines.
static NSColor *morpheusBg(void) { return [NSColor colorWithCalibratedRed:0.039 green:0.039 blue:0.043 alpha:1.0]; }
static NSColor *morpheusGreen(void) { return [NSColor colorWithCalibratedRed:0.22 green:1.0 blue:0.08 alpha:1.0]; }
static NSColor *morpheusDim(void) { return [NSColor colorWithCalibratedRed:0.10 green:0.24 blue:0.10 alpha:1.0]; }
static NSColor *morpheusText(void) { return [NSColor colorWithCalibratedRed:0.78 green:0.95 blue:0.80 alpha:1.0]; }
// The block labels: visible enough to read as a heading, dimmer than a control's own name so the rows stay
// the foreground. It is the answer to "I can't tell what's what", and it works by looking different.
static NSColor *morpheusGroupText(void) { return [NSColor colorWithCalibratedRed:0.42 green:0.62 blue:0.44 alpha:1.0]; }
// ⭐ THE AMBER. Rob asked for "a cyberpunk amber line between the different blocks", and it is doing a job
// rather than decorating: the green is what a CONTROL is, so the thing that says where the signal goes next
// has to be a different colour or the eye reads it as another control.
static NSColor *morpheusAmber(void) { return [NSColor colorWithCalibratedRed:1.0 green:0.66 blue:0.12 alpha:1.0]; }
// The third pedal's colour, so the three of them read as three pedals rather than as a row of the same thing.
static NSColor *morpheusCyan(void) { return [NSColor colorWithCalibratedRed:0.25 green:0.94 blue:1.0 alpha:1.0]; }

@interface MorpheusPanel : NSView {
  const clap_plugin_t *_plugin;
  const clap_plugin_params_t *_params;
  int _drag;              // the row being dragged inside the control area, or -1
  int _open;              // the block whose controls are shown, or -1
  int _dragBlock;         // the box a press started on, or -1
  int _dropBlock;         // where that box would land, or -1 — drawn so the drag says what it will do
  double _pressY;         // where it was pressed, so a CLICK can be told from a DRAG
  BOOL _moved;            // past the threshold: a drag, not a click
  NSTimer *_timer;
}
- (instancetype)initWithPlugin:(const clap_plugin_t *)plugin params:(const clap_plugin_params_t *)params;
- (void)stop;
@end

@implementation MorpheusPanel

- (instancetype)initWithPlugin:(const clap_plugin_t *)plugin params:(const clap_plugin_params_t *)params {
  if ((self = [super initWithFrame:NSMakeRect(0, 0, MORPHEUS_PANEL_WIDTH, morpheus_gui_height(plugin, params))])) {
    _plugin = plugin;
    _params = params;
    _drag = -1;
    _dragBlock = -1;
    _dropBlock = -1;
    _moved = NO;
    _pressY = 0.0;
    // THE FIRST BLOCK OPENS, not none: a panel that opens with nothing selected shows no control at all,
    // which reads as a plugin that has none.
    _open = 0;
    // ⚠️ COMMON MODES, NOT THE DEFAULT MODE. A scheduled timer fires in NSDefaultRunLoopMode, which STOPS
    // while a window is being dragged or a DAW is in a modal loop — so the knobs would freeze mid-drag, which
    // reads as a broken plugin. This is the one line that makes the panel feel alive.
    _timer = [NSTimer timerWithTimeInterval:1.0 / 30.0 target:self selector:@selector(tick:) userInfo:nil repeats:YES];
    [[NSRunLoop currentRunLoop] addTimer:_timer forMode:NSRunLoopCommonModes];
  }
  return self;
}

- (void)stop { [_timer invalidate]; _timer = nil; }
- (void)tick:(NSTimer *)t { (void)t; [self setNeedsDisplay:YES]; }
- (BOOL)isFlipped { return YES; }                    // row 0 at the top, so the arithmetic reads like the layout
- (BOOL)acceptsFirstMouse:(NSEvent *)e { (void)e; return YES; }

- (void)drawRect:(NSRect)dirty {
  (void)dirty;
  [morpheusBg() setFill];
  NSRectFill(self.bounds);
  NSDictionary *nameAttrs = @{
    NSFontAttributeName: [NSFont monospacedSystemFontOfSize:10 weight:NSFontWeightRegular],
    NSForegroundColorAttributeName: morpheusText(),
  };
  NSDictionary *valueAttrs = @{
    NSFontAttributeName: [NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightMedium],
    NSForegroundColorAttributeName: morpheusGreen(),
  };
  NSDictionary *boxAttrs = @{
    NSFontAttributeName: [NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightBold],
    NSForegroundColorAttributeName: morpheusGroupText(),
  };
  NSDictionary *titleAttrs = @{
    NSFontAttributeName: [NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightBold],
    NSForegroundColorAttributeName: morpheusAmber(),
  };

  morpheus_gui_row_t rows[MORPHEUS_GUI_MAX_ROWS];
  morpheus_gui_block_t blocks[MORPHEUS_GUI_MAX_BLOCKS];
  const uint32_t n = morpheus_gui_rows(_plugin, _params, rows, MORPHEUS_GUI_MAX_ROWS);
  const uint32_t nb = morpheus_gui_blocks(rows, n, blocks, MORPHEUS_GUI_MAX_BLOCKS);
  if (_open >= (int)nb) _open = nb ? 0 : -1;

  // ── THE COLUMN: one box per block, in SIGNAL order, with the amber line between them ─────────────────
  for (uint32_t b = 0; b < nb; ++b) {
    const CGFloat top = (CGFloat)morpheus_gui_box_y(b);
    const BOOL selected = ((int)b == _open);
    const BOOL landing = ((int)b == _dropBlock);
    NSBezierPath *box = [NSBezierPath bezierPathWithRoundedRect:
      NSMakeRect(MORPHEUS_BOX_X, top, MORPHEUS_BOX_W, MORPHEUS_BOX_H) xRadius:4 yRadius:4];
    [(selected || landing) ? morpheusAmber() : morpheusDim() setStroke];
    [box setLineWidth:(selected || landing) ? 2.0 : 1.0];
    [box stroke];
    [[NSString stringWithUTF8String:blocks[b].name]
      drawAtPoint:NSMakePoint(MORPHEUS_BOX_X + 12, top + 8) withAttributes:boxAttrs];
    // A PINNED BLOCK SAYS SO. The amp model and the cabinet are the pivot and the output is last: a box that
    // refused to move with no explanation reads as a bug rather than as a rule.
    if (!blocks[b].movable) {
      [[NSString stringWithUTF8String:"LOCKED"] drawAtPoint:NSMakePoint(MORPHEUS_BOX_X + MORPHEUS_BOX_W - 54, top + 9)
                                            withAttributes:@{
        NSFontAttributeName: [NSFont monospacedSystemFontOfSize:8 weight:NSFontWeightRegular],
        NSForegroundColorAttributeName: morpheusDim(),
      }];
    }
    // THE AMBER LINE, as a connector between boxes — which is what makes the column read as a signal path
    // rather than as a list of headings.
    if (b + 1 < nb) {
      NSBezierPath *link = [NSBezierPath bezierPath];
      [link moveToPoint:NSMakePoint(MORPHEUS_BOX_X + 20, top + MORPHEUS_BOX_H)];
      [link lineToPoint:NSMakePoint(MORPHEUS_BOX_X + 20, (CGFloat)morpheus_gui_box_y(b + 1))];
      [morpheusAmber() setStroke];
      [link setLineWidth:2.0];
      [link stroke];
    }
  }

  // ── THE SELECTED BLOCK'S CONTROLS, beside the column ──────────────────────────────────────────────────
  if (_open >= 0) {
    const morpheus_gui_block_t *blk = &blocks[_open];
    // …and only when it says something the first row under it does not — see morpheus_gui_block_t's \`title\`.
    if (blk->title) {
      [[NSString stringWithUTF8String:blk->name]
        drawAtPoint:NSMakePoint(MORPHEUS_TRACK_X, MORPHEUS_PAD + 2) withAttributes:titleAttrs];
    }
    for (uint32_t i = 0; i < blk->row_count; ++i) {
      const morpheus_gui_row_t *row = &rows[blk->first_row + i];
      const CGFloat y = (CGFloat)morpheus_gui_row_y(i);
      [[NSString stringWithUTF8String:row->name] drawAtPoint:NSMakePoint(MORPHEUS_LABEL_X, y + 3) withAttributes:nameAttrs];

      if (row->stepped) {
        // ── a SWITCH, not a track. The row is the target, so the switch does not have to be hit precisely;
        // the knob sits at the end the current state names, and the text on the right says it in words.
        const NSRect pill = NSMakeRect(MORPHEUS_CONTROL_X, y + (MORPHEUS_ROW - MORPHEUS_SWITCH_H) / 2.0,
                                       MORPHEUS_SWITCH_W, MORPHEUS_SWITCH_H);
        const BOOL on = row->setting >= (row->min + row->max) * 0.5;
        [(on ? morpheusGreen() : morpheusDim()) setFill];
        NSRectFill(pill);
        const CGFloat knobX = on ? (MORPHEUS_CONTROL_X + MORPHEUS_SWITCH_W - MORPHEUS_SWITCH_H) : MORPHEUS_CONTROL_X;
        NSBezierPath *knob = [NSBezierPath bezierPathWithOvalInRect:
          NSMakeRect(knobX + 1, pill.origin.y + 1, MORPHEUS_SWITCH_H - 2, MORPHEUS_SWITCH_H - 2)];
        [morpheusBg() setFill];
        [knob fill];
        [morpheusGreen() setStroke];
        [knob setLineWidth:2.0];
        [knob stroke];
      } else {
        const NSRect track = NSMakeRect(MORPHEUS_CONTROL_X, y + 11, MORPHEUS_TRACK_W, 4);
        [morpheusDim() setFill];
        NSRectFill(track);
        NSRect filled = track;
        filled.size.width = (CGFloat)(MORPHEUS_TRACK_W * row->t);
        [morpheusGreen() setFill];
        NSRectFill(filled);

        // A circle rather than a handle: it reads as a control rather than as a scrollbar.
        const CGFloat knobX = (CGFloat)morpheus_gui_x_of(row->t);
        NSBezierPath *knob = [NSBezierPath bezierPathWithOvalInRect:NSMakeRect(knobX - MORPHEUS_KNOB_R, y + 7, MORPHEUS_KNOB_R * 2, MORPHEUS_KNOB_R * 2)];
        [morpheusBg() setFill];
        [knob fill];
        [morpheusGreen() setStroke];
        [knob setLineWidth:2.0];
        [knob stroke];
      }

      NSString *shown = [NSString stringWithUTF8String:row->value];
      const NSSize size = [shown sizeWithAttributes:valueAttrs];
      [shown drawAtPoint:NSMakePoint(MORPHEUS_PANEL_WIDTH - MORPHEUS_PAD - size.width, y + 2) withAttributes:valueAttrs];
    }
  }

  // ── THE BADGE, and the wordmark under it ──────────────────────────────────────────────────────────────
  // The geometry is in the shared header so the three backends draw one picture; what is here is the four
  // primitives it is made of. It sits in the space the controls do not reach, which is why the panel's fixed
  // height is a gift rather than a compromise.
  for (size_t bi = 0; bi < MORPHEUS_BADGE_PRIMITIVES; ++bi) {
    const morpheus_gui_badge_t *b = &kMorpheusBadge[bi];
    const NSRect r = NSMakeRect(MORPHEUS_BADGE_X + b->x, MORPHEUS_BADGE_Y + b->y, b->w, b->h);
    switch (b->kind) {
      case MORPHEUS_BADGE_BAR:
        [morpheusDim() setFill];
        NSRectFill(r);
        break;
      case MORPHEUS_BADGE_DOT:
      case MORPHEUS_BADGE_LAMP:
      case MORPHEUS_BADGE_CYAN: {
        NSBezierPath *dot = [NSBezierPath bezierPathWithOvalInRect:r];
        NSColor *ink = b->kind == MORPHEUS_BADGE_LAMP ? morpheusAmber()
                    : (b->kind == MORPHEUS_BADGE_CYAN ? morpheusCyan() : morpheusGreen());
        [ink setFill];
        [dot fill];
        break;
      }
      case MORPHEUS_BADGE_LINE: {
        // (x,y) to (x+w, y+h) — and w is positive here while h is negative, which is the 45 degrees.
        NSBezierPath *line = [NSBezierPath bezierPath];
        [line moveToPoint:NSMakePoint(MORPHEUS_BADGE_X + b->x, MORPHEUS_BADGE_Y + b->y)];
        [line lineToPoint:NSMakePoint(MORPHEUS_BADGE_X + b->x + b->w, MORPHEUS_BADGE_Y + b->y + b->h)];
        [line setLineWidth:1.5];
        [morpheusGreen() setStroke];
        [line stroke];
        break;
      }
      case MORPHEUS_BADGE_RING: {
        NSBezierPath *ring = [NSBezierPath bezierPathWithOvalInRect:r];
        [ring setLineWidth:1.5];
        [morpheusGreen() setStroke];
        [ring stroke];
        break;
      }
      default: {
        NSBezierPath *box = [NSBezierPath bezierPathWithRect:r];
        [box setLineWidth:1.0];
        [morpheusDim() setStroke];
        [box stroke];
        break;
      }
    }
  }
  {
    NSDictionary *wordAttrs = @{
      NSFontAttributeName: [NSFont monospacedSystemFontOfSize:13 weight:NSFontWeightBold],
      NSForegroundColorAttributeName: morpheusGreen(),
    };
    [[NSString stringWithUTF8String:MORPHEUS_BADGE_WORD]
      drawAtPoint:NSMakePoint(MORPHEUS_BADGE_WORD_X, MORPHEUS_BADGE_WORD_Y) withAttributes:wordAttrs];
  }
}

- (void)mouseDown:(NSEvent *)event {
  const NSPoint p = [self convertPoint:[event locationInWindow] fromView:nil];
  morpheus_gui_row_t rows[MORPHEUS_GUI_MAX_ROWS];
  morpheus_gui_block_t blocks[MORPHEUS_GUI_MAX_BLOCKS];
  const uint32_t n = morpheus_gui_rows(_plugin, _params, rows, MORPHEUS_GUI_MAX_ROWS);
  const uint32_t nb = morpheus_gui_blocks(rows, n, blocks, MORPHEUS_GUI_MAX_BLOCKS);

  // ── A BOX: select it, and arm a drag if the PLUGIN says it may move ───────────────────────────────────
  const int box = morpheus_gui_box_at(p.x, p.y, nb);
  if (box >= 0) {
    _open = box;
    _dropBlock = box;
    _pressY = p.y;
    _moved = NO;
    // The plugin answers, not the panel — a pinned box still OPENS, it just does not move.
    _dragBlock = blocks[box].movable ? box : -1;
    [self setNeedsDisplay:YES];
    return;
  }

  if (_open < 0) return;
  const morpheus_gui_block_t *blk = &blocks[_open];
  const int within = morpheus_gui_row_at(p.x, p.y, blk->row_count);
  if (within < 0) return;
  const uint32_t row = blk->first_row + (uint32_t)within;
  // A double-click puts a row back where it started. Every hardware control has a way back to its default and
  // a slider otherwise has none but the host's undo — and for a block's switch the default is the state the
  // project was BUILT with, so this is how a player undoes a switch they do not remember moving.
  if ([event clickCount] == 2) {
    morpheus_gui_set_row(_plugin, rows, row, 0.0, true);
    [self setNeedsDisplay:YES];
    return;
  }
  // ⚠️ A SWITCH IS A CLICK AND NOT A DRAG. Dragging one would only be a way to change nothing slowly, and it
  // would also leave the switch following the pointer along a track it does not have.
  _drag = !rows[row].stepped ? (int)row : -1;
  morpheus_gui_set_row(_plugin, rows, row, p.x, false);
  [self setNeedsDisplay:YES];
}

- (void)mouseDragged:(NSEvent *)event {
  const NSPoint p = [self convertPoint:[event locationInWindow] fromView:nil];
  if (_dragBlock >= 0) {
    // ⚠️ A CLICK AND A DRAG BEGIN THE SAME WAY, so the threshold is what tells them apart. Without it every
    // click on a block would be a one-pixel reorder, and every reorder would fight the click that opened it.
    if (!_moved && (p.y - _pressY > 4.0 || _pressY - p.y > 4.0)) _moved = YES;
    if (_moved) {
      morpheus_gui_row_t rows[MORPHEUS_GUI_MAX_ROWS];
      morpheus_gui_block_t blocks[MORPHEUS_GUI_MAX_BLOCKS];
      const uint32_t n = morpheus_gui_rows(_plugin, _params, rows, MORPHEUS_GUI_MAX_ROWS);
      const uint32_t nb = morpheus_gui_blocks(rows, n, blocks, MORPHEUS_GUI_MAX_BLOCKS);
      const int over = morpheus_gui_box_at(p.x, p.y, nb);
      // Dragged off the column entirely: KEEP the last box it was over rather than losing the drag, which
      // would make a fast drag past the edge do nothing.
      if (over >= 0) _dropBlock = over;
      [self setNeedsDisplay:YES];
    }
    return;
  }
  if (_drag < 0) return;
  morpheus_gui_row_t rows[MORPHEUS_GUI_MAX_ROWS];
  const uint32_t n = morpheus_gui_rows(_plugin, _params, rows, MORPHEUS_GUI_MAX_ROWS);
  if ((uint32_t)_drag < n) morpheus_gui_set_row(_plugin, rows, (uint32_t)_drag, p.x, false);
  [self setNeedsDisplay:YES];
}

- (void)mouseUp:(NSEvent *)event {
  (void)event;
  if (_dragBlock >= 0 && _moved && _dropBlock >= 0 && _dropBlock != _dragBlock) {
    morpheus_gui_row_t rows[MORPHEUS_GUI_MAX_ROWS];
    morpheus_gui_block_t blocks[MORPHEUS_GUI_MAX_BLOCKS];
    const uint32_t n = morpheus_gui_rows(_plugin, _params, rows, MORPHEUS_GUI_MAX_ROWS);
    const uint32_t nb = morpheus_gui_blocks(rows, n, blocks, MORPHEUS_GUI_MAX_BLOCKS);
    uint32_t order[MORPHEUS_GUI_MAX_BLOCKS];
    morpheus_gui_reorder(blocks, nb, (uint32_t)_dragBlock, (uint32_t)_dropBlock, order);
    // ⚠️ THE PANEL SHOWS WHAT THE PLUGIN ACCEPTED, NOT WHAT THE MOUSE DID. If the order is refused the column
    // snaps back to what is actually running, because drawing the drop would be the panel lying about the
    // plugin's own state — and the plugin is the one that owns the rule.
    if (morpheus_gui_set_order(_plugin, order, nb)) _open = _dropBlock;
    else _open = _dragBlock;
    [self setNeedsDisplay:YES];
  }
  _drag = -1;
  _dragBlock = -1;
  _dropBlock = -1;
  _moved = NO;
}

@end

// ── the CLAP interface ──────────────────────────────────────────────────────────────────────────────────
namespace {
bool gui_is_api_supported(const clap_plugin_t *plugin, const char *api, bool is_floating) {
  (void)plugin;
  // EMBEDDED WINDOWS ONLY. A floating window is one the plugin owns and positions itself, which a plugin
  // embedded in a host's window manager has no business doing — and refusing it here is what lets every host
  // fall back to putting our view inside its window instead.
  if (is_floating) return false;
  return api && !strcmp(api, CLAP_WINDOW_API_COCOA);
}

bool gui_get_preferred_api(const clap_plugin_t *plugin, const char **api, bool *is_floating) {
  (void)plugin;
  *api = CLAP_WINDOW_API_COCOA;
  *is_floating = false;
  return true;
}

bool gui_create(const clap_plugin_t *plugin, const char *api, bool is_floating) {
  if (!gui_is_api_supported(plugin, api, is_floating)) return false;
  const clap_plugin_params_t *params = (const clap_plugin_params_t *)plugin->get_extension(plugin, CLAP_EXT_PARAMS);
  if (!params) return false;
  MorpheusPanel *view = [[MorpheusPanel alloc] initWithPlugin:plugin params:params];
  morpheus_gui_set_state(plugin, (void *)CFBridgingRetain(view));
  return true;
}

MorpheusPanel *panel_of(const clap_plugin_t *plugin) {
  void *state = morpheus_gui_state(plugin);
  return state ? (__bridge MorpheusPanel *)state : nil;
}

void gui_destroy(const clap_plugin_t *plugin) {
  MorpheusPanel *view = panel_of(plugin);
  if (!view) return;
  [view stop];
  [view removeFromSuperview];
  CFRelease((__bridge CFTypeRef)view);
  morpheus_gui_set_state(plugin, nullptr);
}

bool gui_set_scale(const clap_plugin_t *plugin, double scale) { (void)plugin; (void)scale; return true; }

bool gui_get_size(const clap_plugin_t *plugin, uint32_t *width, uint32_t *height) {
  MorpheusPanel *view = panel_of(plugin);
  if (!view) return false;
  *width = (uint32_t)view.frame.size.width;
  *height = (uint32_t)view.frame.size.height;
  return true;
}

bool gui_can_resize(const clap_plugin_t *plugin) { (void)plugin; return false; }
bool gui_adjust_size(const clap_plugin_t *plugin, uint32_t *w, uint32_t *h) { (void)plugin; (void)w; (void)h; return false; }
bool gui_set_size(const clap_plugin_t *plugin, uint32_t w, uint32_t h) { (void)plugin; (void)w; (void)h; return false; }
bool gui_set_transient(const clap_plugin_t *plugin, const clap_window_t *w) { (void)plugin; (void)w; return false; }
void gui_suggest_title(const clap_plugin_t *plugin, const char *title) { (void)plugin; (void)title; }

bool gui_set_parent(const clap_plugin_t *plugin, const clap_window_t *window) {
  MorpheusPanel *view = panel_of(plugin);
  if (!view || !window) return false;
  if (!window->api || strcmp(window->api, CLAP_WINDOW_API_COCOA)) return false;
  NSView *parent = (__bridge NSView *)window->cocoa;
  if (!parent) return false;
  [parent addSubview:view];
  return true;
}

bool gui_show(const clap_plugin_t *plugin) {
  MorpheusPanel *view = panel_of(plugin);
  if (!view) return false;
  [view setHidden:NO];
  [view setNeedsDisplay:YES];
  return true;
}

bool gui_hide(const clap_plugin_t *plugin) {
  MorpheusPanel *view = panel_of(plugin);
  if (!view) return false;
  [view setHidden:YES];
  return true;
}

const clap_plugin_gui_t s_gui = {
  .is_api_supported = gui_is_api_supported,
  .get_preferred_api = gui_get_preferred_api,
  .create = gui_create,
  .destroy = gui_destroy,
  .set_scale = gui_set_scale,
  .get_size = gui_get_size,
  .can_resize = gui_can_resize,
  .adjust_size = gui_adjust_size,
  .set_size = gui_set_size,
  .set_parent = gui_set_parent,
  .set_transient = gui_set_transient,
  .suggest_title = gui_suggest_title,
  .show = gui_show,
  .hide = gui_hide,
};
}  // namespace

extern "C" const clap_plugin_gui_t *morpheus_gui_extension(void) { return &s_gui; }
`;

/**
 * The Windows panel: a child HWND and GDI.
 *
 * ⚠️ WHY THIS ONE NEEDS NO EVENT THREAD. Windows delivers messages to a window through the thread that owns
 * it, and our window is a CHILD of the host's — so the host's own message loop dispatches our `WM_PAINT`,
 * `WM_LBUTTONDOWN` and `WM_TIMER` for free. The X11 panel below has no such luxury and has to run its own.
 */
export const pluginGuiWindows = `// ${PLUGIN_GUI_WINDOWS} — generated by Morpheus. This file is yours: edit it freely, and the build picks up
// your changes.
//
// The WIN32 + GDI drawing backend. Which rows exist, what they say and where a click lands comes from
// Source/PluginGuiLayout.h; what is here is a child window, four GDI calls and a font.

#include "PluginGuiLayout.h"

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

namespace {
const wchar_t *kClassName = L"MorpheusPanelClass";

struct Panel {
   const clap_plugin_t *plugin;
   const clap_plugin_params_t *params;
   int drag;
   // ⭐ THE BLOCK STATE, the same five fields Cocoa carries — the interaction is identical on every platform
   // and only the event source differs. open is the block whose controls are drawn, dragBlock the box a press
   // started on, dropBlock where it would land, pressY what tells a CLICK from a DRAG, and moved whether the
   // pointer has crossed that threshold.
   int open;
   int dragBlock;
   int dropBlock;
   double pressY;
   int moved;
   HWND hwnd;
   HFONT font;
   HFONT fontBold;
   HBRUSH bg;
   HBRUSH dim;
   HBRUSH green;
   // The amber the signal path is drawn in: a box's outline when it is open or being dropped on, and the
   // connector between boxes.
   HBRUSH amber;
   HBRUSH cyan;
};

const COLORREF kBg = RGB(10, 10, 11);
const COLORREF kGreen = RGB(56, 255, 20);
const COLORREF kDim = RGB(26, 61, 26);
const COLORREF kText = RGB(199, 242, 204);
// The block labels: readable as headings, dimmer than a control's own name, so the rows stay the foreground.
const COLORREF kGroupText = RGB(107, 158, 112);
// ⭐ THE AMBER. Rob asked for "a cyberpunk amber line between the different blocks", and it is doing a job
// rather than decorating: the green is what a CONTROL is, so the thing that says where the signal goes next
// has to be a different colour or the eye reads it as another control. Cocoa's calibrated (1.0, 0.66, 0.12)
// is this in 8 bits.
const COLORREF kAmber = RGB(255, 168, 31);
// The third pedal's colour — see kMorpheusBadge's MORPHEUS_BADGE_CYAN.
const COLORREF kCyan = RGB(64, 240, 255);

Panel *panel_of(const clap_plugin_t *plugin) { return (Panel *)morpheus_gui_state(plugin); }

void fill(HDC dc, HBRUSH brush, int x, int y, int w, int h) {
   RECT r = {x, y, x + w, y + h};
   FillRect(dc, &r, brush);
}

/**
 * Everything the panel draws, from the shared rows.
 *
 * ⚠️ FONT HEIGHT, NOT POINT SIZE. \`CreateFontW\` with a POSITIVE height asks for a cell height that includes
 * the leading, so a face asked for as 10 comes out looking like 13 and the rows overflow the arithmetic the
 * layout header did; negative means "character height", which is what the layout assumes. The face name is a
 * REQUEST, not a requirement — Windows substitutes when a machine has no Consolas, which is the right
 * behaviour for a plugin.
 */
void paint(HWND hwnd, Panel *p) {
   PAINTSTRUCT ps;
   HDC dc = BeginPaint(hwnd, &ps);
   RECT whole;
   GetClientRect(hwnd, &whole);
   fill(dc, p->bg, 0, 0, whole.right, whole.bottom);
   SetBkMode(dc, TRANSPARENT);

   morpheus_gui_row_t rows[MORPHEUS_GUI_MAX_ROWS];
   morpheus_gui_block_t blocks[MORPHEUS_GUI_MAX_BLOCKS];
   const uint32_t n = morpheus_gui_rows(p->plugin, p->params, rows, MORPHEUS_GUI_MAX_ROWS);
   const uint32_t nb = morpheus_gui_blocks(rows, n, blocks, MORPHEUS_GUI_MAX_BLOCKS);
   // A chain that shrank under us — the plugin's own order can change — must not index a block that is gone.
   if (p->open >= (int)nb) p->open = nb ? 0 : -1;

   // ── THE COLUMN: one box per block, in SIGNAL order, with the amber line between them ─────────────────
   for (uint32_t b = 0; b < nb; ++b) {
      const int top = (int)morpheus_gui_box_y(b);
      const int selected = ((int)b == p->open);
      const int landing = ((int)b == p->dropBlock);
      // THE OUTLINE is the only thing that says which box is open. GDI's RoundRect is the nearest thing to
      // Cocoa's rounded rect, and a NULL_BRUSH makes it an outline rather than a filled shape.
      HPEN boxPen = CreatePen(PS_SOLID, (selected || landing) ? 2 : 1, (selected || landing) ? kAmber : kDim);
      HGDIOBJ oldPen = SelectObject(dc, boxPen);
      HGDIOBJ oldBrush = SelectObject(dc, GetStockObject(NULL_BRUSH));
      RoundRect(dc, MORPHEUS_BOX_X, top, MORPHEUS_BOX_X + MORPHEUS_BOX_W, top + MORPHEUS_BOX_H, 8, 8);
      SelectObject(dc, oldBrush);
      SelectObject(dc, oldPen);
      DeleteObject(boxPen);

      SelectObject(dc, p->font);
      SetTextColor(dc, kGroupText);
      TextOutA(dc, MORPHEUS_BOX_X + 12, top + 8, blocks[b].name, (int)strlen(blocks[b].name));
      // A PINNED BLOCK SAYS SO. The amp model and the cabinet are the pivot and the output is last: a box that
      // refused to move with no explanation reads as a bug rather than as a rule.
      if (!blocks[b].movable) {
         SetTextColor(dc, kDim);
         TextOutA(dc, MORPHEUS_BOX_X + MORPHEUS_BOX_W - 54, top + 9, "LOCKED", 6);
      }
      // THE AMBER LINE, as a connector between boxes — which is what makes the column read as a signal path
      // rather than as a list of headings.
      if (b + 1 < nb) {
         fill(dc, p->amber, MORPHEUS_BOX_X + 20, top + MORPHEUS_BOX_H, 2,
              (int)morpheus_gui_box_y(b + 1) - (top + MORPHEUS_BOX_H));
      }
   }

   // ── THE SELECTED BLOCK'S CONTROLS, beside the column ──────────────────────────────────────────────────
   if (p->open >= 0) {
      const morpheus_gui_block_t *blk = &blocks[p->open];
      // …and only when it says something the first row under it does not — see morpheus_gui_block_t's \`title\`.
      if (blk->title) {
         SelectObject(dc, p->fontBold);
         SetTextColor(dc, kAmber);
         TextOutA(dc, MORPHEUS_TRACK_X, MORPHEUS_PAD + 2, blk->name, (int)strlen(blk->name));
      }
      for (uint32_t i = 0; i < blk->row_count; ++i) {
         const morpheus_gui_row_t *row = &rows[blk->first_row + i];
         // ⚠️ THE ROW'S POSITION WITHIN ITS BLOCK, NOT ITS INDEX IN THE ROW ARRAY — the control area shows one
         // block, so the rows drawn there are always 0..row_count-1. The name is in the control area now,
         // because the box column took the left of the panel.
         const int y = (int)morpheus_gui_row_y(i);
         SelectObject(dc, p->font);
         SetTextColor(dc, kText);
         TextOutA(dc, MORPHEUS_LABEL_X, y + 3, row->name, (int)strlen(row->name));

         if (row->stepped) {
            // ── a SWITCH. The row is the target, so the pill does not have to be hit precisely: a click
            // anywhere on the row toggles it, and the text on the right says which state it moved to.
            const int sy = y + (MORPHEUS_ROW - MORPHEUS_SWITCH_H) / 2;
            const int on = row->setting >= (row->min + row->max) * 0.5;
            fill(dc, on ? p->green : p->dim, MORPHEUS_CONTROL_X, sy, MORPHEUS_SWITCH_W, MORPHEUS_SWITCH_H);
            const int knobX = on ? (MORPHEUS_CONTROL_X + MORPHEUS_SWITCH_W - MORPHEUS_SWITCH_H) : MORPHEUS_CONTROL_X;
            HBRUSH ring = CreateSolidBrush(kBg);
            HPEN pen = CreatePen(PS_SOLID, 2, kGreen);
            HGDIOBJ oldRing = SelectObject(dc, ring);
            HGDIOBJ oldKnobPen = SelectObject(dc, pen);
            Ellipse(dc, knobX + 1, sy + 1, knobX + MORPHEUS_SWITCH_H - 1, sy + MORPHEUS_SWITCH_H - 1);
            SelectObject(dc, oldRing);
            SelectObject(dc, oldKnobPen);
            DeleteObject(ring);
            DeleteObject(pen);
         } else {
            fill(dc, p->dim, MORPHEUS_CONTROL_X, y + 11, MORPHEUS_TRACK_W, 4);
            fill(dc, p->green, MORPHEUS_CONTROL_X, y + 11, (int)(MORPHEUS_TRACK_W * row->t), 4);

            const int knobX = (int)morpheus_gui_x_of(row->t);
            HBRUSH ring = CreateSolidBrush(kBg);
            HPEN pen = CreatePen(PS_SOLID, 2, kGreen);
            HGDIOBJ oldRing = SelectObject(dc, ring);
            HGDIOBJ oldKnobPen = SelectObject(dc, pen);
            Ellipse(dc, knobX - MORPHEUS_KNOB_R, y + 7, knobX + MORPHEUS_KNOB_R, y + 7 + MORPHEUS_KNOB_R * 2);
            SelectObject(dc, oldRing);
            SelectObject(dc, oldKnobPen);
            DeleteObject(ring);
            DeleteObject(pen);
         }

         SelectObject(dc, p->fontBold);
         SetTextColor(dc, kGreen);
         SIZE size = {0, 0};
         GetTextExtentPoint32A(dc, row->value, (int)strlen(row->value), &size);
         TextOutA(dc, MORPHEUS_PANEL_WIDTH - MORPHEUS_PAD - size.cx, y + 2, row->value, (int)strlen(row->value));
      }
   }
   // ── THE BADGE, and the wordmark under it ──────────────────────────────────────────────────────────────
   // The geometry is in the shared header, so this is the same picture the Mac panel draws — see
   // kMorpheusBadge. GDI's Rectangle draws with the current pen and brush, so an outline is a NULL_BRUSH.
   for (size_t bi = 0; bi < MORPHEUS_BADGE_PRIMITIVES; ++bi) {
      const morpheus_gui_badge_t *b = &kMorpheusBadge[bi];
      const int bx = MORPHEUS_BADGE_X + b->x, by = MORPHEUS_BADGE_Y + b->y;
      if (b->kind == MORPHEUS_BADGE_BAR) { fill(dc, p->dim, bx, by, b->w, b->h); continue; }
      if (b->kind == MORPHEUS_BADGE_DOT || b->kind == MORPHEUS_BADGE_LAMP || b->kind == MORPHEUS_BADGE_CYAN) {
         HGDIOBJ oldBrush = SelectObject(dc, b->kind == MORPHEUS_BADGE_LAMP ? p->amber
                                                : (b->kind == MORPHEUS_BADGE_CYAN ? p->cyan : p->green));
         Ellipse(dc, bx, by, bx + b->w, by + b->h);
         SelectObject(dc, oldBrush);
         continue;
      }
      if (b->kind == MORPHEUS_BADGE_LINE) {
         // GDI draws a diagonal, so the guitar needs no staircase — MoveToEx/LineTo, and the pen owns the width.
         HPEN linePen = CreatePen(PS_SOLID, 2, kGreen);
         HGDIOBJ oldLinePen = SelectObject(dc, linePen);
         MoveToEx(dc, bx, by, NULL);
         LineTo(dc, bx + b->w, by + b->h);
         SelectObject(dc, oldLinePen);
         DeleteObject(linePen);
         continue;
      }
      HPEN pen = CreatePen(PS_SOLID, b->kind == MORPHEUS_BADGE_RING ? 2 : 1,
                           b->kind == MORPHEUS_BADGE_RING ? kGreen : kDim);
      HGDIOBJ oldPen = SelectObject(dc, pen);
      HGDIOBJ oldBrush = SelectObject(dc, GetStockObject(NULL_BRUSH));
      if (b->kind == MORPHEUS_BADGE_RING) Ellipse(dc, bx, by, bx + b->w, by + b->h);
      else Rectangle(dc, bx, by, bx + b->w, by + b->h);
      SelectObject(dc, oldBrush);
      SelectObject(dc, oldPen);
      DeleteObject(pen);
   }
   SelectObject(dc, p->fontBold);
   SetTextColor(dc, kGreen);
   TextOutA(dc, MORPHEUS_BADGE_WORD_X, MORPHEUS_BADGE_WORD_Y, MORPHEUS_BADGE_WORD, (int)strlen(MORPHEUS_BADGE_WORD));
   EndPaint(hwnd, &ps);
}

LRESULT CALLBACK panel_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
   Panel *p = (Panel *)GetWindowLongPtrW(hwnd, GWLP_USERDATA);
   switch (msg) {
      case WM_NCCREATE: {
         CREATESTRUCTW *cs = (CREATESTRUCTW *)lp;
         SetWindowLongPtrW(hwnd, GWLP_USERDATA, (LONG_PTR)cs->lpCreateParams);
         return TRUE;
      }
      case WM_PAINT:
         if (p) paint(hwnd, p);
         return 0;
      case WM_ERASEBKGND:
         return 1;   // the paint covers every pixel; erasing first is a visible flash
      case WM_TIMER:
         // ⚠️ THE REDRAW IS THE POINT. A host may automate a parameter with no mouse involved, and the only
         // source of truth for the current value is the plugin's own params extension.
         InvalidateRect(hwnd, nullptr, FALSE);
         return 0;
      case WM_LBUTTONDOWN: {
         if (!p) return 0;
         morpheus_gui_row_t rows[MORPHEUS_GUI_MAX_ROWS];
         morpheus_gui_block_t blocks[MORPHEUS_GUI_MAX_BLOCKS];
         const uint32_t n = morpheus_gui_rows(p->plugin, p->params, rows, MORPHEUS_GUI_MAX_ROWS);
         const uint32_t nb = morpheus_gui_blocks(rows, n, blocks, MORPHEUS_GUI_MAX_BLOCKS);
         if (p->open >= (int)nb) p->open = nb ? 0 : -1;

         // ── A BOX: select it, and arm a drag if the PLUGIN says it may move ─────────────────────────────
         const int box = morpheus_gui_box_at((double)LOWORD(lp), (double)HIWORD(lp), nb);
         if (box >= 0) {
            p->open = box;
            p->dropBlock = box;
            p->pressY = (double)HIWORD(lp);
            p->moved = 0;
            // The plugin answers, not the panel — a pinned box still OPENS, it just does not move.
            p->dragBlock = blocks[box].movable ? box : -1;
            SetCapture(hwnd);
            InvalidateRect(hwnd, nullptr, FALSE);
            return 0;
         }

         if (p->open < 0) return 0;
         const morpheus_gui_block_t *blk = &blocks[p->open];
         // ⚠️ THE HIT IS WITHIN THE SELECTED BLOCK; the absolute row is what the layout is handed.
         const int within = morpheus_gui_row_at((double)LOWORD(lp), (double)HIWORD(lp), blk->row_count);
         if (within < 0) return 0;
         const uint32_t row = blk->first_row + (uint32_t)within;
         morpheus_gui_set_row(p->plugin, rows, row, (double)LOWORD(lp), false);
         // A switch is a click, not a drag: following the pointer would be a way to change nothing slowly.
         p->drag = rows[row].stepped ? -1 : (int)row;
         SetCapture(hwnd);
         InvalidateRect(hwnd, nullptr, FALSE);
         return 0;
      }
      case WM_LBUTTONDBLCLK: {
         if (!p) return 0;
         // A double-click puts a row back where it started. CS_DBLCLKS on the class is what delivers this
         // message at all — without it a double-click arrives as two single clicks and the gesture turns into
         // two nudges towards the same place. For a block's switch the default is the state the project was
         // BUILT with, so this is how a player undoes a switch they do not remember moving. A double-click on
         // a BOX lands here too and does nothing, because the first press already opened it.
         morpheus_gui_row_t rows[MORPHEUS_GUI_MAX_ROWS];
         morpheus_gui_block_t blocks[MORPHEUS_GUI_MAX_BLOCKS];
         const uint32_t n = morpheus_gui_rows(p->plugin, p->params, rows, MORPHEUS_GUI_MAX_ROWS);
         const uint32_t nb = morpheus_gui_blocks(rows, n, blocks, MORPHEUS_GUI_MAX_BLOCKS);
         if (p->open < 0 || p->open >= (int)nb) return 0;
         const int within = morpheus_gui_row_at((double)LOWORD(lp), (double)HIWORD(lp), blocks[p->open].row_count);
         if (within >= 0) {
            morpheus_gui_set_row(p->plugin, rows, blocks[p->open].first_row + (uint32_t)within, 0.0, true);
            InvalidateRect(hwnd, nullptr, FALSE);
         }
         return 0;
      }
      case WM_MOUSEMOVE:
         if (p && p->dragBlock >= 0) {
            // ⚠️ A CLICK AND A DRAG BEGIN THE SAME WAY, so the threshold is what tells them apart. Without it
            // every click on a box would be a one-pixel reorder, and every reorder would fight the click that
            // opened it.
            const double y = (double)HIWORD(lp);
            if (!p->moved && (y - p->pressY > 4.0 || p->pressY - y > 4.0)) p->moved = 1;
            if (p->moved) {
               morpheus_gui_row_t rows[MORPHEUS_GUI_MAX_ROWS];
               morpheus_gui_block_t blocks[MORPHEUS_GUI_MAX_BLOCKS];
               const uint32_t n = morpheus_gui_rows(p->plugin, p->params, rows, MORPHEUS_GUI_MAX_ROWS);
               const uint32_t nb = morpheus_gui_blocks(rows, n, blocks, MORPHEUS_GUI_MAX_BLOCKS);
               const int over = morpheus_gui_box_at((double)LOWORD(lp), y, nb);
               // Dragged off the column entirely: KEEP the last box it was over rather than losing the drag,
               // which would make a fast drag past the edge do nothing.
               if (over >= 0) p->dropBlock = over;
               InvalidateRect(hwnd, nullptr, FALSE);
            }
            return 0;
         }
         if (p && p->drag >= 0) {
            morpheus_gui_row_t rows[MORPHEUS_GUI_MAX_ROWS];
            const uint32_t n = morpheus_gui_rows(p->plugin, p->params, rows, MORPHEUS_GUI_MAX_ROWS);
            if ((uint32_t)p->drag < n) morpheus_gui_set_row(p->plugin, rows, (uint32_t)p->drag, (double)LOWORD(lp), false);
            InvalidateRect(hwnd, nullptr, FALSE);
         }
         return 0;
      case WM_LBUTTONUP:
         if (p) {
            if (p->dragBlock >= 0 && p->moved && p->dropBlock >= 0 && p->dropBlock != p->dragBlock) {
               morpheus_gui_row_t rows[MORPHEUS_GUI_MAX_ROWS];
               morpheus_gui_block_t blocks[MORPHEUS_GUI_MAX_BLOCKS];
               const uint32_t n = morpheus_gui_rows(p->plugin, p->params, rows, MORPHEUS_GUI_MAX_ROWS);
               const uint32_t nb = morpheus_gui_blocks(rows, n, blocks, MORPHEUS_GUI_MAX_BLOCKS);
               uint32_t order[MORPHEUS_GUI_MAX_BLOCKS];
               morpheus_gui_reorder(blocks, nb, (uint32_t)p->dragBlock, (uint32_t)p->dropBlock, order);
               // ⚠️ THE PANEL SHOWS WHAT THE PLUGIN ACCEPTED, NOT WHAT THE MOUSE DID. If the order is refused
               // the column snaps back to what is actually running, because drawing the drop would be the panel
               // lying about the plugin's own state — and the plugin is the one that owns the rule.
               if (morpheus_gui_set_order(p->plugin, order, nb)) p->open = p->dropBlock;
               else p->open = p->dragBlock;
               InvalidateRect(hwnd, nullptr, FALSE);
            }
            p->drag = -1;
            p->dragBlock = -1;
            p->dropBlock = -1;
            p->moved = 0;
            ReleaseCapture();
         }
         return 0;
      case WM_DESTROY:
         if (p) { KillTimer(hwnd, 1); p->hwnd = nullptr; }
         return 0;
      default:
         return DefWindowProcW(hwnd, msg, wp, lp);
   }
}
}  // namespace

// ── the CLAP interface ──────────────────────────────────────────────────────────────────────────────────
namespace {
bool gui_is_api_supported(const clap_plugin_t *plugin, const char *api, bool is_floating) {
   (void)plugin;
   if (is_floating) return false;   // embedded only: a plugin does not own the host's window manager
   return api && !strcmp(api, CLAP_WINDOW_API_WIN32);
}

bool gui_get_preferred_api(const clap_plugin_t *plugin, const char **api, bool *is_floating) {
   (void)plugin;
   *api = CLAP_WINDOW_API_WIN32;
   *is_floating = false;
   return true;
}

bool gui_create(const clap_plugin_t *plugin, const char *api, bool is_floating) {
   if (!gui_is_api_supported(plugin, api, is_floating)) return false;
   const clap_plugin_params_t *params = (const clap_plugin_params_t *)plugin->get_extension(plugin, CLAP_EXT_PARAMS);
   if (!params) return false;

   // The class is registered once per process, not once per plugin instance: two instances of this plugin in
   // one host is an ordinary thing, and registering the same name twice fails on the second.
   static bool registered = false;
   if (!registered) {
      WNDCLASSEXW wc;
      memset(&wc, 0, sizeof(wc));
      wc.cbSize = sizeof(wc);
      wc.lpfnWndProc = panel_proc;
      wc.style = CS_DBLCLKS;
      wc.hInstance = GetModuleHandleW(nullptr);
      wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
      wc.lpszClassName = kClassName;
      if (!RegisterClassExW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return false;
      registered = true;
   }

   Panel *p = new Panel();
   p->plugin = plugin;
   p->params = params;
   p->drag = -1;
   // THE FIRST BLOCK OPENS, not none: a panel that opens with nothing selected shows no control at all,
   // which reads as a plugin that has none.
   p->open = 0;
   p->dragBlock = -1;
   p->dropBlock = -1;
   p->pressY = 0.0;
   p->moved = 0;
   p->hwnd = nullptr;
   p->bg = CreateSolidBrush(kBg);
   p->dim = CreateSolidBrush(kDim);
   p->green = CreateSolidBrush(kGreen);
   p->amber = CreateSolidBrush(kAmber);
   p->cyan = CreateSolidBrush(kCyan);
   p->font = CreateFontW(-13, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                         CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, FIXED_PITCH | FF_MODERN, L"Consolas");
   p->fontBold = CreateFontW(-14, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                             CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, FIXED_PITCH | FF_MODERN, L"Consolas");
   morpheus_gui_set_state(plugin, p);
   return true;
}

void gui_destroy(const clap_plugin_t *plugin) {
   Panel *p = panel_of(plugin);
   if (!p) return;
   if (p->hwnd) { KillTimer(p->hwnd, 1); DestroyWindow(p->hwnd); p->hwnd = nullptr; }
   if (p->font) DeleteObject(p->font);
   if (p->fontBold) DeleteObject(p->fontBold);
   if (p->bg) DeleteObject(p->bg);
   if (p->dim) DeleteObject(p->dim);
   if (p->green) DeleteObject(p->green);
   if (p->amber) DeleteObject(p->amber);
   if (p->cyan) DeleteObject(p->cyan);
   delete p;
   morpheus_gui_set_state(plugin, nullptr);
}

bool gui_set_scale(const clap_plugin_t *plugin, double scale) { (void)plugin; (void)scale; return true; }

bool gui_get_size(const clap_plugin_t *plugin, uint32_t *width, uint32_t *height) {
   Panel *p = panel_of(plugin);
   if (!p) return false;
   *width = MORPHEUS_PANEL_WIDTH;
   *height = morpheus_gui_height(p->plugin, p->params);
   return true;
}

bool gui_can_resize(const clap_plugin_t *plugin) { (void)plugin; return false; }
bool gui_adjust_size(const clap_plugin_t *plugin, uint32_t *w, uint32_t *h) { (void)plugin; (void)w; (void)h; return false; }
bool gui_set_size(const clap_plugin_t *plugin, uint32_t w, uint32_t h) { (void)plugin; (void)w; (void)h; return false; }
bool gui_set_transient(const clap_plugin_t *plugin, const clap_window_t *w) { (void)plugin; (void)w; return false; }
void gui_suggest_title(const clap_plugin_t *plugin, const char *title) { (void)plugin; (void)title; }

bool gui_set_parent(const clap_plugin_t *plugin, const clap_window_t *window) {
   Panel *p = panel_of(plugin);
   if (!p || !window) return false;
   if (!window->api || strcmp(window->api, CLAP_WINDOW_API_WIN32)) return false;
   HWND parent = (HWND)window->win32;
   if (!parent) return false;
   p->hwnd = CreateWindowExW(0, kClassName, L"", WS_CHILD | WS_VISIBLE, 0, 0, MORPHEUS_PANEL_WIDTH,
                             (int)morpheus_gui_height(p->plugin, p->params), parent, nullptr, GetModuleHandleW(nullptr), p);
   if (!p->hwnd) return false;
   // 33 ms: thirty redraws a second, which is enough for an automated knob to look live and cheap enough that
   // a host never notices it.
   SetTimer(p->hwnd, 1, 33, nullptr);
   return true;
}

bool gui_show(const clap_plugin_t *plugin) {
   Panel *p = panel_of(plugin);
   if (!p || !p->hwnd) return false;
   ShowWindow(p->hwnd, SW_SHOW);
   return true;
}

bool gui_hide(const clap_plugin_t *plugin) {
   Panel *p = panel_of(plugin);
   if (!p || !p->hwnd) return false;
   ShowWindow(p->hwnd, SW_HIDE);
   return true;
}

const clap_plugin_gui_t s_gui = {
  .is_api_supported = gui_is_api_supported,
  .get_preferred_api = gui_get_preferred_api,
  .create = gui_create,
  .destroy = gui_destroy,
  .set_scale = gui_set_scale,
  .get_size = gui_get_size,
  .can_resize = gui_can_resize,
  .adjust_size = gui_adjust_size,
  .set_size = gui_set_size,
  .set_parent = gui_set_parent,
  .set_transient = gui_set_transient,
  .suggest_title = gui_suggest_title,
  .show = gui_show,
  .hide = gui_hide,
};
}  // namespace

extern "C" const clap_plugin_gui_t *morpheus_gui_extension(void) { return &s_gui; }
#endif  // _WIN32
`;

/**
 * The Linux panel: a child X11 window and Xlib.
 *
 * ⚠️ THIS ONE HAS TO RUN ITS OWN EVENT LOOP, AND THAT IS NOT A SHORTCUT. Windows delivers a child window's
 * messages through the thread that owns the parent, so the host's loop does the work for us. X11 has no such
 * thing: a window's events go to whoever selected input on it, and the host selected input on ITS windows, not
 * on ours. So the panel opens its own connection to the same display, creates its own window, selects its own
 * events, and runs a small thread that pumps them and repaints.
 *
 * The alternative — hoping the host forwards events to a window it did not create — is what makes Linux
 * plugin GUIs work on one host and sit there dead on another.
 */
export const pluginGuiX11 = `// ${PLUGIN_GUI_X11} — generated by Morpheus. This file is yours: edit it freely, and the build picks up
// your changes.
//
// The X11 drawing backend. Which rows exist, what they say and where a click lands comes from
// Source/PluginGuiLayout.h; what is here is a window, an event thread and Xlib's drawing calls.

#include "PluginGuiLayout.h"

#ifdef __linux__
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <atomic>
#include <chrono>
#include <thread>

namespace {
struct Panel {
   const clap_plugin_t *plugin;
   const clap_plugin_params_t *params;
   Display *dpy;
   Window win;
   GC gc;
   XFontStruct *font;
   unsigned long bg, green, dim, text, group;
   // The amber the signal path is drawn in, allocated beside the other colours in gui_set_parent.
   unsigned long amber;
   unsigned long cyan;
   std::thread thread;
   std::atomic<bool> running;
   int drag;
   Time lastClick;
   int lastClickRow;
   // ⭐ THE BLOCK STATE, the same five fields Cocoa and Windows carry: which block's controls are drawn, the
   // box a press started on, where it would land, what tells a CLICK from a DRAG, and whether it crossed.
   int open;
   int dragBlock;
   int dropBlock;
   double pressY;
   int moved;
};

Panel *panel_of(const clap_plugin_t *plugin) { return (Panel *)morpheus_gui_state(plugin); }

unsigned long colour(Display *d, const char *spec, unsigned long fallback) {
   XColor c, exact;
   Colormap cmap = DefaultColormap(d, DefaultScreen(d));
   if (!XAllocNamedColor(d, cmap, spec, &c, &exact)) return fallback;
   return c.pixel;
}

void put(Display *d, Window w, GC gc, int x, int y, const char *s) {
   if (s && *s) XDrawString(d, w, gc, x, y, s, (int)strlen(s));
}

void paint(Panel *p) {
   const int h = (int)morpheus_gui_height(p->plugin, p->params);
   XSetForeground(p->dpy, p->gc, p->bg);
   XFillRectangle(p->dpy, p->win, p->gc, 0, 0, MORPHEUS_PANEL_WIDTH, (unsigned)h);

   morpheus_gui_row_t rows[MORPHEUS_GUI_MAX_ROWS];
   morpheus_gui_block_t blocks[MORPHEUS_GUI_MAX_BLOCKS];
   const uint32_t n = morpheus_gui_rows(p->plugin, p->params, rows, MORPHEUS_GUI_MAX_ROWS);
   const uint32_t nb = morpheus_gui_blocks(rows, n, blocks, MORPHEUS_GUI_MAX_BLOCKS);
   // A chain that shrank under us — the plugin's own order can change — must not index a block that is gone.
   if (p->open >= (int)nb) p->open = nb ? 0 : -1;

   // ── THE COLUMN: one box per block, in SIGNAL order, with the amber line between them ─────────────────
   for (uint32_t b = 0; b < nb; ++b) {
      const int top = (int)morpheus_gui_box_y(b);
      const int selected = ((int)b == p->open);
      const int landing = ((int)b == p->dropBlock);
      // ⚠️ XLIB HAS NO ROUNDED RECTANGLE. XDrawRectangle is the outline and the nearest equivalent; the round
      // corners are the one thing Cocoa draws that this cannot, and they are decoration rather than
      // information — the colour and the width are what say which box is open.
      XSetForeground(p->dpy, p->gc, (selected || landing) ? p->amber : p->dim);
      XSetLineAttributes(p->dpy, p->gc, (selected || landing) ? 2 : 1, LineSolid, CapButt, JoinMiter);
      XDrawRectangle(p->dpy, p->win, p->gc, MORPHEUS_BOX_X, top, MORPHEUS_BOX_W, MORPHEUS_BOX_H);
      XSetForeground(p->dpy, p->gc, p->group);
      put(p->dpy, p->win, p->gc, MORPHEUS_BOX_X + 12, top + 18, blocks[b].name);
      // A PINNED BLOCK SAYS SO. The amp model and the cabinet are the pivot and the output is last: a box that
      // refused to move with no explanation reads as a bug rather than as a rule.
      if (!blocks[b].movable) {
         XSetForeground(p->dpy, p->gc, p->dim);
         put(p->dpy, p->win, p->gc, MORPHEUS_BOX_X + MORPHEUS_BOX_W - 54, top + 19, "LOCKED");
      }
      // THE AMBER LINE, as a connector between boxes — which is what makes the column read as a signal path
      // rather than as a list of headings.
      if (b + 1 < nb) {
         XSetForeground(p->dpy, p->gc, p->amber);
         XFillRectangle(p->dpy, p->win, p->gc, MORPHEUS_BOX_X + 20, top + MORPHEUS_BOX_H, 2,
                        (unsigned)((int)morpheus_gui_box_y(b + 1) - (top + MORPHEUS_BOX_H)));
      }
   }
   // Back to a hairline before the controls: the arcs below would otherwise inherit whichever width the last
   // box was outlined with.
   XSetLineAttributes(p->dpy, p->gc, 1, LineSolid, CapButt, JoinMiter);

   // ── THE SELECTED BLOCK'S CONTROLS, beside the column ──────────────────────────────────────────────────
   if (p->open >= 0) {
      const morpheus_gui_block_t *blk = &blocks[p->open];
      // …and only when it says something the first row under it does not — see morpheus_gui_block_t's \`title\`.
      if (blk->title) {
         XSetForeground(p->dpy, p->gc, p->amber);
         put(p->dpy, p->win, p->gc, MORPHEUS_TRACK_X, MORPHEUS_PAD + 13, blk->name);
      }
      for (uint32_t i = 0; i < blk->row_count; ++i) {
         const morpheus_gui_row_t *row = &rows[blk->first_row + i];
         // ⚠️ THE ROW'S POSITION WITHIN ITS BLOCK, NOT ITS INDEX IN THE ROW ARRAY — the control area shows one
         // block, so the rows drawn there are always 0..row_count-1.
         const int y = (int)morpheus_gui_row_y(i);
         XSetForeground(p->dpy, p->gc, p->text);
         put(p->dpy, p->win, p->gc, MORPHEUS_LABEL_X, y + 13, row->name);

         if (row->stepped) {
            // ── a SWITCH. The row is the target, so the pill does not have to be hit precisely.
            const int sy = y + (MORPHEUS_ROW - MORPHEUS_SWITCH_H) / 2;
            const int on = row->setting >= (row->min + row->max) * 0.5;
            XSetForeground(p->dpy, p->gc, on ? p->green : p->dim);
            XFillRectangle(p->dpy, p->win, p->gc, MORPHEUS_CONTROL_X, (unsigned)sy, MORPHEUS_SWITCH_W, MORPHEUS_SWITCH_H);
            const int knobX = on ? (MORPHEUS_CONTROL_X + MORPHEUS_SWITCH_W - MORPHEUS_SWITCH_H) : MORPHEUS_CONTROL_X;
            XSetForeground(p->dpy, p->gc, p->bg);
            XFillArc(p->dpy, p->win, p->gc, knobX + 1, sy + 1, MORPHEUS_SWITCH_H - 2, MORPHEUS_SWITCH_H - 2, 0, 360 * 64);
            XSetForeground(p->dpy, p->gc, p->green);
            XDrawArc(p->dpy, p->win, p->gc, knobX + 1, sy + 1, MORPHEUS_SWITCH_H - 2, MORPHEUS_SWITCH_H - 2, 0, 360 * 64);
         } else {
            XSetForeground(p->dpy, p->gc, p->dim);
            XFillRectangle(p->dpy, p->win, p->gc, MORPHEUS_CONTROL_X, (unsigned)(y + 11), MORPHEUS_TRACK_W, 4);
            XSetForeground(p->dpy, p->gc, p->green);
            XFillRectangle(p->dpy, p->win, p->gc, MORPHEUS_CONTROL_X, (unsigned)(y + 11),
                           (unsigned)(MORPHEUS_TRACK_W * row->t), 4);

            const int knobX = (int)morpheus_gui_x_of(row->t);
            XSetForeground(p->dpy, p->gc, p->bg);
            XFillArc(p->dpy, p->win, p->gc, knobX - MORPHEUS_KNOB_R, y + 7, MORPHEUS_KNOB_R * 2, MORPHEUS_KNOB_R * 2, 0, 360 * 64);
            XSetForeground(p->dpy, p->gc, p->green);
            XDrawArc(p->dpy, p->win, p->gc, knobX - MORPHEUS_KNOB_R, y + 7, MORPHEUS_KNOB_R * 2, MORPHEUS_KNOB_R * 2, 0, 360 * 64);
         }

         int textW = p->font ? XTextWidth(p->font, row->value, (int)strlen(row->value)) : 0;
         XSetForeground(p->dpy, p->gc, p->green);
         put(p->dpy, p->win, p->gc, MORPHEUS_PANEL_WIDTH - MORPHEUS_PAD - textW, y + 13, row->value);
      }
   }

   // ── THE BADGE, and the wordmark under it ──────────────────────────────────────────────────────────────
   // The geometry is in the shared header, so this is the same picture the Mac panel draws — see
   // kMorpheusBadge. Xlib has no per-call pen, so the arcs get the hairline set above and the boxes set their
   // own width; the wordmark's x is a LEFT EDGE for the reason MORPHEUS_BADGE_WORD_X gives.
   XSetLineAttributes(p->dpy, p->gc, 1, LineSolid, CapButt, JoinMiter);
   for (size_t bi = 0; bi < MORPHEUS_BADGE_PRIMITIVES; ++bi) {
      const morpheus_gui_badge_t *b = &kMorpheusBadge[bi];
      const int bx = MORPHEUS_BADGE_X + b->x, by = MORPHEUS_BADGE_Y + b->y;
      if (b->kind == MORPHEUS_BADGE_BAR) {
         XSetForeground(p->dpy, p->gc, p->dim);
         XFillRectangle(p->dpy, p->win, p->gc, bx, by, (unsigned)b->w, (unsigned)b->h);
         continue;
      }
      if (b->kind == MORPHEUS_BADGE_DOT || b->kind == MORPHEUS_BADGE_LAMP || b->kind == MORPHEUS_BADGE_CYAN) {
         XSetForeground(p->dpy, p->gc, b->kind == MORPHEUS_BADGE_LAMP ? p->amber
                                        : (b->kind == MORPHEUS_BADGE_CYAN ? p->cyan : p->green));
         XFillArc(p->dpy, p->win, p->gc, bx, by, (unsigned)b->w, (unsigned)b->h, 0, 360 * 64);
         continue;
      }
      if (b->kind == MORPHEUS_BADGE_LINE) {
         XSetForeground(p->dpy, p->gc, p->green);
         XSetLineAttributes(p->dpy, p->gc, 2, LineSolid, CapButt, JoinMiter);
         XDrawLine(p->dpy, p->win, p->gc, bx, by, bx + b->w, by + b->h);
         XSetLineAttributes(p->dpy, p->gc, 1, LineSolid, CapButt, JoinMiter);
         continue;
      }
      XSetForeground(p->dpy, p->gc, b->kind == MORPHEUS_BADGE_RING ? p->green : p->dim);
      if (b->kind == MORPHEUS_BADGE_RING) {
         XSetLineAttributes(p->dpy, p->gc, 2, LineSolid, CapButt, JoinMiter);
         XDrawArc(p->dpy, p->win, p->gc, bx, by, (unsigned)b->w, (unsigned)b->h, 0, 360 * 64);
         XSetLineAttributes(p->dpy, p->gc, 1, LineSolid, CapButt, JoinMiter);
      } else {
         XDrawRectangle(p->dpy, p->win, p->gc, bx, by, (unsigned)b->w, (unsigned)b->h);
      }
   }
   XSetForeground(p->dpy, p->gc, p->green);
   put(p->dpy, p->win, p->gc, MORPHEUS_BADGE_WORD_X, MORPHEUS_BADGE_WORD_Y + 10, MORPHEUS_BADGE_WORD);

   XFlush(p->dpy);
}

/**
 * The panel's own event loop: pump, then repaint thirty times a second.
 *
 * ⚠️ XLIB IS NOT THREAD-SAFE ACROSS CONNECTIONS without \`XInitThreads()\`, and a plugin cannot assume the host
 * called it. Two things follow, and both are deliberate: this thread uses ONLY the connection it opened, and
 * every value it produces goes to the audio thread through the same slot-and-flag handover the other two
 * backends use. No Xlib call is made from any other thread, ever.
 *
 * The repaint is on a timer as well as on an event because a host may automate a parameter with no mouse
 * involved, and the only source of truth for the current value is the plugin's own params extension.
 */
void run(Panel *p) {
   while (p->running.load()) {
      while (XPending(p->dpy)) {
         XEvent ev;
         XNextEvent(p->dpy, &ev);
         if (ev.type == Expose) {
            paint(p);
         } else if (ev.type == ButtonPress && ev.xbutton.button == Button1) {
            morpheus_gui_row_t rows[MORPHEUS_GUI_MAX_ROWS];
            morpheus_gui_block_t blocks[MORPHEUS_GUI_MAX_BLOCKS];
            const uint32_t n = morpheus_gui_rows(p->plugin, p->params, rows, MORPHEUS_GUI_MAX_ROWS);
            const uint32_t nb = morpheus_gui_blocks(rows, n, blocks, MORPHEUS_GUI_MAX_BLOCKS);
            if (p->open >= (int)nb) p->open = nb ? 0 : -1;
            // ── A BOX: select it, and arm a drag if the PLUGIN says it may move ──────────────────────────
            const int box = morpheus_gui_box_at((double)ev.xbutton.x, (double)ev.xbutton.y, nb);
            if (box >= 0) {
               p->open = box;
               p->dropBlock = box;
               p->pressY = (double)ev.xbutton.y;
               p->moved = 0;
               // ⚠️ AND THE DOUBLE-CLICK PAIR IS BROKEN, because the row below is now a row of a DIFFERENT
               // block: absolute row 2 of the Delay is not the absolute row 2 the last click landed on, and
               // pairing them would reset a control the user only clicked once. X11 counts its own pairs (it
               // does not synthesise a double-click), so it has to know when a pair cannot be one.
               p->lastClickRow = -1;
               // The plugin answers, not the panel — a pinned box still OPENS, it just does not move.
               p->dragBlock = blocks[box].movable ? box : -1;
               paint(p);
            } else if (p->open >= 0) {
               const morpheus_gui_block_t *blk = &blocks[p->open];
               // ⚠️ THE HIT IS WITHIN THE SELECTED BLOCK; the absolute row is what the layout is handed.
               const int within = morpheus_gui_row_at((double)ev.xbutton.x, (double)ev.xbutton.y, blk->row_count);
               if (within >= 0) {
                  const int row = (int)(blk->first_row + (uint32_t)within);
                  // X11 does not synthesise a double-click, so the pair is counted here: the same row, twice
                  // inside 350 ms, puts the control back to its default — which for a block's switch is the
                  // state the project was BUILT with.
                  const bool dbl = (p->lastClickRow == row && (ev.xbutton.time - p->lastClick) < 350);
                  p->lastClick = ev.xbutton.time;
                  p->lastClickRow = row;
                  morpheus_gui_set_row(p->plugin, rows, (uint32_t)row, (double)ev.xbutton.x, dbl);
                  // A switch is a click, not a drag: following the pointer would be a way to change nothing slowly.
                  p->drag = (dbl || rows[row].stepped) ? -1 : row;
                  paint(p);
               }
            }
         } else if (ev.type == MotionNotify && p->dragBlock >= 0) {
            // ⚠️ A CLICK AND A DRAG BEGIN THE SAME WAY, so the threshold is what tells them apart. Without it
            // every click on a box would be a one-pixel reorder, and every reorder would fight the click that
            // opened it.
            const double y = (double)ev.xmotion.y;
            if (!p->moved && (y - p->pressY > 4.0 || p->pressY - y > 4.0)) p->moved = 1;
            if (p->moved) {
               morpheus_gui_row_t rows[MORPHEUS_GUI_MAX_ROWS];
               morpheus_gui_block_t blocks[MORPHEUS_GUI_MAX_BLOCKS];
               const uint32_t n = morpheus_gui_rows(p->plugin, p->params, rows, MORPHEUS_GUI_MAX_ROWS);
               const uint32_t nb = morpheus_gui_blocks(rows, n, blocks, MORPHEUS_GUI_MAX_BLOCKS);
               const int over = morpheus_gui_box_at((double)ev.xmotion.x, y, nb);
               // Dragged off the column entirely: KEEP the last box it was over rather than losing the drag,
               // which would make a fast drag past the edge do nothing.
               if (over >= 0) p->dropBlock = over;
               paint(p);
            }
         } else if (ev.type == MotionNotify && p->drag >= 0) {
            morpheus_gui_row_t rows[MORPHEUS_GUI_MAX_ROWS];
            const uint32_t n = morpheus_gui_rows(p->plugin, p->params, rows, MORPHEUS_GUI_MAX_ROWS);
            if ((uint32_t)p->drag < n) morpheus_gui_set_row(p->plugin, rows, (uint32_t)p->drag, (double)ev.xmotion.x, false);
            paint(p);
         } else if (ev.type == ButtonRelease) {
            if (p->dragBlock >= 0 && p->moved && p->dropBlock >= 0 && p->dropBlock != p->dragBlock) {
               morpheus_gui_row_t rows[MORPHEUS_GUI_MAX_ROWS];
               morpheus_gui_block_t blocks[MORPHEUS_GUI_MAX_BLOCKS];
               const uint32_t n = morpheus_gui_rows(p->plugin, p->params, rows, MORPHEUS_GUI_MAX_ROWS);
               const uint32_t nb = morpheus_gui_blocks(rows, n, blocks, MORPHEUS_GUI_MAX_BLOCKS);
               uint32_t order[MORPHEUS_GUI_MAX_BLOCKS];
               morpheus_gui_reorder(blocks, nb, (uint32_t)p->dragBlock, (uint32_t)p->dropBlock, order);
               // ⚠️ THE PANEL SHOWS WHAT THE PLUGIN ACCEPTED, NOT WHAT THE MOUSE DID. If the order is refused
               // the column snaps back to what is actually running, because drawing the drop would be the panel
               // lying about the plugin's own state — and the plugin is the one that owns the rule.
               if (morpheus_gui_set_order(p->plugin, order, nb)) p->open = p->dropBlock;
               else p->open = p->dragBlock;
               paint(p);
            }
            p->drag = -1;
            p->dragBlock = -1;
            p->dropBlock = -1;
            p->moved = 0;
         }
      }
      paint(p);
      std::this_thread::sleep_for(std::chrono::milliseconds(33));
   }
}
}  // namespace

// ── the CLAP interface ──────────────────────────────────────────────────────────────────────────────────
namespace {
bool gui_is_api_supported(const clap_plugin_t *plugin, const char *api, bool is_floating) {
   (void)plugin;
   if (is_floating) return false;
   return api && !strcmp(api, CLAP_WINDOW_API_X11);
}

bool gui_get_preferred_api(const clap_plugin_t *plugin, const char **api, bool *is_floating) {
   (void)plugin;
   *api = CLAP_WINDOW_API_X11;
   *is_floating = false;
   return true;
}

bool gui_create(const clap_plugin_t *plugin, const char *api, bool is_floating) {
   if (!gui_is_api_supported(plugin, api, is_floating)) return false;
   const clap_plugin_params_t *params = (const clap_plugin_params_t *)plugin->get_extension(plugin, CLAP_EXT_PARAMS);
   if (!params) return false;
   Panel *p = new Panel();
   p->plugin = plugin;
   p->params = params;
   p->dpy = nullptr;
   p->win = 0;
   p->gc = nullptr;
   p->font = nullptr;
   p->drag = -1;
   // THE FIRST BLOCK OPENS, not none: a panel that opens with nothing selected shows no control at all,
   // which reads as a plugin that has none.
   p->open = 0;
   p->dragBlock = -1;
   p->dropBlock = -1;
   p->pressY = 0.0;
   p->moved = 0;
   p->lastClick = 0;
   p->lastClickRow = -1;
   p->running.store(false);
   morpheus_gui_set_state(plugin, p);
   return true;
}

void gui_destroy(const clap_plugin_t *plugin) {
   Panel *p = panel_of(plugin);
   if (!p) return;
   if (p->running.load()) {
      p->running.store(false);
      if (p->thread.joinable()) p->thread.join();
   }
   if (p->dpy) {
      if (p->win) XDestroyWindow(p->dpy, p->win);
      if (p->gc) XFreeGC(p->dpy, p->gc);
      if (p->font) XFreeFont(p->dpy, p->font);
      XCloseDisplay(p->dpy);
   }
   delete p;
   morpheus_gui_set_state(plugin, nullptr);
}

bool gui_set_scale(const clap_plugin_t *plugin, double scale) { (void)plugin; (void)scale; return true; }

bool gui_get_size(const clap_plugin_t *plugin, uint32_t *width, uint32_t *height) {
   Panel *p = panel_of(plugin);
   if (!p) return false;
   *width = MORPHEUS_PANEL_WIDTH;
   *height = morpheus_gui_height(p->plugin, p->params);
   return true;
}

bool gui_can_resize(const clap_plugin_t *plugin) { (void)plugin; return false; }
bool gui_adjust_size(const clap_plugin_t *plugin, uint32_t *w, uint32_t *h) { (void)plugin; (void)w; (void)h; return false; }
bool gui_set_size(const clap_plugin_t *plugin, uint32_t w, uint32_t h) { (void)plugin; (void)w; (void)h; return false; }
bool gui_set_transient(const clap_plugin_t *plugin, const clap_window_t *w) { (void)plugin; (void)w; return false; }
void gui_suggest_title(const clap_plugin_t *plugin, const char *title) { (void)plugin; (void)title; }

bool gui_set_parent(const clap_plugin_t *plugin, const clap_window_t *window) {
   Panel *p = panel_of(plugin);
   if (!p || !window) return false;
   if (!window->api || strcmp(window->api, CLAP_WINDOW_API_X11)) return false;
   const Window parent = (Window)window->x11;
   if (!parent) return false;
   // ⚠️ ITS OWN CONNECTION. A plugin that draws through the host's Display* is a plugin calling Xlib from
   // another thread's connection, which is undefined unless the host called XInitThreads() — and a host that
   // did not is a host where this works until the day it does not.
   p->dpy = XOpenDisplay(nullptr);
   if (!p->dpy) return false;
   const int screen = DefaultScreen(p->dpy);
   p->bg = colour(p->dpy, "#0a0a0b", BlackPixel(p->dpy, screen));
   p->green = colour(p->dpy, "#38ff14", WhitePixel(p->dpy, screen));
   p->dim = colour(p->dpy, "#1a3d1a", BlackPixel(p->dpy, screen));
   p->text = colour(p->dpy, "#c7f2cc", WhitePixel(p->dpy, screen));
   p->group = colour(p->dpy, "#6b9e70", WhitePixel(p->dpy, screen));
   // ⭐ THE AMBER for the signal path and the open box's outline — Cocoa's calibrated (1.0, 0.66, 0.12) in 8
   // bits. It has to differ from the green a CONTROL is, or the eye reads the signal path as a control.
   p->amber = colour(p->dpy, "#ffa81f", WhitePixel(p->dpy, screen));
   p->cyan = colour(p->dpy, "#40f0ff", WhitePixel(p->dpy, screen));
   p->win = XCreateSimpleWindow(p->dpy, parent, 0, 0, MORPHEUS_PANEL_WIDTH, morpheus_gui_height(p->plugin, p->params), 0,
                                p->bg, p->bg);
   if (!p->win) return false;
   XSelectInput(p->dpy, p->win,
                ExposureMask | ButtonPressMask | ButtonReleaseMask | PointerMotionMask | StructureNotifyMask);
   p->gc = XCreateGC(p->dpy, p->win, 0, nullptr);
   // A CORE FONT, NOT XFT. A plugin should not need a font server or a fontconfig cache to draw four words,
   // and the layout does not depend on the exact metrics — with no font at all it still draws everything but
   // the text, which is a better failure than not opening.
   p->font = XLoadQueryFont(p->dpy, "fixed");
   if (p->font) XSetFont(p->dpy, p->gc, p->font->fid);
   XMapWindow(p->dpy, p->win);
   XFlush(p->dpy);
   p->running.store(true);
   p->thread = std::thread(run, p);
   return true;
}

bool gui_show(const clap_plugin_t *plugin) {
   Panel *p = panel_of(plugin);
   if (!p || !p->dpy) return false;
   XMapWindow(p->dpy, p->win);
   XFlush(p->dpy);
   return true;
}

bool gui_hide(const clap_plugin_t *plugin) {
   Panel *p = panel_of(plugin);
   if (!p || !p->dpy) return false;
   XUnmapWindow(p->dpy, p->win);
   XFlush(p->dpy);
   return true;
}

const clap_plugin_gui_t s_gui = {
  .is_api_supported = gui_is_api_supported,
  .get_preferred_api = gui_get_preferred_api,
  .create = gui_create,
  .destroy = gui_destroy,
  .set_scale = gui_set_scale,
  .get_size = gui_get_size,
  .can_resize = gui_can_resize,
  .adjust_size = gui_adjust_size,
  .set_size = gui_set_size,
  .set_parent = gui_set_parent,
  .set_transient = gui_set_transient,
  .suggest_title = gui_suggest_title,
  .show = gui_show,
  .hide = gui_hide,
};
}  // namespace

extern "C" const clap_plugin_gui_t *morpheus_gui_extension(void) { return &s_gui; }
#endif  // __linux__
`;

/**
 * ⚠️ THE FALLBACK STUB RETURNS NULL RATHER THAN A STRUCT THAT SAYS NO.
 *
 * Returning NULL from `get_extension` is the CLAP way to say "this plugin has no GUI", and a plugin that
 * claims a capability it does not have is handled by hosts in a variety of imaginative ways. This file is
 * compiled only when the platform is none of Apple, Windows or Linux — which is to say, for a port that has
 * not been written yet.
 */
export const pluginGuiStub = `// ${PLUGIN_GUI_STUB} — generated by Morpheus. See server/src/lib/pluginGui.js.
//
// No panel on this platform: CLAP_EXT_GUI answers NULL, which is how a plugin says it has no GUI, and a host
// then draws its own generic parameter list. The three panels Morpheus generates are Source/PluginGui.mm
// (Cocoa), Source/PluginGuiWin.cpp (win32 + GDI) and Source/PluginGuiX11.cpp (X11).

#include <clap/clap.h>

extern "C" const clap_plugin_gui_t *morpheus_gui_extension(void) { return nullptr; }
`;
