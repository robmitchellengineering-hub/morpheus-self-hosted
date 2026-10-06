/**
 * ⚠️ IS THIS PACKAGE UNDELIVERABLE? — the check that would have saved Rob a round trip on 2026-10-06.
 *
 * The whole update channel is VERSION-COMPARED: the app offers an update when the published version is newer
 * than the installed one (`isNewer(latestVersion, store.version)`), WordPress's own plugin screen compares the
 * same two numbers, and the plugin's self-updater calls `is_newer( manifest, running )`. So a change to the
 * plugin's code WITHOUT A VERSION BUMP IS INVISIBLE TO EVERY SITE THAT HAS IT INSTALLED — the fix is published,
 * the zip is current, the hash matches, and nobody is ever offered it.
 *
 * That is exactly what happened: the two-canonical fix shipped at 0.8.5 over a published 0.8.5, and Rob's
 * report was "both the Morpheus site and wordpress dont give me update options". Nothing in the repo could see
 * it, because every version string agreed — three copies of one fact, all consistently stale.
 *
 * The one place the question CAN be answered is here, at pack time, where the live manifest is reachable: if the
 * version we are about to publish is the version already published, and the bytes are different, then this build
 * can never reach anybody. Fail the deploy loudly instead.
 *
 * @param {?{version: string, sha256: string}} live  the manifest currently served, or null if unknown
 * @param {{version: string, sha256: string}} next   the one we are about to write
 * @return {?string} the reason it cannot ship, or null
 */
export function undeliverable(live, next) {
  if (!live || !live.version || !live.sha256) return null; // cannot check — say nothing rather than guess
  if (live.version !== next.version) return null;          // a bump: the channel works
  if (live.sha256 === next.sha256) return null;            // identical build: nothing to deliver
  return `the plugin changed but the version did not (still ${next.version}), so no site will ever be offered it`;
}

