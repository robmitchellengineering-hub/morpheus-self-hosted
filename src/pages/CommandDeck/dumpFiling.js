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
export function summarizeFiling({ labels = [], failedTexts = [], originalText = '' } = {}) {
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

  return { message, restore, landed, total };
}
