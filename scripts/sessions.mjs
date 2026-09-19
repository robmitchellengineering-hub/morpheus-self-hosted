// Search this machine's DSH session history.
//
// WHY THIS EXISTS
//
// Every session this harness runs is logged to $DSH_HOME/sessions, and until now
// none of it was reachable. That is the one memory source that captures
// REASONING rather than conclusions — docs record what we decided, logs record
// why, what we tried, and what we ruled out. "When did we last touch the compile
// poller, and what did we conclude?" is answerable from here and nowhere else.
//
// FORMAT — worth knowing, because it is not obvious
//
// Each log is a Zstandard file of CONCATENATED FRAMES: one frame is appended per
// event as the session runs (a 2.8MB log is ~1460 frames). Node's
// zstdDecompressSync — and its streaming decompressor — stop at the FIRST frame,
// so reading such a file naively yields ~200 bytes and one event out of 2541.
// The frames are found by scanning for the zstd magic and decompressing each
// independently, which is what framesOf() below does.
//
// Usage:
//   node scripts/sessions.mjs --list                     sessions, titles, dates
//   node scripts/sessions.mjs "drift guard"              search every kind
//   node scripts/sessions.mjs "drift" --kind user        only user messages
//   node scripts/sessions.mjs "neon" --kind tool,result  tool calls + results
//   node scripts/sessions.mjs "deck" --reasoning         include model reasoning
//   node scripts/sessions.mjs "deck" --json --limit 50

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SESSIONS = join(DSH_HOME, 'sessions')
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? def : argv[i + 1]
}
const has = (name) => argv.includes(`--${name}`)
const query = argv.find((a) => !a.startsWith('--') && a !== flag('kind') && a !== flag('limit') && a !== flag('session'))
const kinds = (flag('kind', 'user,assistant,tool,result') || '').split(',').map((s) => s.trim()).filter(Boolean)
const limit = Number(flag('limit', '40'))
const onlySession = flag('session', null)
const wantReasoning = has('reasoning')
const asJson = has('json')

// ── frame-aware decompression ───────────────────────────────────────────────
function framesOf(buf) {
  const parts = []
  let skipped = 0
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] !== ZSTD_MAGIC[0] || buf[i + 1] !== ZSTD_MAGIC[1] || buf[i + 2] !== ZSTD_MAGIC[2] || buf[i + 3] !== ZSTD_MAGIC[3]) continue
    try {
      parts.push(zstdDecompressSync(buf.subarray(i)))
    } catch {
      // A magic sequence inside compressed payload, or a partial trailing frame.
      // Counted rather than ignored so corruption is visible.
      skipped++
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: parts.length, skipped }
}

