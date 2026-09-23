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
#
# The panel's PLACEMENT is asserted here, not just its existence. A panel that
# renders correctly but sits off the bottom of the screen is the bug this section
# was written after: the toggle looked dead because its panel opened past the
# fold. The viewport is set explicitly (page.setViewportSize, not a window
# resize) so the short-viewport case is the same on every machine.
echo
echo "public/plugin.js on the site's own page (the floating dock):"
MOCK_WP_URL="http://localhost:${DOCK_RIG_MOCK_WP_PORT:-4600}"

PANEL_OPEN_JS="(()=>{const h=document.querySelector('[data-morpheus-dock]');const p=h&&h.shadowRoot&&h.shadowRoot.querySelector('.panel');return !!(p&&p.classList.contains('open'))})()"
# The whole question: with the panel open, is every edge of it on screen?
PANEL_INSIDE_JS="(()=>{const h=document.querySelector('[data-morpheus-dock]');const p=h&&h.shadowRoot&&h.shadowRoot.querySelector('.panel');if(!p||!p.classList.contains('open'))return false;const r=p.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth})()"
PANEL_GEOM_JS="(()=>{const h=document.querySelector('[data-morpheus-dock]');const p=h&&h.shadowRoot&&h.shadowRoot.querySelector('.panel');if(!p)return 'no panel';const r=p.getBoundingClientRect();return 'box '+Math.round(r.left)+','+Math.round(r.top)+' '+Math.round(r.right)+','+Math.round(r.bottom)+' of '+innerWidth+'x'+innerHeight+' size '+Math.round(r.width)+'x'+Math.round(r.height)+' flipV='+p.classList.contains('flip-v')+' flipH='+p.classList.contains('flip-h')+' open='+p.classList.contains('open')})()"
TOGGLE_POS_JS="(()=>{const r=document.querySelector('[data-morpheus-dock]').getBoundingClientRect();return Math.round(r.left)+','+Math.round(r.top)})()"

viewport() { pwr run-code "async page => { await page.setViewportSize({ width: $1, height: $2 }); }" >/dev/null; }
clear_saved_pos() { scripts/pw localstorage-delete morpheus_dock_pos_v1 >/dev/null 2>&1; }
save_pos() { ev "(()=>{localStorage.setItem('morpheus_dock_pos_v1',JSON.stringify({left:$1,top:$2}));return 'set'})()" >/dev/null; }
open_dock() { # url
  pwr goto "$1" >/dev/null
  sleep 2
  pw click "getByRole('button', { name: 'Open or drag Morpheus' })" >/dev/null 2>&1
  sleep 1
}
check_panel_inside() { # label
  if [ "$(ev "$PANEL_INSIDE_JS")" = "true" ]; then
    echo "  ok    $1"
  else
    echo "  FAIL  $1 — panel is not fully in the viewport: $(ev "$PANEL_GEOM_JS")"
    FAILURES=$((FAILURES + 1))
  fi
}

# url width height savedLeft savedTop — a blank left/top means the default
# CSS position (bottom-right, or bottom-left for the ?position= case).
dock_case() {
  local label="$1" url="$2" w="$3" h="$4" sl="${5:-}" st="${6:-}"
  viewport "$w" "$h"
  clear_saved_pos
  [ -n "$sl" ] && save_pos "$sl" "$st"
  open_dock "$url"
  check_panel_inside "$label"
}

# The origin has to be the host page before its localStorage can be cleared, or
# a position saved by an earlier run leaks into the "default position" cases.
pwr goto "$MOCK_WP_URL/" >/dev/null
sleep 2
check "the loader mounted the floating toggle" \
  "$(ev "!!(document.querySelector('[data-morpheus-dock]')?.shadowRoot?.querySelector('.toggle'))")" "true"

# The default position, at the heights that decide whether this bites.
dock_case "default bottom-right, 720px viewport (the reported height)" "$MOCK_WP_URL/" 1280 720
dock_case "default bottom-right, 800px viewport" "$MOCK_WP_URL/" 1280 800
dock_case "default bottom-right, 900px viewport" "$MOCK_WP_URL/" 1280 900
dock_case "default bottom-right, 1000px viewport" "$MOCK_WP_URL/" 1280 1000
dock_case "narrow 380px-wide viewport (width, not height, is the squeeze)" "$MOCK_WP_URL/" 380 720
dock_case "very short 240px viewport (shrink to the room, do not overflow)" "$MOCK_WP_URL/" 1280 240
# Saved drag positions: localStorage is restored on load, so these are their own
# geometry rather than variations on the default.
dock_case "saved position at the left edge and the bottom" "$MOCK_WP_URL/" 1280 720 6 660
dock_case "saved position mid-height, where neither side fits the full panel" "$MOCK_WP_URL/" 1280 720 600 334
# bottom-left: the flip-h path in the other direction.
dock_case "bottom-left, default position" "$MOCK_WP_URL/?position=bottom-left" 1280 720
dock_case "bottom-left, saved position at the right edge" "$MOCK_WP_URL/?position=bottom-left" 1280 720 1216 660

