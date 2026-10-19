// What to say after a dictated dump has been filed, and what to put back in the box.
//
// WHY THIS EXISTS (2026-09-27)
//
// The filing loop created a row per item and then reported them all. Two ways it lied:
//
//   1. If creating item 2 of 3 threw, the catch restored the WHOLE dump with "try
//      again" while item 1's row stayed — so pressing + again filed item 1 twice.
//   2. `addLifeNote` swallowed its own failure, so the loop still counted a life
//      stream in the green "Filed N items" line for a note that was never written.
//
// The rule this encodes: the success line reports what LANDED, and only what did not
// land goes back in the box. If nothing landed, the whole original text goes back —
// safe, because nothing was written that a retry could duplicate. Telling "Filed 2 of 3"
// apart from "Filed 3" is the whole point: a green tick over lost words is the failure
// the deck's own capture rule exists to prevent ("nothing may be silently dropped").
//
// Pure and import-free, so scripts/verify-dump-filing.mjs can assert every case without
// a browser or a server.

/**
 * @param {{labels?: string[], failedTexts?: string[], originalText?: string}} args
 *   labels       — one label per item that LANDED
 *   failedTexts  — the text of each item that did not
 *   originalText — the whole dump, returned only when nothing landed
 * @returns {{message: string|null, restore: string, landed: number, total: number}}
 */
export function summarizeFiling({ labels = [], failedTexts = [], originalText = '', fallbackReasons = [] } = {}) {
  const landed = labels.length;
  const total = landed + failedTexts.length;
  const set = [...new Set(labels)].join(', ');

  let message = null;
  if (landed > 0 && failedTexts.length > 0) message = `Filed ${landed} of ${total}: ${set}`;
  else if (landed === 1) message = `Filed to ${set}`;
  else if (landed > 1) message = `Filed ${landed} items: ${set}`;

  // Some landed: only the items that did not, so a retry cannot file the successful
  // ones a second time. Nothing landed: the WHOLE dump, because there is nothing to
  // duplicate and the speaker's own words are the valuable part — the classifier may
  // have condensed the items it returned, and "file the original rather than a summary"
  // is the same rule the server applies when classification is uncertain.
  const restore = landed > 0 ? failedTexts.join('. ') : originalText;

  // A dump that came back as one unclassified item used to read exactly like a dump the
  // classifier handled: "Filed to Knowledge". Say which it was, using the reason the
  // classifier attached. (`nothing-classified` means the model produced nothing usable;
  // `incomplete` means it dropped part and the whole text was kept instead.)
  if (message && fallbackReasons.length) {
    message += fallbackReasons.includes('nothing-classified')
      ? ' — I could not classify it, so your words are in there whole'
      : ' — part of it would not classify, so the whole note was kept';
  }

  return { message, restore, landed, total };
}

/**
 * Why a press of + filed nothing, in the operator's words.
 *
 * A capture that fails silently is the failure this whole area exists to prevent. Until now the
 * outer catch in `addDump` restored the text and set the deck's generic save flag, which renders as
 * a small "· couldn't save last change — try again" suffix on a line elsewhere on the page — so a
 * press that filed nothing looked exactly like a press that did nothing at all. Measured
 * 2026-10-02: nothing had been written to ANY deck table for sixteen hours and the only signal was
 * that suffix. Rob: "just sits there doing nothing when i hit the plus button."
 *
 * The causes are worth telling apart, because what the operator does next is different for each —
 * and in every one of them the speaker's words are still in hand, which is the part that must be
 * said out loud rather than left to be discovered.
 */
export function captureFailureMessage(err) {
  const safe = 'Your words are still in the box.';
  const status = Number(err?.status) || 0;
  const code = String(err?.code || '');

  // Checked before `status`, because apiFetch's timeout sets status 0 and would otherwise be
  // reported as a connection failure — a different cause with a different next move.
  if (code === 'CLIENT_TIMEOUT') {
    return `Morpheus did not answer in time, so nothing was filed. ${safe}`;
  }
  if (status === 401 || status === 403) {
    return `Your sign-in has expired, so nothing was filed. Sign in again and press + once more and it will file. ${safe}`;
  }
  if (status >= 500) {
    return `Morpheus could not file that (server error ${status}), so nothing was filed. ${safe}`;
  }
  if (!status) {
    return `Could not reach Morpheus, so nothing was filed — check the connection and press + again. ${safe}`;
  }
  return `Nothing was filed (${status}${err?.message ? `: ${err.message}` : ''}). ${safe}`;
}
