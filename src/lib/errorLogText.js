// The site's error log as TEXT — what the operator takes away.
//
// WHY THIS IS A MODULE AND NOT THREE LINES IN THE PANEL. The panel presented its findings
// as markup inside a `<button>` (the expand/collapse toggle), and `src/index.css` turns
// text selection OFF on every button, deliberately, to kill the Android highlight menu on
// controls. So the one screen whose entire purpose is "here is the evidence" would not hand
// the evidence over: an operator could read it and not copy it. The markup is fixed too,
// but this is the half that works on a phone, where dragging a selection across forty
// groups is not something anyone can actually do.
//
// Pure and dependency-free, so a guard can call it with a fixture and assert the exact text
// rather than grepping a component for a button label (hazard H19).

/** Counts as one readable line, only naming the levels that are present. */
function countsLine(counts) {
  const order = ['fatal', 'warning', 'notice', 'deprecated', 'other'];
  const parts = order.filter((l) => counts && counts[l] > 0).map((l) => `${counts[l]} ${l}`);
  return parts.length ? parts.join(', ') : 'no errors in the lines that were read';
}

/** How much of the file this actually is — every bound that bit, said out loud. */
function scopeLine(log) {
  const kb = Math.round((log.bytes || 0) / 1024);
  const bits = [];
  if (log.truncated) {
    bits.push(`newest ${log.lines_read} lines of a ${kb} KB file`);
    bits.push(`${log.lines_in_tail} lines were in the part read, so there is more on the server than this`);
  } else {
    bits.push(`${log.lines_read} line${log.lines_read === 1 ? '' : 's'} read${log.bytes ? ` (${kb} KB)` : ''}`);
  }
  if (log.modified) bits.push(`last written ${log.modified}`);
  return bits.join(' · ');
}

/**
 * The whole readout as plain text: what the site is writing, how much of it was read, and
 * every group with the raw lines it was grouped from.
 *
 * It carries its own header because it is meant to be PASTED somewhere — a support ticket,
 * a host, another session — and a bare list of PHP warnings with no file name and no
 * statement of what was and was not read is how a partial read gets quoted as the whole
 * story.
 */
export function errorLogAsText(log) {
  if (!log || typeof log !== 'object') return '';

  const lines = [];
  lines.push('Morpheus — the site\'s PHP error log');
  lines.push('File: ' + (log.path || 'wp-content/debug.log'));
  if (log.configured) lines.push('(WordPress writes its log here rather than its default wp-content/debug.log)');

  if (log.not_read) {
    lines.push('');
    lines.push('NOT READ — ' + log.not_read + '. Nothing here is a statement about errors.');
    return lines.join('\n');
  }

  lines.push(scopeLine(log));
  lines.push('Levels: ' + countsLine(log.counts));

  const groups = Array.isArray(log.groups) ? log.groups : [];
  if (log.groups_total > groups.length) {
    lines.push(`Showing the ${groups.length} most frequent of ${log.groups_total} distinct problems in these lines.`);
  } else {
    lines.push(`${groups.length} distinct problem${groups.length === 1 ? '' : 's'} in these lines.`);
  }

  if (!groups.length) {
    lines.push('');
    lines.push('Nothing in the lines that were read looks like a PHP error.');
    return lines.join('\n');
  }

  for (const g of groups) {
    lines.push('');
    lines.push(`[${g.level}] x${g.count}  ${g.message}`);
    if (g.file) lines.push(`    at ${g.file}${g.line ? `:${g.line}` : ''}`);
    if (g.last_at) lines.push(`    last ${g.last_at}`);
    for (const s of (g.samples || [])) lines.push('    | ' + s);
    if (g.count > (g.samples || []).length) {
      lines.push(`    (${g.count - (g.samples || []).length} more like this in the log)`);
    }
  }

  return lines.join('\n');
}
