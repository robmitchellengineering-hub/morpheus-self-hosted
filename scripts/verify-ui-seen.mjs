#!/usr/bin/env node
// verify-ui-seen.mjs — make "I looked at it" a command with an exit code (G-08).
//
// WHY. The standing SOP says a UI change is verified by LOOKING at the rendered result, not by a passing
// build. Until now that meant an agent claiming it had looked, which is unverifiable — the same class as
// "tested" without a test. The deployment can now see: `operatorVision` (PR #699) hands an image to the
// Gemini key morpheus.nz already runs on and returns structured JSON about the pixels.
//
// So this asks a question with a checkable answer, and fails when the answer is "no":
//   - is the expected heading actually present?
//   - are the expected controls present (by name)?
//   - is anything visibly clipped, overlapping or off-screen?
//   - does it report the layout it can see, so a human can sanity-check the reading?
//
// WHAT IT CANNOT DO: judge taste. It answers "is this rendered as intended", not "is this good design".
// A model that says "looks fine" about a blank page is caught by the heading/control assertions; a model
// that likes an ugly page is not something a gate can rule on.
//
//   node scripts/verify-ui-seen.mjs --image shot.png \
//        --expect "Licences" --expect-button "Revoke" --prompt-extra "is the plan name visible"
//
// The image must be reachable by the deployment, so it is uploaded as a data-free reference: this posts
// the file to a short-lived URL only if MORPHEUS_UPLOAD_URL is set; otherwise pass --url <https url>.
//
// exit 0 the page shows what was expected · 1 it does not (naming what is missing) · 2 could not check.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const ENV_FILE = process.env.MORPHEUS_OPS_ENV || join(REPO, "server", ".env.morpheusops");

function readEnv() {
  const out = {};
  if (!existsSync(ENV_FILE)) return out;
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.lastIndexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const all = (n) => argv.reduce((acc, a, i) => (a === `--${n}` && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);

const url = flag("url");
const image = flag("image");
const expects = all("expect");
const buttons = all("expect-button");
const extra = flag("prompt-extra", "");

if (!url) {
  console.error("CANNOT-CHECK — pass --url <https url of the rendered screenshot>.");
  console.error("This tool needs the image to be reachable by the deployment; it does not upload files.");
  if (image) console.error(`(--image ${image} was given but nothing serves it over https yet.)`);
  process.exit(2);
}
if (expects.length === 0 && buttons.length === 0 && !extra) {
  console.error('CANNOT-CHECK — nothing to assert. Give at least one --expect "<text>" so this can fail.');
  process.exit(2);
}

const env = readEnv();
const TOKEN = env.MORPHEUS_OPERATOR_TOKEN || process.env.MORPHEUS_OPERATOR_TOKEN;
const BASE = String(env.MORPHEUS_API_BASE || process.env.MORPHEUS_API_BASE || "https://api.morpheus.nz/api").replace(/\/+$/, "");
if (!TOKEN) {
  console.error(`CANNOT-CHECK — no operator token in ${ENV_FILE}`);
  process.exit(2);
}

const prompt = [
  'You are looking at a screenshot of a web page. Answer ONLY from what is visible.',
  'FIRST describe it: put the main heading in "heading", and list EVERY piece of visible text verbatim in',
  '"visible_texts" and EVERY button, link or control in "controls". Do that even if nothing else is asked.',
  'Return JSON: {"heading": string, "visible_texts": string[], "controls": string[], "clipped_or_overlapping": boolean, "problems": string[]}',
  expects.length ? `The following should be present somewhere on the page: ${expects.map((e) => JSON.stringify(e)).join(", ")}.` : "",
  buttons.length ? `The following interactive controls (buttons/links) should be present: ${buttons.map((b) => JSON.stringify(b)).join(", ")}.` : "",
  extra || "",
  'In "problems", list anything visibly broken: overlapping text, a control cut off at an edge, text clipped mid-word, an element overflowing its box. If nothing is wrong, return an empty array.',
].filter(Boolean).join(" ");

const res = await fetch(`${BASE}/functions/operatorVision`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ prompt, imageUrls: [url] }),
});
const text = await res.text();
if (!res.ok) {
  let msg = text.slice(0, 300);
  try { msg = JSON.parse(text).error || msg; } catch { /* raw */ }
  console.error(`CANNOT-CHECK — operatorVision returned HTTP ${res.status}: ${msg}`);
  process.exit(2);
}

let body;
try {
  body = JSON.parse(text);
} catch {
  console.error("CANNOT-CHECK — the vision call did not return JSON.");
  process.exit(2);
}
// The model's SHAPE is not the contract. A short prompt returns {"heading":…,"visible_texts":[…]}; a
// longer one can return a detection array or omit those keys — measured, twice. So the assertion matches
// against the whole answer AND the whole response, and the shape is reported rather than trusted.
let answer = body.answer ?? {};
if (Array.isArray(answer)) answer = answer[0] ?? {};
const visible = `${JSON.stringify(body.answer ?? "")} ${JSON.stringify(body)}`.toLowerCase();
const missing = expects.filter((e) => !visible.includes(String(e).toLowerCase()));
const missingButtons = buttons.filter((b) => !visible.includes(String(b).toLowerCase()));
const problems = Array.isArray(answer.problems) ? answer.problems : [];
const clipped = answer.clipped_or_overlapping === true;

console.log(`\nUI seen — ${url}\n`);
console.log(`  shape   : ${Array.isArray(body.answer) ? "array" : "object"}`);
console.log(`  heading : ${answer.heading || "(not reported)"}`);
console.log(`  saw     : ${(answer.visible_texts || []).slice(0, 6).join(" · ") || "(nothing listed)"}`);
console.log(`  controls: ${(answer.controls || []).join(" · ") || "(none listed)"}`);

// An observation with nothing in it is not evidence. The first version of this tool reported "missing X"
// against a model that had simply returned no description at all — a failure that looked like the page's
// fault. Say what it actually is.
const observed = Boolean(answer.heading) || (Array.isArray(answer.visible_texts) && answer.visible_texts.length > 0) || (Array.isArray(answer.controls) && answer.controls.length > 0);
if (!observed) {
  console.error('CANNOT-CHECK — the model returned no observation (no heading, no visible text, no controls).');
  console.error('That says nothing about the page. Check the image URL is reachable by the deployment: a');
  console.error('private or tailnet address returns a 200 with nothing to look at.');
  process.exit(2);
}
let bad = 0;
for (const m of missing) { bad++; console.log(`  MISSING "${m}" — not visible on the page`); }
for (const m of missingButtons) { bad++; console.log(`  MISSING control "${m}"`); }
if (clipped) { bad++; console.log("  CLIPPED — something is overlapping or cut off"); }
for (const p of problems) { bad++; console.log(`  PROBLEM ${p}`); }

if (bad > 0) {
  console.error(`\nui-seen: ${bad} problem(s). "It builds" is not "it looks right".`);
  process.exit(1);
}
console.log("\nui-seen: the page shows what was expected, and nothing looked broken\n");
