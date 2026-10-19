// AES-256-GCM encryption for secrets at rest (AI/TTS API keys, GitHub
// tokens, backend API keys). Falls back to a deterministic dev key with a
// loud warning if ENCRYPTION_KEY isn't set — never rely on that in prod.
import crypto from 'node:crypto';

function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || raw === 'change-me-32-byte-base64-key') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('ENCRYPTION_KEY must be set to a real 32-byte base64 value in production. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
    }
    console.warn('[morpheus] ENCRYPTION_KEY not set — using an insecure dev-only key. Set ENCRYPTION_KEY before deploying.');
    return crypto.createHash('sha256').update('morpheus-dev-insecure-key').digest();
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes (base64-encoded).');
  return key;
}

export function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return plaintext;
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decrypt(payload) {
  if (payload == null || payload === '') return payload;
  if (!String(payload).startsWith('v1:')) return payload; // unencrypted legacy/plain value
  const [, ivB64, tagB64, dataB64] = String(payload).split(':');
  const key = getKey();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}
