#!/usr/bin/env node
// fixture-issuer.mjs — a throwaway issuer that serves one signed revocation list, for tests only.
//
// WHY IT IS A SEPARATE PROCESS. A test that starts an HTTP server inside itself and then calls `spawnSync` blocks its own event loop:
// the child's request can arrive before the server is listening, and the test then reports a product bug that is really a race. One
// process serves, another drives, and the port is written to a file so readiness is a fact rather than a timer.
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const [token, portFile] = process.argv.slice(2);
if (!token || !portFile) { console.error('usage: fixture-issuer.mjs <token> <port-file>'); process.exit(2); }

const srv = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, list: token }));
});
srv.listen(0, '127.0.0.1', () => {
  writeFileSync(portFile, String(srv.address().port));
});
const bye = () => { try { srv.close(); } catch { /* closing */ } process.exit(0); };
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
