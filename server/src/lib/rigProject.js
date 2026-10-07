// THE RIG AS A PROJECT DOCUMENT: the captures and mics a project carries, as the app draws them.
//
// ── WHY THIS IS ITS OWN MODULE ───────────────────────────────────────────────────────────────────────────
// A rig has three vocabularies already, and none of them can answer this question on its own:
//
//   • `rig.js` is the WORDS — what to call a capture, what a manifest entry is, what a list is. It reads no
//     files, deliberately (see its header).
//   • `namPlugin.js` and `cabIr.js` are the two HALVES, and each answers only for its own kind of file.
//   • the ROUTE is multipart, a database and a status code, which the guards job cannot import.
//
// The rig is the one question that spans both halves — a person building one needs to see N captures and M
// mics TOGETHER, in the order the plugin will offer them, with the generator's own verdict on whether each
// will load. That is a reading of a project, so it lives here where a guard can ask it with no database and
// the route stays a status code.
//
// ⚠️ IT DOES NOT DECIDE ANYTHING NEW. The order, the names, the "usable" test and every warning come from
// the SAME functions the scaffold uses (`resolveModels` / `resolveCabs` and their `usable*` filters). A view
// that formed its own opinion is how the app and the plugin come to describe one rig differently — which is
// exactly the drift this whole module exists to prevent.

import { rigEntry, rigEntryList, rigName } from './rig.js';
import { resolveModels } from './namPlugin.js';
import { resolveCabs } from './cabIr.js';

const NAM = /\.nam$/i;
const WAV = /\.wav$/i;

/** Every path in the project matching a kind, in a stable order — the "also in this project" list. */
const pathsOf = (files, re) => (Array.isArray(files) ? files : [])
  .filter((f) => f && typeof f.path === 'string' && re.test(f.path))
  .map((f) => f.path)
  .sort();

/**
 * A file's row id, when the caller's file list carries one.
 *
 * ⚠️ IT IS HERE FOR THE REMOVE BUTTON AND NOTHING ELSE. The route deletes by id rather than by path so that a
 * crafted id cannot be pointed at a source file (the same belt `cabinet.routes.js` wears), and a view is the
 * only place the app can learn the id of the row it wants gone. A caller that hands over a path-only file
 * list — a guard, the scaffold — simply gets `null`, and no behaviour depends on it.
 */
const idOf = (files, path) => (Array.isArray(files) ? files.find((f) => f && f.path === path)?.id : null) || null;

/**
 * One half of the rig — the members the plugin will offer, and what else the project holds.
 *
 * ⚠️ `auto` IS THE INTERESTING FLAG, NOT `members.length`. A project that has never been edited has no
 * `models`/`cabs` (or singular `model`/`cab`) key at all, and every file of that kind the project holds is
 * in the rig. A project that named its rig FROZE it: a `.nam` added afterwards is in the project and NOT in
 * the rig, and the whole point of showing that separately is that it is otherwise invisible.
 */
function half({ files, manifest, listKey, oneKey, match, resolve, usable }) {
  const resolved = resolve(files, manifest);
  const inRig = new Set(resolved.map((r) => r.path));
  const explicit = Array.isArray(manifest[listKey]) || Boolean(String(manifest[oneKey] || '').trim());
  return {
    auto: !explicit,
    members: resolved.map((r) => ({ path: r.path, name: r.name, usable: usable(r), id: idOf(files, r.path) })),
    // A file of this kind that the rig does not name. Empty for an automatic rig by construction, because an
    // automatic rig is every file of that kind — so a non-empty list means the rig was frozen.
    others: pathsOf(files, match).filter((p) => !inRig.has(p)).map((p) => ({ path: p, name: rigName(p), id: idOf(files, p) })),
  };
}

/**
 * What the app draws: both halves of the rig, in the selector's order, and what is wrong with it.
 *
 * `members[i].name` is the name a PLAYER reads in the selector — the manifest's own when the project named
 * it, otherwise the filename turned into words by `rig.js`. It is the same string the emitted C++ table
 * carries, because it came from the same finder.
 */
