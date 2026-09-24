// server/src/functions/getProvingGroundStatus.js
// Admin-only status read for the Proving Ground's compact status strip.
// Returns three cheap, read-only signals: container memory, the number of
// self-dev run records, and the current self-dev branch.
// Each is best-effort: a failure in any one does not fail the others, and
// the whole function degrades to safe defaults rather than erroring.
import { prisma } from '../db.js';

/** Read cgroup memory and format as MiB. Falls back to null on failure. */
async function readCgroupMemoryMiB() {
  try {
    // cgroup v2 first, then v1.
    const fs = await import('node:fs/promises');
    const candidates = [
      '/sys/fs/cgroup/memory.current',
      '/sys/fs/cgroup/memory/memory.usage_in_bytes',
    ];
    for (const path of candidates) {
      try {
        const raw = await fs.readFile(path, 'utf8');
        const bytes = parseInt(raw.trim(), 10);
        if (Number.isFinite(bytes) && bytes >= 0) {
          return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
        }
      } catch (err) {
        // try next path
      }
    }
  } catch (err) {
    // ignore
  }
  return null;
}

/** Attempt to use the existing containerMemory helper if present. */
async function getContainerMemoryMiB() {
  try {
    const memory = await import('../lib/containerMemory.js');
    // Look for any export that looks like a getter.
    const getter = memory.getContainerMemoryMiB || memory.getContainerMemory || memory.getMemory || memory.default;
    if (typeof getter === 'function') {
      const result = await getter();
      if (typeof result === 'string' && result.trim()) return result;
      if (typeof result === 'number') return `${(result / 1024 / 1024).toFixed(1)} MiB`;
    }
  } catch (err) {
    // fall through to cgroup read
  }
  return readCgroupMemoryMiB();
}

/** Attempt to get the current self-dev branch from the selfDevRepo helper. */
async function getSelfDevBranch() {
  try {
    const selfDevRepo = await import('../lib/selfDevRepo.js');
    if (typeof selfDevRepo.getCurrentBranch === 'function') {
      const branch = await selfDevRepo.getCurrentBranch();
      if (branch && typeof branch === 'string') return branch;
    }
    if (selfDevRepo.currentBranch && typeof selfDevRepo.currentBranch === 'string') {
      return selfDevRepo.currentBranch;
    }
  } catch (err) {
    // keep default
  }
  return 'main';
}

export default async function handler({ user }) {
  // Admin-only: the dispatcher gate already checks role, but guard here too.
  if (!user || user.role !== 'admin') {
    return { available: false, reason: 'admin only' };
  }

  const [memory, runCount, branch] = await Promise.allSettled([
    getContainerMemoryMiB(),
    prisma.selfDevRun.count().catch(() => null),
    getSelfDevBranch(),
  ]);

  return {
    memory: memory.status === 'fulfilled' && memory.value ? memory.value : 'unavailable',
    runCount: runCount.status === 'fulfilled' && typeof runCount.value === 'number' ? runCount.value : null,
    branch: branch.status === 'fulfilled' && branch.value ? branch.value : 'main',
  };
}
