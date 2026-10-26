#!/usr/bin/env node
// verify-licence-issuance.mjs — the issuer's half, proven against ITS OWN key.
//
// The trap this exists to avoid: a test that mints with a test key and verifies against the SHIPPED
// public key passes only when the two happen to be the same, and fails in production where they are
// not. So every case here generates a fresh pair, signs with the private half and verifies with THAT
// pair's public half — and one case asserts that the shipped key does NOT accept it, which is what
// makes the first assertions mean something.
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { buildClaims, signLicence, PLANS } from "../server/src/lib/licenceKey.js";

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` (got ${JSON.stringify(actual)})`}`);
};

const b64 = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
function decode(licence) {
  const [pre, payload, sig] = licence.split(".");
  return { pre, payload, sig, claims: JSON.parse(b64(payload).toString("utf8")), sigBuf: b64(sig) };
}
function verifiesWith(licence, publicKey) {
  const { payload, sigBuf } = decode(licence);
  return cryptoVerify(null, b64(payload), publicKey, sigBuf);
}

console.log("\nlicence issuance — the issuer's half\n");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const pub = publicKey; // already a KeyObject; verify() takes it directly

const claims = buildClaims({ accountId: "acct_test_001", plan: "team", seats: 3, days: 30 });
check("claims carry the SDK's version", claims.v, 1);
check("plan and seats survive", `${claims.plan}/${claims.seats}`, "team/3");
check("expiry is now + days", Math.round((claims.exp - claims.iat) / 86400), 30);
check("jti is unique per call", buildClaims({ accountId: "a", plan: "solo", days: 1 }).jti === claims.jti, false);

const token = signLicence(claims, pem);
const decoded = decode(token);
check("token has the vvs1 shape", decoded.pre, "vvs1");
check("the claims round-trip", decoded.claims.jti, claims.jti);
check("IT VERIFIES WITH ITS OWN KEY", verifiesWith(token, pub), true);
check("…and NOT with a different key", verifiesWith(token, generateKeyPairSync("ed25519").publicKey), false);

// A tampered payload must stop verifying — the whole point of the signature.
const edited = decoded.claims; edited.seats = 999;
const forged = `vvs1.${Buffer.from(JSON.stringify(edited)).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")}.${decoded.sig}`;
check("editing the seats breaks the signature", verifiesWith(forged, pub), false);

// Absent key is a refusal, never a fallback.
let refused = false;
try { signLicence(claims, ""); } catch (e) { refused = e.status === 503; }
check("no key -> refuse with 503, not a throwaway key", refused, true);

// Bad input is rejected before signing.
for (const [name, args] of [["unknown plan", { accountId: "a", plan: "enterprise", days: 1 }], ["no account", { plan: "solo", days: 1 }], ["zero days", { accountId: "a", plan: "solo", days: 0 }]]) {
  let threw = false;
  try { buildClaims(args); } catch { threw = true; }
  check(`rejects: ${name}`, threw, true);
}

console.log(failures === 0 ? "\nlicence issuance: every case behaves\n" : `\nlicence issuance: ${failures} case(s) wrong\n`);
process.exit(failures === 0 ? 0 : 1);
