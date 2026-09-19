#!/usr/bin/env node
/**
 * Local development Postgres for morpheus-self-hosted.
 *
 * Why this exists: the backend needs a real Postgres to run at all, and this
 * machine has no system Postgres, no Homebrew and no Docker. `embedded-postgres`
 * ships real Postgres binaries (as a devDependency), and this script drives them
 * directly with `initdb` / `pg_ctl` so the server runs as a proper DAEMON that
 * survives this script exiting.
 *
 * (Using the `embedded-postgres` class instead would NOT work for a standing dev
 * database: it registers an exit handler that shuts Postgres down as soon as the
 * process ends, so every `start` would immediately stop again.)
 *
 * Everything lives under server/data/, which .gitignore already documents as
 * "local runtime state (freshness cache, embedded pg, etc.)" — so a cluster here
 * is exactly the intended design and never gets committed.
 *
 *   node scripts/dev-db.mjs start     # init if needed, start, ensure the database exists
 *   node scripts/dev-db.mjs stop
 *   node scripts/dev-db.mjs status    # running? how many tables?
 *   node scripts/dev-db.mjs reset     # stop, delete the cluster, start clean
 *   node scripts/dev-db.mjs schema    # prisma db push against it
 *
 * Connection details come from server/.env's DATABASE_URL, so this always matches
 * whatever the app is configured to use.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync, openSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// `pg` is a transitive dependency of embedded-postgres. Resolve it from the
// server's own package root rather than assuming a hoisted path.
const requireFromServer = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'))
const requirePg = () => requireFromServer('pg')

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = resolve(HERE, '..')
const DATA = join(SERVER, 'data', 'pg')
const LOG = join(SERVER, 'data', 'pg.log')

// ── connection details, straight from .env ──────────────────────────────────
function readEnvUrl() {
  const envPath = join(SERVER, '.env')
  if (!existsSync(envPath)) throw new Error(`No ${envPath} — cannot determine the database to run`)
  const line = readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith('DATABASE_URL='))
  if (!line) throw new Error('DATABASE_URL is not set in server/.env')
  const url = line.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '')
  const m = url.match(/^postgresql:\/\/([^:]+):([^@]*)@([^:/]+):(\d+)\/([^?]+)/)
  if (!m) throw new Error('Could not parse DATABASE_URL (expected postgresql://user:pass@host:port/db)')
  const [, user, password, host, port, database] = m
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(`DATABASE_URL host is "${host}", not localhost — this script only manages a LOCAL cluster`)
  }
  return { user, password, host, port: Number(port), database }
}

// ── binaries, resolved from the devDependency's platform package ────────────
function binDir() {
  const plat = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform]
  if (!plat) throw new Error(`Unsupported platform: ${process.platform}`)
  const dir = join(SERVER, 'node_modules', '@embedded-postgres', `${plat}-${process.arch}`, 'native', 'bin')
  if (!existsSync(dir)) {
    throw new Error(`Postgres binaries not found at ${dir}\n  Run: cd server && npm install`)
  }
  const exe = (n) => join(dir, process.platform === 'win32' ? `${n}.exe` : n)
  return { initdb: exe('initdb'), pg_ctl: exe('pg_ctl'), postgres: exe('postgres') }
}

const run = (bin, args, opts = {}) =>
  spawnSync(bin, args, { encoding: 'utf8', ...opts })

function isInitialised() {
  return existsSync(join(DATA, 'PG_VERSION'))
}

function isRunning() {
  const { pg_ctl } = binDir()
  const r = run(pg_ctl, ['-D', DATA, 'status'])
  return r.status === 0
}

// ── commands ────────────────────────────────────────────────────────────────
function start() {
  const cfg = readEnvUrl()
  const { initdb, pg_ctl } = binDir()

  if (!isInitialised()) {
    mkdirSync(DATA, { recursive: true })
    // initdb takes the superuser password from a file so it never appears in
    // the process list. Removed immediately afterwards.
    const pwfile = join(SERVER, 'data', '.pgpw')
    writeFileSync(pwfile, cfg.password, { mode: 0o600 })
    try {
      const r = run(initdb, ['-D', DATA, '-U', cfg.user, '--auth=scram-sha-256', `--pwfile=${pwfile}`, '-E', 'UTF8'])
      if (r.status !== 0) throw new Error(`initdb failed:\n${r.stderr || r.stdout}`)
      console.log(`  initialised cluster for user "${cfg.user}" (scram-sha-256)`)
    } finally {
      try { unlinkSync(pwfile) } catch {}
    }
  }

  if (isRunning()) {
    console.log('  already running')
  } else {
    mkdirSync(dirname(LOG), { recursive: true })
    const out = openSync(LOG, 'a')
    // -w waits for readiness; -l sends server output to the log.
    const r = run(pg_ctl, ['-D', DATA, '-l', LOG, '-o', `-p ${cfg.port}`, '-w', 'start'], { stdio: ['ignore', out, out] })
    if (r.status !== 0) throw new Error(`pg_ctl start failed — see ${LOG}`)
    console.log(`  started on port ${cfg.port} (log: ${LOG.replace(SERVER + '/', '')})`)
  }

  ensureDatabase(cfg)
}

function ensureDatabase(cfg) {
  // No `createdb`/`psql` ship with these binaries, so use the pg client.
  const { Client } = requirePg()
  const admin = new Client({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: 'postgres' })
  return admin.connect()
    .then(() => admin.query('select 1 from pg_database where datname = $1', [cfg.database]))
    .then((res) => {
      if (res.rowCount === 0) {
        return admin.query(`create database "${cfg.database}"`).then(() => console.log(`  created database "${cfg.database}"`))
      }
      console.log(`  database "${cfg.database}" present`)
    })
    .finally(() => admin.end().catch(() => {}))
}

function status() {
  const cfg = readEnvUrl()
  const running = isInitialised() && isRunning()
  console.log(`  cluster:  ${isInitialised() ? DATA.replace(SERVER + '/', '') : 'not initialised'}`)
  console.log(`  running:  ${running ? `yes (port ${cfg.port})` : 'no'}`)
  if (!running) return
  const { Client } = requirePg()
  const c = new Client({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database })
  return c.connect()
    .then(() => c.query("select count(*)::int n from information_schema.tables where table_schema='public'"))
    .then((r) => console.log(`  tables:   ${r.rows[0].n}`))
    .catch((e) => console.log(`  (could not read tables: ${e.message})`))
    .finally(() => c.end().catch(() => {}))
}

function stop() {
  if (!isInitialised()) return console.log('  nothing to stop (not initialised)')
  const { pg_ctl } = binDir()
  if (!isRunning()) return console.log('  not running')
  const r = run(pg_ctl, ['-D', DATA, '-m', 'fast', 'stop'])
  if (r.status !== 0) throw new Error(`pg_ctl stop failed:\n${r.stderr || r.stdout}`)
  console.log('  stopped')
}

function reset() {
  stop()
  if (existsSync(DATA)) { rmSync(DATA, { recursive: true, force: true }); console.log('  cluster deleted') }
  start()
}

function schema() {
  const cfg = readEnvUrl()
  execFileSync(join(SERVER, 'node_modules', '.bin', 'prisma'), ['db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: SERVER,
    env: { ...process.env, DATABASE_URL: `postgresql://${cfg.user}:${cfg.password}@${cfg.host}:${cfg.port}/${cfg.database}?schema=public` },
    stdio: 'inherit',
  })
}

// ── entry ───────────────────────────────────────────────────────────────────
const cmd = process.argv[2] || 'status'
const commands = { start, stop, status, reset, schema }
if (!commands[cmd]) {
  console.error(`Unknown command "${cmd}". Use: ${Object.keys(commands).join(' | ')}`)
  process.exit(2)
}
try {
  await commands[cmd]()
} catch (err) {
  console.error(`\n  ERROR: ${err.message}\n`)
  process.exit(1)
}
