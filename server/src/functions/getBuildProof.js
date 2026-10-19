// Return the BUILD-PROOF.txt a build published, so the panel can show what a build verified.
//
// WHY THIS IS ITS OWN FUNCTION RATHER THAN PART OF getCompileStatus. That function is POLLED every few
// seconds while a build runs, and the proof is only meaningful once, at the end. Fetching a file from GitHub
// on every poll would spend API calls and rate limit on the same bytes. So the panel asks for it once, when
// the run has finished, and this does exactly one release lookup and one small download.
//
// ── WHY THE FILE EXISTS AT ALL, since this is the second surface for it ──────────────────────────────────
// The proof already ships beside the artifacts and lands in the user's `_compiled/`. It is repeated here
// because a download is not where you look after a build — the panel is. Same file, same bytes, no second
// source of truth: this function fetches the asset the BUILD wrote, and never composes any of it.
//
// A MISSING PROOF IS NOT AN ERROR. Every target Morpheus has predates the proof format, so a build from
// before it, or a target that does not produce one, answers `{ proof: null }` with a reason. The panel shows
// nothing rather than an empty box.
import { ghHeaders, ghJson, getGithubToken } from '../lib/github.js';
import { BUILD_PROOF_FILE } from '../lib/buildProof.js';

const GH_API = 'https://api.github.com';

/** In UTF-8 bytes. A proof of an ordinary build is a few KB; this is a guard against a wrong asset. */
const MAX_PROOF_BYTES = 256 * 1024;

export default async function handler({ user, body }) {
  const { repoFullName, releaseTag } = body || {};
  if (!repoFullName) throw Object.assign(new Error('repoFullName required'), { status: 400 });
  if (!releaseTag) throw Object.assign(new Error('releaseTag required'), { status: 400 });

  const accessToken = await getGithubToken(user.id);
  const h = ghHeaders(accessToken);

  const releaseRes = await fetch(`${GH_API}/repos/${repoFullName}/releases/tags/${releaseTag}`, { headers: h });
  if (!releaseRes.ok) {
    // The release can still be filling up, or the tag can be wrong. Either way this is not a broken build,
    // and the panel must not turn it into one.
    return { proof: null, reason: `release ${releaseTag} not readable (HTTP ${releaseRes.status})` };
  }
  const release = await ghJson(releaseRes);
  const asset = (release.assets || []).find((a) => a.name === BUILD_PROOF_FILE);
  if (!asset) {
    return { proof: null, reason: `this build published no ${BUILD_PROOF_FILE}` };
  }
  if (asset.size > MAX_PROOF_BYTES) {
    return { proof: null, reason: `${BUILD_PROOF_FILE} is ${asset.size} bytes, larger than this reader accepts` };
  }

  // The asset API URL with an octet-stream Accept header is what returns the bytes; the
  // browser_download_url redirects to storage and is the fallback, exactly as saveCompiledArtifacts does.
  let res = await fetch(asset.url, { headers: { ...h, Accept: 'application/octet-stream' }, redirect: 'follow' });
  if (!res.ok) {
    res = await fetch(asset.browser_download_url, { headers: { ...h, Accept: 'application/octet-stream' }, redirect: 'follow' });
  }
  if (!res.ok) {
    return { proof: null, reason: `could not read ${BUILD_PROOF_FILE} (HTTP ${res.status})` };
  }
  const proof = await res.text();
  return { proof, releaseTag, assetName: asset.name };
}
