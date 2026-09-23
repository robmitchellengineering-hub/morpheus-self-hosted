#!/usr/bin/env bash
#
# Drive the Morpheus DOCK in a real browser.
#
# The dock is public/plugin.js → /embed?token=… → src/pages/Embed.jsx, scoped by
# a widget token. This script is the browser half of the rig started by
# scripts/dev-dock-rig.mjs: it opens the real surface, clicks real tabs, and
# fails loudly if what the guard scripts assert by reading source is not what the
# page actually does.
#
# Every check below is an OBSERVATION, not a restatement:
#   * the tab set is read out of the live DOM;
#   * the scoping claim is made twice — a full token must show seven tabs and a
#     chat-only token must show none of the other six;
#   * HEALTH must produce a headline, AND the mock WordPress' own log must gain a
#     signed POST /health — so a render that never reached the backend fails;
#   * CHAT must round-trip a message through the mock model and render its reply;
#   * the console must be error-free at the end.
#
# Run:  node scripts/dev-dock-rig.mjs up && node scripts/dev-dock-rig.mjs drive
# or:   scripts/dock-rig-drive.sh
#
# Tokens are read from server/data/dock-rig/state.json (gitignored) and are
# redacted out of this script's own output.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

RIG="server/data/dock-rig"
WP_LOG="$RIG/mock-wp.log"
SHOTS=".playwright/out"

redact() { sed -E 's/wgt_[0-9a-f]{16,}/wgt_<redacted>/g'; }
pw()  { scripts/pw "$@" 2>&1 | redact; }
pwr() { scripts/pw --raw "$@" 2>&1 | redact; }
ev()  { pwr eval "$1" | tr -d '\n' | sed -E 's/^"(.*)"$/\1/'; }

FAILURES=0
check() { # label, actual, expected
  if [ "$2" = "$3" ]; then echo "  ok    $1"; else echo "  FAIL  $1 — expected [$3], got [$2]"; FAILURES=$((FAILURES + 1)); fi
}

wait_for() { # label, js-expression that returns true when ready
  local label="$1" expr="$2" i
  for i in $(seq 1 30); do
    [ "$(ev "$expr")" = "true" ] && { echo "  ok    $label"; return 0; }
    sleep 1
  done
  echo "  FAIL  $label — never became true within 30s"
  FAILURES=$((FAILURES + 1))
  return 1
}

TABS_JS="['CHAT','DEPLOY','HEALTH','SHOP','PAGES','SEO','TRAFFIC'].filter(t=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===t)).join('|')"
health_posts() { local n; n="$(grep -c 'POST /health' "$WP_LOG" 2>/dev/null)"; echo "${n:-0}"; }

if [ ! -f "$RIG/state.json" ]; then
  echo "  ✗ no rig state — run: node scripts/dev-dock-rig.mjs up" >&2
  exit 1
fi
FULL_URL="$(node scripts/dev-dock-rig.mjs url full)"
CHAT_URL="$(node scripts/dev-dock-rig.mjs url chat-only)"
mkdir -p "$SHOTS"

echo
echo "Dock rig — driving the dock in a real browser"
echo

# ── 1. the full-scope token: every tab the token is scoped for ─────────────
pw open "$FULL_URL" >/dev/null
sleep 2
echo "Tab set, full token (chat,deploy,store,seo,traffic):"
check "all seven tabs render" "$(ev "$TABS_JS")" 'CHAT|DEPLOY|HEALTH|SHOP|PAGES|SEO|TRAFFIC'
check "the widget names its project" "$(ev "document.body.innerText.includes('Dock rig fixture')")" "true"

# ── 2. HEALTH: a real scan, and a real signed round trip ──────────────────
# Counts are taken as deltas, never as absolutes: the mock's log persists across
# runs and the chat transcript is stored in the database, so "the string is on
# the page" is true before this run does anything. A check that would pass with
# the tab unclicked is worse than no check (H17's shape).
echo
echo "HEALTH tab (a widget token calling siteHealth → signed POST to the site):"
BASE="$(health_posts)"
check "HEALTH is clickable" \
  "$(ev "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='HEALTH');if(!b)return false;b.click();return true})()")" "true"
wait_for "the scan reports a headline" "document.body.innerText.includes('Site health') && /([Nn]othing critical|[Ee]very check passed|needs? fixing)/.test(document.body.innerText)"
wait_for "the scan reached the site (a new signed POST /health)" "$(health_posts) > ${BASE:-0}"
check "wordPress version reached the panel" "$(ev "document.body.innerText.includes('WP 6.7.1')")" "true"
check "the site's own finding reached the panel" "$(ev "document.body.innerText.includes('Debug mode')")" "true"

echo
echo "RESCAN (a click inside the tab, not just a render):"
BEFORE="$(health_posts)"
ev "(()=>{const b=[...document.querySelectorAll('button')].find(x=>/RESCAN/.test(x.textContent));if(!b)return false;b.click();return true})()" >/dev/null
wait_for "RESCAN made a second signed round trip" "$(health_posts) > ${BEFORE:-0}"

