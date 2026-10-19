// Exporting a Jarvis reply — the deciding, not the drawing.
//
// Rob's audit of the old base44 deck (DECK-OLD-VS-NEW.md §4): its `DocumentSheet` offered a Google Doc or
// Sheet, a client-side PDF, Word and Excel. The ported Deck can produce a **Google Doc only**, via
// `createDeckDocument.js`. This is the client-side half coming back, and everything here is pure so a guard
// can reach it — the PDF/Word plumbing that consumes it is not, and is guarded by wiring assertions instead.
//
// Dependency-free (jspdf is imported by the caller, dynamically, so this module stays loadable in the
// no-install guards job).

/**
 * A filename that is safe on every platform, without an extension.
 *
 * Strips anything that is not a word character, space or hyphen, collapses runs, and caps the length.
 * A name made entirely of stripped characters falls back rather than producing ".pdf" — which is a real
 * filename a download would honour, and a confusing one to find later.
 */
export function safeFilename(name, fallback = 'morpheus-document') {
  const base = String(name == null ? '' : name)
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return base || fallback;
}

/** One CSV cell, quoted only when it has to be (RFC 4180). */
function csvCell(value) {
  const s = String(value == null ? '' : value).trim();
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The cells of one line, given whichever separator it actually uses.
 *
 * The old deck accepted tab-separated text (what it asked the model for), ` | ` and a bare `|`, because
 * Jarvis writes tables in whatever shape it feels like. Checked in that order so a line that legitimately
 * contains a pipe inside a tab-separated row is not re-split.
 */
function splitCells(line) {
  if (line.includes('\t')) return line.split('\t');
  if (line.includes(' | ')) return line.split(' | ');
  if (line.includes('|')) return line.split('|');
  return [line];
}

/**
 * Tab/pipe separated text → CSV, ready for a spreadsheet.
 *
 * Blank lines are dropped: they are formatting, not rows, and a blank row in a CSV opens as a gap the
 * operator has to clean up. CRLF line endings, which is what Excel on Windows expects.
 */
export function textToCsv(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/).filter((l) => l.trim() !== '');
  return lines.map((line) => splitCells(line).map(csvCell).join(',')).join('\r\n');
}

/**
 * The reply split into paragraphs for a PDF or a Word file.
 *
 * Keeps single newlines inside a paragraph (a list, or a wrapped line) and treats a blank line as the
 * break — so the exported document has the same shape the operator read on screen rather than becoming
 * one wall of text.
 */
export function paragraphs(text) {
  return String(text == null ? '' : text)
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Whether a reply looks like a table — the only case where offering CSV makes sense.
 *
 * Needs a separator AND at least two lines, so a single sentence containing a pipe does not offer a
 * one-cell spreadsheet.
 */
export function looksTabular(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return false;
  return lines.filter((l) => /[\t|]/.test(l)).length >= 2;
}
