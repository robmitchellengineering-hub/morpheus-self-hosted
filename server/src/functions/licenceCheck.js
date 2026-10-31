// licenceCheck.js — the online licence check the SDK asks (Rob, 2026-11-02: "licence verification needs to be done online").
//
// It answers three questions and nothing else: is this token genuinely ours, is it still in date, and has it been revoked. The public key
// is committed, so a token accepted here is one the SDK would also accept; the database supplies the revocation, which is the fact a token
// cannot carry.
//
// PUBLIC like the other six, because an SDK on a customer's laptop has no account here. That makes it safe to be boring: bounded input, no
// echo of the token, no detail beyond a reason string.
//
// THE DECISION LIVES IN lib/licenceDecision.js. It used to live here, which meant the only way to test "a database that will not answer is
// not reported as valid" was to import prisma (impossible in the no-install guards job) or to grep this file's source for the right words
// (which proves the words are present and nothing about behaviour). This file now supplies the database and nothing else.
import { prisma } from '../db.js';
import { decideCheck } from '../lib/licenceDecision.js';

export default async function licenceCheck({ body, db = prisma }) {
  return decideCheck({ body, db });
}
