const GH_API = 'https://api.github.com';

export function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Morpheus'
  };
}

export async function ghJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { _error: text }; }
}

export async function getGhUser(token: string): Promise<any> {
  const res = await fetch(`${GH_API}/user`, { headers: ghHeaders(token) });
  return ghJson(res);
}

export async function createRepo(token: string, repoName: string, isPrivate: boolean): Promise<any> {
  const h = ghHeaders(token);
  const res = await fetch(`${GH_API}/user/repos`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ name: repoName, private: isPrivate, auto_init: true })
  });
  if (res.status === 422) {
    const ghUser = await getGhUser(token);
    const existingRes = await fetch(`${GH_API}/repos/${ghUser.login}/${repoName}`, { headers: h });
    return ghJson(existingRes);
  }
  return ghJson(res);
}

export async function pushFiles(
  token: string,
  repoFullName: string,
  files: { path: string; content: string }[],
  commitMessage: string
): Promise<{ branch: string; commitSha: string }> {
  const h = ghHeaders(token);

  // Get the repo's default branch
  const repoRes = await fetch(`${GH_API}/repos/${repoFullName}`, { headers: h });
  const repoData = await ghJson(repoRes);
  const branch = repoData.default_branch || 'main';

  // Get the branch ref's latest commit
  const refRes = await fetch(`${GH_API}/repos/${repoFullName}/git/refs/heads/${branch}`, { headers: h });
  const refData = await ghJson(refRes);
  const parentSha = refData.object?.sha;
  if (!parentSha) throw new Error('Could not find branch ref');

  // Get the parent commit's tree
  const commitRes = await fetch(`${GH_API}/repos/${repoFullName}/git/commits/${parentSha}`, { headers: h });
  const parentCommit = await ghJson(commitRes);
  const baseTreeSha = parentCommit.tree?.sha;

  // Create blobs for all files
  const treeItems: any[] = [];
  for (const file of files) {
    const blobRes = await fetch(`${GH_API}/repos/${repoFullName}/git/blobs`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ content: file.content, encoding: 'utf-8' })
    });
    if (!blobRes.ok) throw new Error(`Failed to create blob for ${file.path}`);
    const blob = await ghJson(blobRes);
    treeItems.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  // Create a new tree with all files (base_tree preserves existing files like README)
  // Retry on 404 — GitHub sometimes isn't ready right after repo creation
  let tree: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const treeRes = await fetch(`${GH_API}/repos/${repoFullName}/git/trees`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems })
    });
    if (treeRes.ok) { tree = await ghJson(treeRes); break; }
    const treeErr = await ghJson(treeRes);
    console.log(`Tree attempt ${attempt + 1}: status=${treeRes.status}, repo=${repoFullName}, baseTree=${baseTreeSha}, items=${treeItems.length}, error=${JSON.stringify(treeErr)}`);
    if (treeRes.status !== 404) throw new Error('Failed to create tree: ' + (treeErr.message || JSON.stringify(treeErr)));
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!tree) throw new Error(`Failed to create tree after retries (repo=${repoFullName}, branch=${branch}, baseTree=${baseTreeSha}, items=${treeItems.length})`);

  // Create a commit pointing to the new tree
  const newCommitRes = await fetch(`${GH_API}/repos/${repoFullName}/git/commits`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ message: commitMessage, tree: tree.sha, parents: [parentSha] })
  });
  if (!newCommitRes.ok) throw new Error('Failed to create commit');
  const newCommit = await ghJson(newCommitRes);

  // Update the branch ref to point to the new commit
  const updateRefRes = await fetch(`${GH_API}/repos/${repoFullName}/git/refs/heads/${branch}`, {
    method: 'PATCH', headers: h,
    body: JSON.stringify({ sha: newCommit.sha })
  });
  if (!updateRefRes.ok) throw new Error('Failed to update branch ref');

  return { branch, commitSha: newCommit.sha };
}

// Encrypt a secret value with a repository's public key and set it as a
// GitHub Actions secret. GitHub requires NaCl sealed-box encryption — the
// raw value cannot be sent as encrypted_value (it would be stored as garbage
// and the workflow would fail with "secret not found").
export async function encryptAndSetGithubSecret(
  token: string,
  repoFullName: string,
  secretName: string,
  secretValue: string
): Promise<{ ok: boolean; error?: string }> {
  const h = ghHeaders(token);

  // 1. Get the repo's public key
  const keyRes = await fetch(`${GH_API}/repos/${repoFullName}/actions/secrets/public-key`, { headers: h });
  if (!keyRes.ok) return { ok: false, error: `Failed to get repo public key (${keyRes.status})` };
  const keyData = await keyRes.json();
  const publicKey: string = keyData.key;
  const keyId: string = keyData.key_id;

  // 2. Encrypt with NaCl sealed box (libsodium)
  const sodium = await import('npm:libsodium-wrappers@0.7.15');
  await sodium.default.ready;
  const binKey = sodium.default.from_base64(publicKey, sodium.default.base64_variants.ORIGINAL);
  const binSecret = sodium.default.from_string(secretValue);
  const encrypted = sodium.default.crypto_box_seal(binSecret, binKey);
  const encryptedB64 = sodium.default.to_base64(encrypted, sodium.default.base64_variants.ORIGINAL);

  // 3. Set the secret
  const setRes = await fetch(`${GH_API}/repos/${repoFullName}/actions/secrets/${secretName}`, {
    method: 'PUT', headers: h,
    body: JSON.stringify({ encrypted_value: encryptedB64, key_id: keyId })
  });
  if (!setRes.ok) {
    const err = await setRes.text().catch(() => '');
    return { ok: false, error: `Failed to set secret (${setRes.status}): ${err.substring(0, 100)}` };
  }
  return { ok: true };
}