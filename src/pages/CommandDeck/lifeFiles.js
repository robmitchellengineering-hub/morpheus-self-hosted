// What a life-stream attachment records, as pure logic.
//
// The old base44 deck's `LifeFile` stored the stream, url, name, type and whether it was an image; the
// port kept text notes only and dropped all of it, so a bill or a lab result had nowhere to live. Rob
// confirmed the gap from the UI side on 2026-10-02.
//
// Only the DECIDING is here — everything else is rendering — so a guard can reach it without a browser.
// Dependency-free, so scripts/verify-life-files.mjs runs in CI's no-install guards job.

/**
 * The row to store for a finished upload.
 *
 * `is_image` is decided from the MIME type the browser reports, and defaults to FALSE rather than
 * throwing when there isn't one: a file with no type is shown as a document. The wrong guess the other
 * way round is worse — an <img> pointing at something that is not an image renders as a broken box,
 * whereas a document icon next to a photo is merely plain.
 */
export function describeUpload(file, fileUrl) {
  const type = String(file?.type || '');
  return {
    file_url: String(fileUrl || ''),
    file_name: String(file?.name || ''),
    file_type: type,
    is_image: type.startsWith('image/'),
  };
}

/**
 * Attachments grouped by life stream, keyed on `life_stream_id`.
 *
 * Used to hang each stream's files on the stream the widget already renders. Rows with no stream — or
 * with one that no longer exists — are dropped rather than shown under a stream they do not belong to.
 */
export function groupByStream(files, streamIds) {
  const known = new Set(streamIds || []);
  const out = {};
  for (const f of Array.isArray(files) ? files : []) {
    if (!f?.life_stream_id || !known.has(f.life_stream_id)) continue;
    (out[f.life_stream_id] ||= []).push(f);
  }
  return out;
}
