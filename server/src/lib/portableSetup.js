// What a local (Portable Morpheus) install needs, and the honest words for what it does not have yet.
//
// WHY THIS IS A MODULE AND NOT JUST A SCRIPT. `scripts/portable-setup.mjs` does the work, but the RULE
// — which secrets a local install must generate, what the .env says, what the steps are, and what is
// still missing — is asserted by `scripts/verify-portable-setup.mjs` in CI's no-install job. So it
// lives here, import-free, the same way creditPolicy.js and portableBundle.js do.
//
// THE THING THIS MUST NOT DO is grow a second way to run the database. The repo already has one:
// `server/scripts/dev-db.mjs` drives real `embedded-postgres` binaries with initdb/pg_ctl (not the
// library's class, which shuts Postgres down when the process exits — its header explains that, and it
// was measured here: the class starts and stops fine, but cannot be a standing database). The installer
// delegates to it. If that script ever disappears, this one must fail loudly rather than invent a
// replacement.

/** Node major version the server needs. */
export const REQUIRED_NODE_MAJOR = 20;

/** The database the local install owns. Kept localhost on purpose — dev-db.mjs refuses anything else. */
export const LOCAL_DB = { host: '127.0.0.1', port: 54329, user: 'morpheus', database: 'morpheus' };

/**
 * Values a local install must GENERATE, because a person downloading a zip cannot be asked to invent
 * them. `how` is what the setup prints so the reason is visible rather than magic.
 */
export const GENERATED_ENV = [
  { key: 'JWT_SECRET', how: '48 random bytes, base64url — signs this install\'s own sessions' },
  { key: 'ENCRYPTION_KEY', how: '32 random bytes, base64 — encrypts stored connection credentials at rest. lib/crypto.js throws without it; the bytes are exact, not decorative' },
  { key: 'DATABASE_URL', how: 'the local cluster this install starts; no hosted database involved' },
];

/** Values that are fixed for a single-machine install rather than secret. */
export const LOCAL_ENV = {
  NODE_ENV: 'production',
  PORT: '4500',
};

/**
 * The `.env` a local install gets, written once and never overwritten.
 *
 * The AI lines are present but EMPTY, and say so: the decided ordering is a working paid default with
 * local as opt-in, and neither is wired yet — so the honest thing a fresh install can do is name the
 * three places AI can come from rather than pretend one is configured. Owner: MORPHEUS-BIG-PICTURE.md
 * → Portable Morpheus.
 */
export function envFileContents({ secrets }) {
  const lines = [
    '# Written by scripts/portable-setup.mjs — Portable Morpheus, running on this machine.',
    '# This file holds this install\'s own secrets. It is gitignored; do not commit it, and do not',
    '# paste it into a chat or an issue. Delete it to make the setup generate fresh ones.',
    '',
    `NODE_ENV=${LOCAL_ENV.NODE_ENV}`,
    `PORT=${LOCAL_ENV.PORT}`,
    `DATABASE_URL=${secrets.DATABASE_URL}`,
    `JWT_SECRET=${secrets.JWT_SECRET}`,
    `ENCRYPTION_KEY=${secrets.ENCRYPTION_KEY}`,
    '',
    '# No AI provider is configured yet. Pick ONE (see PORTABLE-README.md):',
    '#   locally hosted model   LLM_BASE_URL=http://localhost:11434/v1   LLM_MODEL=<model>',
    '#   your own provider key  LLM_BASE_URL=<provider>   LLM_API_KEY=<key>   LLM_MODEL=<model>',
    '#   a Morpheus account     leave the LLM_* lines alone and sign in with the account instead',
    'LLM_BASE_URL=',
    'LLM_API_KEY=',
    'LLM_MODEL=',
    '',
    '# Google and GitHub sign-in are OFF on a local install: both need redirect URIs registered',
    '# against a stable hostname, which a local machine does not have. Email and password work.',
    '',
  ];
  return lines.join('\n');
}

