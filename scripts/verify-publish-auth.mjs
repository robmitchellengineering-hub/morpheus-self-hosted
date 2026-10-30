#!/usr/bin/env node
// verify-publish-auth.mjs — publishing needs an admin session OR the release token, and an UNSET token accepts nothing.
import { mayPublish } from '../server/src/lib/publishAuth.js';

let wrong = 0;
const check = (n, ok) => { if (!ok) wrong++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}`); };
const req = (token) => ({ headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });

{
  delete process.env.VALIANT_PUBLISH_TOKEN;
  check('with no token configured, an anonymous caller cannot publish', mayPublish({ req: req('') }) === false);
  check('…and an unset token is not "empty is fine"', mayPublish({ req: req(undefined) }) === false);
  check('…and any guess is refused', mayPublish({ req: req('guess') }) === false);
}
{
  process.env.VALIANT_PUBLISH_TOKEN = 'secret-release-token';
  check('the configured token publishes', mayPublish({ req: req('secret-release-token') }) === true);
  check('a wrong token is refused', mayPublish({ req: req('secret-release-toke') }) === false);
  check('a longer token is refused without throwing', mayPublish({ req: req('secret-release-token-plus') }) === false);
  check('no header at all is refused', mayPublish({ req: req(undefined) }) === false);
  check('an admin session still publishes', mayPublish({ user: { id: 'u1', role: 'admin' }, req: req('') }) === true);
  check('a non-admin session alone does not', mayPublish({ user: { id: 'u2', role: 'user' }, req: req('') }) === false);
  delete process.env.VALIANT_PUBLISH_TOKEN;
}
console.log(`\n${wrong === 0 ? 'publishing is admin-or-release-token, and an unset token grants nothing' : `${wrong} case(s) wrong`}\n`);
process.exit(wrong === 0 ? 0 : 1);
