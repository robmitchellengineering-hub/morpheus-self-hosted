// A RIG: the one amp, captured in several of its states, and the one cabinet, captured from several mics.
//
// ── WHY THIS EXISTS AS ITS OWN MODULE ───────────────────────────────────────────────────────────────────
// Rob, listening to the plugin: *"it would be good if we had the ability to switch between all of those in
// the plugin as they are tonal captures of the same system in different states — so changing the amp to high
// gain settings actually means loading the high gain nam, and being able to choose the different mic set ups
// in the cab convolution is useful too. so i guess you'd have a collection of nams and irs for the one rig
// and that overarching rig name hosts all the nams and irs for that rig."*
//
// That is a better model than "a project has one `.nam` and one `.wav`", and it is how players already think:
// a rig is a THING, and the captures are the settings it can be in. The two shapes this module's helpers serve
// are therefore the same shape — a list of files with names a person can read — so the list handling, the
// naming and the manifest's own spellings live here once rather than in the model module AND the cabinet
// module, which would be two places for a rig to be described differently.
//
// ⚠️ NOTHING HERE READS A FILE. Finding, decoding and embedding are the two modules' jobs; this is the
// vocabulary they share, and it is deliberately small enough to hold in your head.

/**
 * What to CALL a capture in the plugin's selector, from its filename.
 *
 * A file called `marshall_crunch-2.nam` is `Marshall Crunch 2` — because the selector is a control a player
 * reads, and the one thing a filename is guaranteed not to be is a name.
 */