const textOf = (content, { reasoning = false } = {}) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => {
      if (!b || typeof b !== 'object') return ''
      if (b.type === 'text') return b.text || ''
      if (b.type === 'reasoning') return reasoning ? b.text || '' : ''
      if (b.type === 'tool_use' || b.type === 'tool-call') return `[${b.name}] ${JSON.stringify(b.input ?? b.arguments ?? {})}`
      if (b.type === 'tool-result' || b.type === 'tool_result') return textOf(b.content, { reasoning })
      if (b.type === 'file') return `[file] ${b.attachment?.name || ''}`
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

// ── load one session into flat, searchable entries ──────────────────────────
function loadSession(file) {
  const { text, frames, skipped } = framesOf(readFileSync(file))
  const lines = text.split('\n').filter(Boolean)

  let meta = null
  let title = null
  const entries = []
  let unparsed = 0

  for (const line of lines) {
    let e
    try { e = JSON.parse(line) } catch { unparsed++; continue }
    if (e.type === 'session') { meta = e; continue }
    if (e.type === 'session/title') { title = e.data?.title || title; continue }
    const at = e.time ? new Date(e.time) : null

    if (e.type === 'user/message' && kinds.includes('user')) {
      entries.push({ kind: 'user', at, text: textOf(e.data?.content) })
    } else if (e.type === 'assistant/message' && kinds.includes('assistant')) {
      entries.push({ kind: 'assistant', at, text: textOf(e.data?.message?.content, { reasoning: wantReasoning }) })
    } else if (e.type === 'tool/call' && kinds.includes('tool')) {
      entries.push({ kind: 'tool', at, label: e.data?.name, text: String(e.data?.arguments || '') })
    } else if (e.type === 'tool/result' && kinds.includes('result')) {
      entries.push({ kind: 'result', at, text: textOf(e.data?.message?.content) })
    }
  }

  return {
    file,
    id: meta?.id || file,
    cwd: meta?.cwd || null,
    startedAt: meta?.createdAt ? new Date(meta.createdAt) : null,
    title,
    frames,
    skipped,
    unparsed,
    entries: entries.filter((x) => x.text && x.text.trim()),
  }
}

// ── main ────────────────────────────────────────────────────────────────────
if (!existsSync(SESSIONS)) {
  console.error(`No session directory at ${SESSIONS}`)
  process.exit(1)
}
if (findLogs(SESSIONS).length === 0) {
  // Never report an empty result for a non-empty directory: that is a discovery
  // bug, not an absence of history.
  console.error(`Found no session logs under ${SESSIONS} — the layout may have changed.`)
  process.exit(1)
}
// Sessions live at sessions/<workspace-slug>/<session-id>/session.v3.jsonl.zstd
// — two levels down, not one. Walk for the log files rather than assuming a
// depth, so a layout change does not silently yield "0 sessions".
function findLogs(dir) {
  const found = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) found.push(...findLogs(p))
    else if (e.name === 'session.v3.jsonl.zstd') found.push(p)
  }
  return found
}
const logs = findLogs(SESSIONS)
const sessions = []
for (const f of logs) {
  if (onlySession && !f.includes(onlySession)) continue
  const s = loadSession(f)
  if (s) sessions.push(s)
}
sessions.sort((a, b) => (b.startedAt?.getTime() || 0) - (a.startedAt?.getTime() || 0))

if (has('list') || !query) {
  console.log(`\n${sessions.length} sessions in ${SESSIONS}\n`)
  for (const s of sessions) {
    const when = s.startedAt ? s.startedAt.toISOString().slice(0, 16).replace('T', ' ') : '?'
    const title = (s.title || '(untitled)').slice(0, 58)
    console.log(`  ${when}  ${s.id.slice(0, 22).padEnd(24)} ${String(s.entries.length).padStart(6)} entries  ${title}`)
  }
  if (!query) {
    console.log('\nSearch: node scripts/sessions.mjs "<query>" [--kind user,assistant,tool,result] [--reasoning]\n')
    process.exit(0)
  }
  console.log('')
}

const needle = query.toLowerCase()
const short = (id) => id.replace(/^session-/, '').slice(0, 8)
const results = []
for (const s of sessions) {
  for (const e of s.entries) {
    const idx = e.text.toLowerCase().indexOf(needle)
    if (idx === -1) continue
    const from = Math.max(0, idx - 110)
    const excerpt = (from > 0 ? '…' : '') + e.text.slice(from, idx + needle.length + 160).replace(/\s+/g, ' ').trim() + '…'
    results.push({
      session: s.id,
      sessionShort: short(s.id),
      title: s.title,
      at: e.at,
      kind: e.kind,
      label: e.label || null,
      excerpt,
    })
    if (results.length >= limit) break
  }
  if (results.length >= limit) break
}

if (asJson) {
  console.log(JSON.stringify({ query, count: results.length, results }, null, 2))
  process.exit(0)
}

if (!results.length) {
  console.log(`No match for "${query}" in ${sessions.length} sessions (kinds: ${kinds.join(', ')}${wantReasoning ? ', +reasoning' : ''}).\n`)
  process.exit(0)
}

console.log(`${results.length} match${results.length === 1 ? '' : 'es'} for "${query}"${results.length >= limit ? ` (capped at ${limit})` : ''}\n`)
for (const r of results) {
  const when = r.at ? r.at.toISOString().slice(0, 16).replace('T', ' ') : '?'
  const kind = r.label ? `${r.kind}:${r.label}` : r.kind
  console.log(`  ${when}  ${r.sessionShort}  ${kind.padEnd(18)}  ${r.excerpt}`)
}
console.log('')