# ── 5b. the dock still behaves ───────────────────────────────────────────
# Placement is not worth much if the toggle stopped toggling. Click, Escape and
# a real pointer drag, each verified rather than assumed.
echo
echo "Behaviour (the panel must still open, close and drag):"
viewport 1280 720
clear_saved_pos
pwr goto "$MOCK_WP_URL/" >/dev/null
sleep 2
# The toggle opens on pointerup, not on click — a synthetic .click() never opens
# it, so these have to be real Playwright clicks (which pierce the open shadow
# root) rather than page JS.
pw click "getByRole('button', { name: 'Open or drag Morpheus' })" >/dev/null 2>&1
sleep 1
check "clicking the toggle opens the panel" "$(ev "$PANEL_OPEN_JS")" "true"
wait_for "the panel's iframe is the embed, with the page it was opened over" \
  "(()=>{const f=document.querySelector('[data-morpheus-dock]')?.shadowRoot?.querySelector('iframe');return !!f && f.src.includes('/embed?token=') && f.src.includes('pageUrl=')})()"
sleep 2
FOUND="$(pw find --regex "/Dock rig fixture/")"
check "the embed really rendered inside the iframe" "$(echo "$FOUND" | grep -q 'No matches found' && echo no || echo yes)" "yes"
pw screenshot --filename="$SHOTS/dock-rig-pluginjs.png" >/dev/null
echo "  ok    screenshot .playwright/out/dock-rig-pluginjs.png"

pw press Escape >/dev/null 2>&1
sleep 1
check "Escape closes the panel" "$(ev "$PANEL_OPEN_JS")" "false"
pw click "getByRole('button', { name: 'Open or drag Morpheus' })" >/dev/null 2>&1
sleep 1
check "a click reopens it" "$(ev "$PANEL_OPEN_JS")" "true"
check_panel_inside "…and the reopened panel is still fully visible"

BEFORE_POS="$(ev "$TOGGLE_POS_JS")"
pwr run-code "async page => { const t = page.locator('[data-morpheus-dock] .toggle'); const b = await t.boundingBox(); if (!b) return 'no box'; const sx = b.x + b.width / 2, sy = b.y + b.height / 2; await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(sx - 500, sy - 260, { steps: 12 }); await page.mouse.up(); return 'dragged'; }" >/dev/null
sleep 1
AFTER_POS="$(ev "$TOGGLE_POS_JS")"
check "the toggle still drags ($BEFORE_POS -> $AFTER_POS)" "$([ -n "$BEFORE_POS" ] && [ "$BEFORE_POS" != "$AFTER_POS" ] && echo yes || echo no)" "yes"
check "the dragged position is still saved for next time" "$(ev "!!localStorage.getItem('morpheus_dock_pos_v1')")" "true"
check_panel_inside "the panel is fully visible after the drag"
pw click "getByRole('button', { name: 'Open or drag Morpheus' })" >/dev/null 2>&1
sleep 1
check "a click closes it again" "$(ev "$PANEL_OPEN_JS")" "false"

# Resizing with the panel open is a real path (rotate a phone, drag a window) and
# it has its own way to go stale: a height set inline for the old viewport must
# not survive into the new one.
echo
echo "Resize while the panel is open:"
pw click "getByRole('button', { name: 'Open or drag Morpheus' })" >/dev/null 2>&1
sleep 1
viewport 1000 1000
sleep 1
check_panel_inside "growing the viewport keeps it inside"
viewport 1280 600
sleep 1
check_panel_inside "shrinking the viewport re-fits it"
viewport 360 640
sleep 1
check_panel_inside "a phone-sized viewport keeps it inside"

CONSOLE2="$(pw console error)"
check "the host page console has no errors" "$(echo "$CONSOLE2" | grep -o 'Errors: [0-9]*' | head -1)" "Errors: 0"

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
