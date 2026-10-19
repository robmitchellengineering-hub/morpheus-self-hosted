// Where the account operates — the settings field's parsing, kept pure so a guard can test it.
//
// WHY THIS EXISTS. Jarvis has "done all these careers globally" (Rob, 2026-10-03), so
// jurisdiction-specific advice — tax, property, licensing, employment, safety, privacy, health — has
// to be LOCATED before it is given: "realestate advice on greenland os differnt to the gold coast".
// This is the field that locations come from, and the persona states plainly when it is empty rather
// than assuming a country.
//
// The value is stored as a text[] and typed by a human, so the parsing rules matter more than they
// look. All of them exist because of a way a settings box actually gets filled in:
//
//   - people separate places with commas AND newlines, so both split
//   - a trailing comma, or a blank line, must not become "" — an empty string is a "region" the
//     model would try to reason about
//   - the same place typed twice ("Gold Coast" and "gold coast") is one place, not two
//   - free text can grow without limit and the server interpolates it into every prompt, so it is
//     capped here as well as there (the cap is asserted equal on both sides in
//     scripts/verify-jarvis-careers.mjs — two constants that disagree is how one of them stops
//     meaning anything)

/**
 * How many places are kept. MUST equal MAX_OPERATING_REGIONS in
 * server/src/lib/deckBusinessProfile.js — the client cannot be the only place a runaway value is
 * bounded, and the server cannot show the operator what it dropped.
 */
export const MAX_OPERATING_REGIONS = 8;

/**
 * Parse what the operator typed into the list that is stored.
 *
 * @param {string} text raw field contents
 * @returns {string[]} trimmed, de-duplicated (case-insensitively, first spelling wins), capped
 */
export function parseOperatingRegions(text) {
  const parts = String(text ?? '')
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean);

  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
    if (out.length >= MAX_OPERATING_REGIONS) break;
  }
  return out;
}

/** The stored list rendered back into the field for editing. */
export function formatOperatingRegions(list) {
  if (!Array.isArray(list)) return '';
  return list.filter((region) => String(region ?? '').trim()).join(', ');
}