export function rigView(files, manifest = {}) {
  const models = half({ files, manifest, listKey: 'models', oneKey: 'model', match: NAM, resolve: resolveModels, usable: (m) => Boolean(m.info) });
  const cabs = half({ files, manifest, listKey: 'cabs', oneKey: 'cab', match: WAV, resolve: resolveCabs, usable: (c) => Boolean(c.info && Array.isArray(c.channels) && c.channels.length) });

  // The generator's OWN warnings, verbatim. A capture the finder kept so its warning could surface is kept
  // here for the same reason: it is the only thing that tells a user why the amp they put in the project is
  // not in the plugin.
  const warnings = [
    ...models.members.filter((m) => !m.usable).map((m) => `${m.path} is in the rig but not usable — it will be left out of the plugin.`),
    ...cabs.members.filter((c) => !c.usable).map((c) => `${c.path} is in the rig but not usable — it will be left out of the plugin.`),
  ];
  const usableModelCount = models.members.filter((m) => m.usable).length;
  const usableCabCount = cabs.members.filter((c) => c.usable).length;
  // ⚠️ ONE MEMBER IS NOT A CONTROL, and this says so rather than leaving a person to wonder where the
  // selector went. It is the same rule `rigSelectors` implements in the generator.
  if (usableModelCount === 1) warnings.push('One capture in the rig: the plugin plays it and has no Capture control. Add a second to switch between them.');
  if (usableCabCount === 1) warnings.push('One mic in the rig: the plugin convolves it and has no Speaker control. Add a second to switch between them.');
  // A file the project holds and the rig does not name is a silent loss, so it is said out loud — the same
  // warning the board gives for a cabinet that is compiled and never convolves.
  for (const [label, h] of [['capture', models], ['mic', cabs]]) {
    if (h.others.length) {
      warnings.push(`${h.others.length} ${label}${h.others.length === 1 ? '' : 's'} in this project ${h.others.length === 1 ? 'is' : 'are'} not in the rig, so the plugin will not play ${h.others.length === 1 ? 'it' : 'them'}: ${h.others.map((o) => o.name).join(', ')}.`);
    }
  }

  // What the plugin will actually offer, which is what the board editor names under Amp model and Cabinet.
  // ⚠️ TAKEN FROM THE SAME TWO LISTS, NOT RESOLVED AGAIN: a second `resolveCabs` would decode every WAV a
  // second time for a view nobody changed.
  const selectors = {
    models: models.members.filter((m) => m.usable).map(({ path, name }) => ({ path, name })),
    cabs: cabs.members.filter((c) => c.usable).map(({ path, name }) => ({ path, name })),
  };

  return { models, cabs, selectors, warnings };
}

/**
 * A rig the app asked to save, validated — the ONE writer's input, and the route's only opinion.
 *
 * ERRORS refuse and warnings do not, the same split `validateBoard` makes. A path the project does not hold
 * is an ERROR rather than something the finder quietly drops: the board route's own words are that "saved"
 * plus "not used" is the worst of both, and a save is the moment the user is looking.
 *
 * ⚠️ `null` MEANS "REMOVE THE KEY", WHICH MEANS "FOLLOW THE PROJECT". `undefined` means the caller did not
 * mention that half and it is left exactly as it was. The three states are the three things a rig editor can
 * mean, and collapsing them (as `[]` would) is how removing every capture brings them all back: `rigList`
 * reads an empty list as "this manifest did not ask for a rig" and falls back to the file search — see
 * `rig.js`. So an empty array is refused here and named for what it is, rather than silently meaning auto.
 */
export function rigPatch(body, { files = [] } = {}) {
  const errors = [];
  const patch = {};
  const present = (p) => (Array.isArray(files) ? files : []).some((f) => f && f.path === p);

  for (const [key, re, label] of [['models', NAM, 'capture'], ['cabs', WAV, 'mic']]) {
    if (!(key in (body || {}))) continue;
    const raw = body[key];
    if (raw === null) { patch[key] = null; continue; }
    if (!Array.isArray(raw)) {
      errors.push(`The ${key} list must be a list of ${label} files, or null to follow the project.`);
      continue;
    }
    if (!raw.length) {
      errors.push(`A rig must offer at least one ${label}. To let the project decide, clear the list instead — an empty list would quietly put every ${label} back.`);
      continue;
    }
    const seen = new Set();
    const out = [];
    for (const entry of raw) {
      const e = rigEntry(entry);
      if (!e) { errors.push(`"${typeof entry === 'string' ? entry : JSON.stringify(entry)}" is not a ${label} — every entry needs a path.`); continue; }
      if (!re.test(e.path)) { errors.push(`${e.path} is not a ${label} file.`); continue; }
      if (!present(e.path)) { errors.push(`${e.path} is not a file in this project.`); continue; }
      if (seen.has(e.path)) { errors.push(`${e.path} is listed twice — two selector positions playing the same ${label} is worse than a shorter rig.`); continue; }
      seen.add(e.path);
      out.push(e);
    }
    if (out.length) patch[key] = rigEntryList(out);
  }

  return { ok: errors.length === 0, errors, warnings: [], patch };
}

/** Whether a project file is a capture this route owns — the path check that scopes an upload or a delete. */
export const isCapturePath = (p) => typeof p === 'string' && NAM.test(p);