# ── 3. CHAT: a message in, a reply out ────────────────────────────────────
echo
echo "CHAT tab (a widget token calling chatWithMorpheus → the mock model):"
REPLIES="(document.body.innerText.match(/dock-rig mock-ai/g)||[]).length"
BEFORE_REPLIES="$(ev "$REPLIES")"
MESSAGE="Drive check $(date +%H%M%S): is the send path live?"
ev "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='CHAT');if(!b)return false;b.click();return true})()" >/dev/null
sleep 1
pw fill "getByRole('textbox')" "$MESSAGE" --submit >/dev/null
wait_for "a NEW reply came back through the dock" "$REPLIES > ${BEFORE_REPLIES:-0}"
check "the operator's own message is shown" "$(ev "document.body.innerText.includes('${MESSAGE%%:*}')")" "true"

# ── 4. the console must be clean ─────────────────────────────────────────
echo
echo "Console:"
CONSOLE="$(pw console error)"
check "no console errors" "$(echo "$CONSOLE" | grep -o 'Errors: [0-9]*' | head -1)" "Errors: 0"

pw screenshot --filename="$SHOTS/dock-rig-full.png" >/dev/null
echo "  ok    screenshot .playwright/out/dock-rig-full.png"

# ── 5. public/plugin.js itself, on a host page ───────────────────────────
# The embed URL above is what a person would otherwise paste. This is the thing
# that actually puts it on the operator's site: the tag the WordPress plugin
# prints, the shadow-root toggle, and the iframe the loader creates. The mock
# WordPress serves a front page carrying that exact tag.
echo
echo "public/plugin.js on the site's own page (the floating dock):"
MOCK_WP_URL="http://localhost:${DOCK_RIG_MOCK_WP_PORT:-4600}"
pwr goto "$MOCK_WP_URL/" >/dev/null
sleep 2
check "the loader mounted the floating toggle" \
  "$(ev "!!(document.querySelector('[data-morpheus-dock]')?.shadowRoot?.querySelector('.toggle'))")" "true"
# The toggle opens on pointerup, not on click — a synthetic .click() never opens
# it, so this has to be a real Playwright click (which pierces the open shadow
# root) rather than page JS.
pw click "getByRole('button', { name: 'Open or drag Morpheus' })" >/dev/null 2>&1 \
  && OPENED=yes || OPENED=no
check "clicking the toggle opens the panel" "$OPENED" "yes"
wait_for "the panel's iframe is the embed, with the page it was opened over" \
  "(()=>{const f=document.querySelector('[data-morpheus-dock]')?.shadowRoot?.querySelector('iframe');return !!f && f.src.includes('/embed?token=') && f.src.includes('pageUrl=')})()"
sleep 2
FOUND="$(pw find --regex "/Dock rig fixture/")"
check "the embed really rendered inside the iframe" "$(echo "$FOUND" | grep -q 'No matches found' && echo no || echo yes)" "yes"
CONSOLE2="$(pw console error)"
check "the host page console has no errors" "$(echo "$CONSOLE2" | grep -o 'Errors: [0-9]*' | head -1)" "Errors: 0"
pw screenshot --filename="$SHOTS/dock-rig-pluginjs.png" >/dev/null
echo "  ok    screenshot .playwright/out/dock-rig-pluginjs.png"

# Reported, NOT asserted. This rig already found a real defect here: in the
# default bottom-right position the panel's flip decision pushes it below the
# fold on a 720px-tall viewport (measured: panel top 726 / bottom 1304 in a
# 720px viewport, while removing `flip-v` puts it at top 74 / bottom 652). It is
# printed on every run so the next person sees it, but the rig's own pass/fail is
# about the rig, not about a source bug it is not here to fix.
GEOMETRY="$(ev "(()=>{const h=document.querySelector('[data-morpheus-dock]');const p=h.shadowRoot?.querySelector('.panel');if(!p)return 'no panel';const r=p.getBoundingClientRect();return 'top '+Math.round(r.top)+' bottom '+Math.round(r.bottom)+' of '+innerHeight+', flip-v='+p.classList.contains('flip-v')+', fully visible: '+(r.top>=0&&r.bottom<=innerHeight)})()")"
echo "  note  floating panel geometry: $GEOMETRY"

# ── 6. a narrowed token really is narrowed ───────────────────────────────
echo
echo "Scoping (chat-only token):"
pwr goto "$CHAT_URL" >/dev/null
sleep 3
check "none of the other six tabs render" "$(ev "$TABS_JS")" ''
check "the chat surface still renders" "$(ev "!!document.querySelector('textarea, input[type=text]')")" "true"
pw screenshot --filename="$SHOTS/dock-rig-chat-only.png" >/dev/null
echo "  ok    screenshot .playwright/out/dock-rig-chat-only.png"

pw close >/dev/null

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "  ✓ dock rig: every browser check passed"
  exit 0
fi
echo "  ✗ dock rig: $FAILURES browser check(s) failed"
exit 1