export function rigName(path) {
  const base = String(path || '').split('/').pop().replace(/\.(nam|wav)$/i, '');
  const words = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  // A filename that is already capitalised is left alone; one that is not gets title case, so `sm57` reads
  // as `Sm57` rather than shouting.
  if (!words) return base;
  return /[A-Z]/.test(words) ? words : words.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * One entry of a manifest's rig list, or null.
 *
 * A BARE STRING IS THE COMMON CASE AND AN OBJECT IS THE ESCAPE HATCH: `"models": ["models/clean.nam"]` is
 * what a project written by hand looks like, and `{ path, name }` is for when the file's own name is not what
 * the capture is called — `models/hg-3.nam` being "JCM 800, gain 7".
 *
 * ⭐ AND `default: true` ON THE ENTRY IS HOW A PROJECT SAYS WHICH MEMBER THE PLUGIN OPENS ON — the ONE
 * spelling of it, deliberately a PER-MEMBER flag rather than a top-level key naming a path:
 *
 *   • THE FLAG BELONGS ON THE ENTRY, so `rigEntry` — already the single answer to "is this a rig entry" —
 *     is also the single answer to "is this member the opening one". A top-level `default` key would be a
 *     SECOND vocabulary beside the list: it would have to name a path, be validated against the same list,
 *     be spelled once per half (`defaultModel`/`defaultCab`, or a nested object), and then be reconciled when
 *     the list and the name disagree. Two ways to say the same thing is how a manifest and a generator come
 *     to disagree, and the member that CARRIES the fact cannot drift from the list it is in.
 *   • ⚠️ A BARE STRING CANNOT CARRY IT, and that is the honest limit rather than an omission: the string
 *     spelling says nothing about the opening member, so the first member is it — which is exactly what a
 *     string manifest means today.
 *   • It is carried ONLY when it is literally `true`. `false`, `"yes"`, `1` and `null` are ignored rather
 *     than fatal, the same rule `rigEntryList` applies to every other malformed thing: a hand-edited
 *     manifest must still build the plugin its files imply.
 */
export function rigEntry(entry) {
  if (typeof entry === 'string') {
    const path = entry.trim();
    return path ? { path, name: rigName(path) } : null;
  }
  if (entry && typeof entry.path === 'string' && entry.path.trim()) {
    const path = entry.path.trim();
    const named = typeof entry.name === 'string' ? entry.name.trim() : '';
    const out = { path, name: named || rigName(path) };
    if (entry.default === true) out.default = true;
    return out;
  }
  return null;
}

/**
 * WHICH MEMBER A SELECTOR OPENS ON, as an index into the list it is given — the member marked `default`, else
 * the first.
 *
 * ⚠️ IT IS ASKED OF THE EMITTED LIST, NOT OF THE MANIFEST. A member marked default that is unusable is
 * dropped from the emitted rig (see `usableModels`/`usableCabs`), so the index has to be counted over the
 * members the plugin actually carries; counting over the manifest would point the selector at a different
 * capture. `-1` (nothing marked) and `0` (the first is marked) both mean "open on the first", which is why
 * this returns `at > 0 ? at : 0` rather than `at === -1 ? 0 : at`.
 *
 * A manifest that marks TWO members is tolerated rather than refused, the same way every other malformed
 * shape here is: the first marked member that survives wins, so the plugin still builds and still opens on a
 * member the file named.
 */
export function rigDefaultIndex(members) {
  const at = (Array.isArray(members) ? members : []).findIndex((m) => m && m.default === true);
  return at > 0 ? at : 0;
}

/**
 * A manifest's rig LIST — the `models`/`cabs` spelling — validated, or null.
 *
 * ⚠️ ONE VALIDATOR, NOT TWO. `rigEntry` above is the single answer to "is this a rig entry", and this is only
 * the list-shaped question around it: a list is a rig when it is a non-empty ARRAY whose every member is an
 * entry. Anything else — a number, a string, an object, `null`, `[]`, or an array with one bad member — is
 * `null`, which means "this manifest did not ask for a rig". It is deliberately NOT a refusal and NOT a
 * filtered-shorter rig: `readManifest` is the runtime reader, and a manifest that is malformed in part has to
 * behave exactly like one that never mentioned the key, so the finders fall back to the files. Throwing would
 * fail a compile over a hand-edited JSON file; silently dropping one member would build a rig the file did not
 * ask for. `rig.js` holds this rule so the runtime reader does not grow a second opinion about what an entry is.
 */
export function rigEntryList(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out = [];
  for (const entry of value) {
    const e = rigEntry(entry);
    if (!e) return null;
    out.push(e);
  }
  return out;
}

/**
 * The rig a manifest asks for, in the order the selector should offer it.
 *
 * ⚠️ THREE SPELLINGS, IN PRECEDENCE ORDER, AND THE ORDER IS THE WHOLE CONTRACT:
 *   1. `models` / `cabs` — the rig, explicitly, possibly with names;
 *   2. `model` / `cab` — the ONE capture a project has named since before the rig existed;
 *   3. every file of that kind the project holds, in the deterministic order the singular finder used.
 *
 * A project that named one model must keep building exactly the plugin it built before, which is why the
 * singular finders are defined as this function's first element rather than the other way round.
 *
 * \`has\` is the caller's own "is this file really here and usable", because a `.nam` must carry content and a
 * `.wav` need only exist — the two modules genuinely disagree about that.
 */
export function rigList({ files, manifest = {}, listKey, oneKey, has, rank, match }) {
  const list = Array.isArray(manifest[listKey]) ? manifest[listKey] : null;
  if (list) {
    const seen = new Set();
    const out = [];
    for (const entry of list) {
      const e = rigEntry(entry);
      // A DUPLICATE IS DROPPED RATHER THAN REFUSED: two selector positions that play the same capture is a
      // worse outcome than a shorter list, and the manifest is often written by hand.
      if (!e || seen.has(e.path) || !has(files, e.path)) continue;
      seen.add(e.path);
      out.push(e);
    }
    if (out.length) return out;
  }

  const named = typeof manifest[oneKey] === 'string' ? manifest[oneKey].trim() : '';
  if (named) return has(files, named) ? [{ path: named, name: rigName(named) }] : [];

  return (Array.isArray(files) ? files : [])
    .filter((f) => f && typeof f.path === 'string' && match(f.path) && has(files, f.path))
    .map((f) => f.path)
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map((path) => ({ path, name: rigName(path) }));
}
