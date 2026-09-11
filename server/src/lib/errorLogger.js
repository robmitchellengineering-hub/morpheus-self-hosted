// Shared error logging + response helper with secret redaction.
// The production logs (Northflank) only capture stdout/stderr. Most route
// handlers caught errors and responded with 500 JSON without ever logging,
// so runtime errors were invisible. This centralizes logging with secret
// redaction to avoid leaking credentials into logs.

const SECRET_KEY_PATTERNS = [
  // key=value / key: value (with optional quotes) — common in error messages
  /(\b(?:key|token|secret|password|passwd|pwd|api[_-]?key)\b\s*[:=]\s*)(['"]?)[^'",;\s]+(\2|)/gi,
  // JSON-like "key": "value"
  /("(?:key|token|secret|password|passwd|pwd|api[_-]?key)"\s*:\s*")([^"]*)(")/gi,
];

function redactSecrets(text) {
  if (!text) return String(text);
  let safe = String(text);
  for (const regex of SECRET_KEY_PATTERNS) {
    safe = safe.replace(regex, (match) => {
      // For pattern 1, keep the key and opening quote, replace value with ****.
      const valueStart = match.search(/[:=]/);
      if (valueStart !== -1) {
        const keyPart = match.slice(0, valueStart + 1); // includes ':' or '='
        const openingQuote = match[valueStart + 1] === '"' || match[valueStart + 1] === "'" ? match[valueStart + 1] : '';
        return `${keyPart}${openingQuote}****${openingQuote}`;
      }
      // Pattern 2 replacement
      return match.replace(/("\s*:\s*")([^"]*)(")/, '$1****$3');
    });
  }
  return safe;
}

export function logError(prefix, err) {
  const message = err?.message || String(err);
  const safeMessage = redactSecrets(message);
  const stack = err?.stack ? redactSecrets(err.stack) : undefined;
  console.error(`[${prefix}]`, safeMessage);
  if (stack && stack !== safeMessage) console.error(stack);
}

export function sendError(res, status, prefix, err) {
  logError(prefix, err);
  const message = err?.message || 'Internal error';
  return res.status(status).json({ error: message });
}