/** The steps, in order, as the installer runs them and as `--check` prints them. */
export const INSTALL_STEPS = [
  { id: 'node', title: `Node ${REQUIRED_NODE_MAJOR}+ present` },
  { id: 'env', title: 'Write server/.env with secrets generated for this machine (never overwriting one)' },
  { id: 'deps', title: 'Install dependencies (root and server/)' },
  { id: 'db', title: 'Start the local Postgres cluster (server/scripts/dev-db.mjs start)' },
  { id: 'schema', title: 'Apply the Prisma schema to it (server/scripts/dev-db.mjs schema)' },
  { id: 'build', title: 'Build the frontend, which the server then serves from the same origin' },
];

/**
 * What a local install still does NOT do. Printed by `--check` and by the setup's closing summary, and
 * asserted by the guard: a setup that implies a finished product is the claim-vs-system failure this
 * repo keeps catching. Keep this list current in the same change that closes an item.
 */
export const NOT_INSTALLED_YET = [
  'Remote access is a script, but Tailscale itself is yours to install and sign in to: npm run portable:remote (we do not install a VPN for you).',
  'The paid AI default still cannot work out of the box: the Morpheus Cloud broker that would make it work is not deployed (npm run portable:ai -- --use local or --use key works today).',
  'A native app or installer — this is a command, not a double-clickable package.',
];

/** The URL the install ends up serving. */
export function localUrl(port = Number(LOCAL_ENV.PORT)) {
  return `http://localhost:${port}`;
}

/** `{ ok, problems }` — what is wrong with this machine/environment, before anything is written. */
export function preflight({ nodeMajor, platform }) {
  const problems = [];
  if (!Number.isFinite(nodeMajor) || nodeMajor < REQUIRED_NODE_MAJOR) {
    problems.push(`Node ${REQUIRED_NODE_MAJOR}+ is required; this is ${nodeMajor || 'unknown'}.`);
  }
  if (!['darwin', 'linux', 'win32'].includes(platform)) {
    problems.push(`No Postgres binaries are published for "${platform}" by embedded-postgres; use an existing DATABASE_URL instead.`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Two secrets from a caller-supplied byte source, so this is testable without a crypto import and so
 * the widths are visible: ENCRYPTION_KEY must decode to exactly 32 bytes (lib/crypto.js enforces it)
 * and JWT_SECRET is a signing key, so it gets more entropy than it needs rather than fewer.
 */
export function generateSecrets(randomBytes) {
  // base64url, not base64: the value goes INSIDE the DATABASE_URL, and a `+`, `/` or `=` in a
  // password is a parsing bug waiting for a different random draw. dev-db.mjs hands this password to
  // initdb via --pwfile with scram-sha-256, so it is a real credential, not a formality.
  const password = Buffer.from(randomBytes(18)).toString('base64url');
  return {
    JWT_SECRET: Buffer.from(randomBytes(48)).toString('base64url'),
    ENCRYPTION_KEY: Buffer.from(randomBytes(32)).toString('base64'),
    DATABASE_URL: `postgresql://${LOCAL_DB.user}:${password}@${LOCAL_DB.host}:${LOCAL_DB.port}/${LOCAL_DB.database}`,
  };
}

/**
 * The DATABASE_URL shape `server/scripts/dev-db.mjs` parses. It is a contract between two files, so it
 * is stated once here and the guard asserts BOTH that a generated URL matches it and that dev-db.mjs
 * still contains this exact pattern — a copy in the guard alone would drift from the real parser and
 * pass while the installer broke.
 */
export const DEV_DB_URL_PATTERN = '^postgresql:\\/\\/([^:]+):([^@]*)@([^:/]+):(\\d+)\\/([^?]+)';

/** A `.env` value must never be echoed to a terminal that might be logged or screen-shared. */
export function redactEnvLine(line) {
  const key = String(line).split('=')[0];
  return GENERATED_ENV.some((g) => g.key === key) ? `${key}=<generated, written to server/.env>` : line;
}
