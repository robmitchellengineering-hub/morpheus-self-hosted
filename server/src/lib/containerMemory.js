// The container's own memory, which is the number the kernel acts on.
//
// WHY THIS EXISTS
//
// Three times on 2026-09-24 the production backend stopped answering and came
// back on its own: no error in any log, the last line a routine balance check,
// then Northflank's container entrypoint running again. That is what a cgroup OOM
// kill looks like from inside a process — the kernel never gives it the chance to
// say anything — and the platform reported the deploy COMPLETED throughout.
//
// The obvious instrument was already added and it was not enough. A self-dev turn
// reported `rss=147MB` at its peak against a `256MB` plan, which looked like
// headroom, and the natural conclusion was that memory was not the cause. But
// `process.memoryUsage().rss` describes ONE process, and the heaviest step in a
// turn is esbuild — a CHILD process whose footprint is invisible to it. The OOM
// killer does not read the Node heap; it reads the cgroup. So the reading that
// would actually settle it was never taken.
//
// This reads it. Both cgroup layouts, because the image may move between hosts:
//
//   v2: /sys/fs/cgroup/memory.current      + memory.max
//   v1: /sys/fs/cgroup/memory/memory.usage_in_bytes + memory.limit_in_bytes
//
// `parseCgroupBytes` and `describeContainerMemory` are pure so the arithmetic and
// the "unavailable" case are testable anywhere, including on a Mac with no cgroup
// at all — which is where this was written. scripts/verify-stage-observability.mjs
// exercises them.
import { readFileSync } from 'node:fs';

export const CGROUP_V2 = '/sys/fs/cgroup';
export const CGROUP_V1 = '/sys/fs/cgroup/memory';

/**
 * Bytes from a cgroup counter.
 *
 * `max` means unlimited and a v1 unlimited limit is a huge sentinel number
 * (9223372036854771712), so both come back as null rather than as a limit nobody
 * has. Garbage or an empty read is null too: this feeds a log line, and inventing
 * a number there would be worse than saying nothing.
 */
export function parseCgroupBytes(text) {
  const s = String(text ?? '').trim();
  if (!s || s === 'max' || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  // v1's "unlimited" is not max-adjacent in value, it is simply enormous; treat
  // anything past a terabyte as no limit at all.
  if (n > 1024 ** 4) return null;
  return n;
}

/**
 * The container's memory, or null when nothing can be read.
 *
 * The two layouts are tried in order and mixed freely — a container has one or
 * the other, but reading both costs two failed opens at most and removes a
 * version-detection branch that would only ever be wrong somewhere.
 */
export function containerMemory({ v2 = CGROUP_V2, v1 = CGROUP_V1 } = {}) {
  const tryRead = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
  const usedBytes = parseCgroupBytes(tryRead(`${v2}/memory.current`)) ?? parseCgroupBytes(tryRead(`${v1}/memory.usage_in_bytes`));
  if (usedBytes == null) return null;
  const limitBytes = parseCgroupBytes(tryRead(`${v2}/memory.max`)) ?? parseCgroupBytes(tryRead(`${v1}/memory.limit_in_bytes`));
  return { usedBytes, limitBytes };
}

/** One short token for a log line: container usage against its limit, or why not. */
export function describeContainerMemory(mem) {
  if (!mem || !Number.isFinite(mem.usedBytes)) return 'cgroup=unavailable';
  const mb = (b) => Math.round(b / 1024 / 1024);
  return mem.limitBytes ? `cgroup=${mb(mem.usedBytes)}/${mb(mem.limitBytes)}MB` : `cgroup=${mb(mem.usedBytes)}MB`;
}
