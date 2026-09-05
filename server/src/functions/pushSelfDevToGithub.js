import { prisma } from '../db.js';
import { getGithubConnection, fetchRemoteTree, createOrUpdateFile, deleteFile } from '../lib/github.js';
import { getFileBuffer } from '../storage.js';
import crypto from 'crypto';

// Push only changed files to the real self-hosted repo.
// Compares local workspace (ProjectFile rows) against the remote Git tree
// and creates/updates/deletes only what differs. Treats the local workspace
// as source of truth, deleting remote files that no longer exist locally.
// Each file operation results in its own commit via the GitHub Contents API.
// Binary files (with file_url) are fetched as Buffers and pushed via a
// dedicated helper that base64-encodes them; text files use the existing
// createOrUpdateFile import to preserve its behavior exactly.
const REPO_OWNER = 'robmitchellengineering-hub';
const REPO_NAME = 'morpheus-self-hosted';
const BRANCH = 'main';

function computeGitBlobSha(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const header = Buffer.from(`blob ${buf.length}\0`);
  return crypto.createHash('sha1').update(header).update(buf).digest('hex');
}

async function createOrUpdateBinaryFile(owner, repo, path, contentBuffer, branch, token, message, sha) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      content: contentBuffer.toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => 'unknown error');
    throw new Error(`GitHub API error (${res.status}) for ${path}: ${errText}`);
  }
  return res.json();
}

export default async function handler({ user, body }) {
  const { projectId } = body;
  if (!projectId) throw Object.assign(new Error('projectId required'), { status: 400 });

  const project = await prisma.project.findFirst({
    where: { id: projectId, created_by_id: user.id },
  });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });

  const connection = await getGithubConnection(user.id);
  const token = connection.accessToken;

  // Fetch remote tree (blobs only) for the branch.
  const remoteEntries = await fetchRemoteTree(REPO_OWNER, REPO_NAME, BRANCH, token);
  const remoteMap = new Map(remoteEntries.map((e) => [e.path, e.sha]));

  // Load all local files for this project.
  const localFiles = await prisma.projectFile.findMany({ where: { project_id: projectId } });
  const localMap = new Map();

  for (const f of localFiles) {
    if (f.file_url) {
      try {
        const buffer = await getFileBuffer(f.file_url);
        if (!Buffer.isBuffer(buffer)) {
          throw new Error('getFileBuffer did not return a Buffer');
        }
        localMap.set(f.path, buffer);
      } catch (err) {
        throw new Error(`Failed to read binary content for ${f.path}: ${err.message}`);
      }
    } else {
      localMap.set(f.path, f.content);
    }
  }

  const changes = {
    create: [],
    update: [],
    delete: [],
  };

  // Detect creates and updates.
  for (const [path, content] of localMap.entries()) {
    const localBlobSha = computeGitBlobSha(content);

    if (!remoteMap.has(path)) {
      changes.create.push({ path, content });
    } else if (remoteMap.get(path) !== localBlobSha) {
      changes.update.push({ path, content, remoteSha: remoteMap.get(path) });
    }
  }

  // Detect deletes: remote paths not present locally.
  const localPaths = new Set(localMap.keys());
  for (const remotePath of remoteMap.keys()) {
    if (!localPaths.has(remotePath)) {
      changes.delete.push({ path: remotePath, remoteSha: remoteMap.get(remotePath) });
    }
  }

  const totalChanges = changes.create.length + changes.update.length + changes.delete.length;
  if (totalChanges === 0) {
    return {
      fileCount: 0,
      createCount: 0,
      updateCount: 0,
      deleteCount: 0,
      commitUrl: null,
      message: 'No changes to push — workspace already matches remote.',
    };
  }

  let lastCommitUrl = null;

  // Process creates and updates.
  const processWrite = async (item) => {
    const message = `Update ${item.path} via Morpheus Self-Dev`;
    let res;
    if (Buffer.isBuffer(item.content)) {
      res = await createOrUpdateBinaryFile(
        REPO_OWNER,
        REPO_NAME,
        item.path,
        item.content,
        BRANCH,
        token,
        message,
        item.remoteSha
      );
    } else {
      res = await createOrUpdateFile(
        REPO_OWNER,
        REPO_NAME,
        item.path,
        item.content,
        BRANCH,
        token,
        message,
        item.remoteSha // only present for updates; undefined for creates
      );
    }
    if (res.commit?.html_url) lastCommitUrl = res.commit.html_url;
  };

  for (const item of changes.create) {
    await processWrite(item);
  }
  for (const item of changes.update) {
    await processWrite(item);
  }

  // Process deletes.
  for (const item of changes.delete) {
    const message = `Delete ${item.path} via Morpheus Self-Dev`;
    const res = await deleteFile(
      REPO_OWNER,
      REPO_NAME,
      item.path,
      BRANCH,
      item.remoteSha,
      token,
      message
    );
    if (res.commit?.html_url) lastCommitUrl = res.commit.html_url;
  }

  return {
    fileCount: totalChanges,
    createCount: changes.create.length,
    updateCount: changes.update.length,
    deleteCount: changes.delete.length,
    commitUrl: lastCommitUrl,
    repoFullName: `${REPO_OWNER}/${REPO_NAME}`,
    branch: BRANCH,
  };
}
