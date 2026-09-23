/*!
 * Morpheus embeddable widget loader.
 *
 *   <script src="https://morpheus.nz/plugin.js" data-token="wgt_..."></script>
 *
 * Two modes, both pointed at <origin>/embed?token=…:
 *
 *   Inline (default) — drops an <iframe> where the tag sits and auto-sizes
 *   it to its content. Good for putting the panel on one page.
 *   Optional attributes: data-height (initial px, default 640),
 *   data-min-height, data-radius (px, default 12).
 *
 *   Floating dock — data-dock="1" instead renders a small toggle button
 *   fixed in a screen corner; clicking it opens the panel over the page.
 *   Meant for a site-wide, admin-only embed, so the tag must be produced
 *   server-side and only for a logged-in admin — otherwise the token is
 *   handed to an ordinary visitor's browser. The Morpheus WordPress plugin
 *   (includes/class-dock.php, 0.8+) prints it that way; a site without the
 *   plugin can print the same tag from a PHP snippet gated to admins.
 *   Only one dock mounts however many copies of the tag are present.
 *   Built in a shadow root so the host page's CSS can't bleed in or out.
 *   Optional attributes: data-position ("bottom-right" default, or
 *   "bottom-left"), data-panel-width (px, default 380), data-panel-height
 *   (px, default 600).
 */
(function () {
  var script = document.currentScript;
  if (!script) {
    var all = document.getElementsByTagName('script');
    script = all[all.length - 1];
  }
  var token = script.getAttribute('data-token');
  if (!token) {
    console.error('[morpheus] <script> is missing data-token');
    return;
  }

  var origin;
  try { origin = new URL(script.src, window.location.href).origin; }
  catch (e) { origin = 'https://morpheus.nz'; }

  // The page this script is running on — passed through so CHAT can ground
  // its answers in what the operator is actually looking at (the parent
  // page's URL isn't otherwise readable from inside the iframe; it's a
  // different origin). Best-effort: never blocks the embed if unavailable.
  var pageUrl = '', pageTitle = '';
  try { pageUrl = window.location.href; } catch (e) { /* ignore */ }
  try { pageTitle = document.title || ''; } catch (e) { /* ignore */ }

  var embedSrc = origin + '/embed?token=' + encodeURIComponent(token) +
    (pageUrl ? '&pageUrl=' + encodeURIComponent(pageUrl) : '') +
    (pageTitle ? '&pageTitle=' + encodeURIComponent(pageTitle) : '');
  var isDock = script.getAttribute('data-dock') === '1';

  // The dock can legitimately arrive twice: the Morpheus WordPress plugin
  // prints it (0.8+), and a site that had the <script> pasted into its theme by
  // hand still carries that copy. Two copies would mean two floating buttons
  // fighting over the same corner, so the first to run wins and the rest stop
  // here. Per lock, not global: an inline embed on a page is unaffected.
  if (isDock) {
    if (window.__morpheusDockMounted) return;
    window.__morpheusDockMounted = true;
  }

  if (isDock) {
    if (document.body) mountDock();
    else document.addEventListener('DOMContentLoaded', mountDock);
  } else {
    mountInline();
  }

  // ── inline: one iframe, sized to its own content ─────────────────────────
  function mountInline() {
    var initialHeight = parseInt(script.getAttribute('data-height'), 10) || 640;
    var minHeight = parseInt(script.getAttribute('data-min-height'), 10) || 360;
    var radius = script.getAttribute('data-radius');
    radius = radius == null ? 12 : parseInt(radius, 10) || 0;

    var frame = document.createElement('iframe');
    frame.src = embedSrc;
    frame.title = 'Morpheus';
    frame.loading = 'lazy';
    frame.setAttribute('allow', 'clipboard-write');
    frame.style.cssText = [
      'width:100%',
      'border:0',
      'display:block',
      'height:' + initialHeight + 'px',
      'min-height:' + minHeight + 'px',
      'border-radius:' + radius + 'px',
      'background:transparent',
      'color-scheme:light dark'
    ].join(';');

    // Insert where the script tag is.
    if (script.parentNode) {
      script.parentNode.insertBefore(frame, script.nextSibling);
    } else {
      document.body.appendChild(frame);
    }

    // The surface reports its content height so the iframe never scrolls
    // internally. Only trust messages from our own origin + this frame.
    window.addEventListener('message', function (ev) {
      if (ev.origin !== origin || ev.source !== frame.contentWindow) return;
      var data = ev.data || {};
      if (data.type === 'morpheus:resize' && typeof data.height === 'number') {
        frame.style.height = Math.max(minHeight, Math.ceil(data.height)) + 'px';
      }
    });
  }

  // ── dock: a floating toggle + panel, isolated in a shadow root ──────────
  // The toggle is drag-to-reposition (pointer events cover mouse + touch):
  // a short, low-movement press still opens/closes the panel as a click;
  // anything past DRAG_THRESHOLD is a drag instead, moving the whole dock
  // — panel included, even while it's open — so an operator can slide it
  // out of the way of whatever it's covering instead of closing it (the
  // iframe survives a close, but re-finding your spot in the panel doesn't
  // feel free, hence "drag" over "close and reopen"). Position persists
  // per-site in localStorage.
  function mountDock() {
    var onLeft = (script.getAttribute('data-position') || '').toLowerCase().indexOf('left') !== -1;
    var panelW = parseInt(script.getAttribute('data-panel-width'), 10) || 380;
    var panelH = parseInt(script.getAttribute('data-panel-height'), 10) || 600;
    var side = onLeft ? 'left' : 'right';
    var otherSide = onLeft ? 'right' : 'left';
    // The gap between the toggle and the panel, and the clearance kept between
    // the panel and the edge of the viewport. PANEL_GAP is used by the
    // stylesheet below AND by reposition(), so it is declared once here.
    var PANEL_GAP = 64;
    var EDGE_MARGIN = 8;
    var POS_KEY = 'morpheus_dock_pos_v1';

    var host = document.createElement('div');
    host.setAttribute('data-morpheus-dock', '');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;bottom:16px;' + side + ':16px;';
    document.body.appendChild(host);

    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

    var style = document.createElement('style');
    style.textContent = [
      ':host{all:initial;}',
      '.wrap{all:initial;position:relative;font-family:"Courier New",monospace;}',
      '.toggle{position:relative;width:52px;height:52px;border-radius:999px;border:1px solid rgba(57,255,20,.45);' +
        'background:#05130a;color:#39ff14;font:600 20px/52px "Courier New",monospace;text-align:center;' +
        'cursor:grab;box-shadow:0 6px 20px rgba(0,0,0,.4);user-select:none;transition:background .15s;touch-action:none;}',
      '.toggle:hover{background:#0a1f12;}',
      '.toggle:active{cursor:grabbing;}',
      '.panel{position:absolute;bottom:' + PANEL_GAP + 'px;' + side + ':0;width:min(' + panelW + 'px,94vw);' +
        'height:min(' + panelH + 'px,80vh);border-radius:14px;overflow:hidden;' +
        'border:1px solid rgba(57,255,20,.35);box-shadow:0 16px 48px rgba(0,0,0,.5);' +
        'background:#05130a;display:none;}',
      '.panel.open{display:block;}',
      '.panel.flip-v{bottom:auto;top:' + PANEL_GAP + 'px;}',
      '.panel.flip-h{' + side + ':auto;' + otherSide + ':0;}',
      '.panel iframe{width:100%;height:100%;border:0;display:block;}',
      '.close{position:absolute;top:6px;' + side + ':8px;z-index:1;width:22px;height:22px;border-radius:999px;' +
        'background:rgba(0,0,0,.5);color:#9be89b;font:600 13px/22px sans-serif;text-align:center;cursor:pointer;}',
      '.close:hover{background:rgba(0,0,0,.75);}'
    ].join('\n');

    var wrap = document.createElement('div');
    wrap.className = 'wrap';

    var panel = document.createElement('div');
    panel.className = 'panel';

    var closeBtn = document.createElement('div');
    closeBtn.className = 'close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('role', 'button');
    closeBtn.setAttribute('aria-label', 'Close Morpheus');

    var toggle = document.createElement('div');
    toggle.className = 'toggle';
    toggle.textContent = 'M';
    toggle.setAttribute('role', 'button');
    toggle.setAttribute('aria-label', 'Open or drag Morpheus');

    var frame = null;
    var open = false;
    function ensureFrame() {
      if (frame) return;
      frame = document.createElement('iframe');
      frame.src = embedSrc;
      frame.title = 'Morpheus';
      frame.loading = 'lazy';
      frame.setAttribute('allow', 'clipboard-write');
      panel.appendChild(frame);
    }

    // Put the panel on whichever side of the toggle has more room, and never
    // let it be larger than the room it chose. A panel that hangs past the edge
    // of the screen is one whose controls cannot be reached, which reads to the
    // operator as "the button did nothing" — the exact failure this replaced.
    //
    // The size asked for is the size the stylesheet will actually give the
    // panel: width min(panelW, 94vw), height min(panelH, 80vh). Using the raw
    // data-panel-height instead is what used to send it off the bottom of a
    // short viewport: at 720px a 600px panel is really 576, and the toggle sits
    // closer to the top than 600 + the gap, so the old test said "flip down"
    // into a space that did not exist.
    function reposition() {
      var r = host.getBoundingClientRect();
      var vw = window.innerWidth;
      var vh = window.innerHeight;
      var wantW = Math.min(panelW, Math.round(vw * 0.94));
      var wantH = Math.min(panelH, Math.round(vh * 0.8));

      // How much room each side of the toggle really has, measured from the
      // edge the panel would sit against, less a clearance so it never touches
      // the viewport edge.
      var roomAbove = r.bottom - PANEL_GAP - EDGE_MARGIN;
      var roomBelow = vh - r.top - PANEL_GAP - EDGE_MARGIN;
      var roomLeft = r.right - EDGE_MARGIN;
      var roomRight = vw - r.left - EDGE_MARGIN;

      // Unflipped, the panel hangs above the toggle and extends towards the
      // middle of the screen from its own side; flip-v / flip-h put it on the
      // other side. Prefer the roomier side, whichever way the dock was dragged.
      var flipV = roomBelow > roomAbove;
      var naturalH = onLeft ? roomRight : roomLeft;
      var otherH = onLeft ? roomLeft : roomRight;
      var flipH = otherH > naturalH;
      panel.classList.toggle('flip-v', flipV);
      panel.classList.toggle('flip-h', flipH);

      // Then shrink to fit when even the roomier side is too small. Cleared
      // rather than set when the stylesheet's own size fits, so the normal size
      // stays defined in exactly one place.
      var roomV = Math.max(0, flipV ? roomBelow : roomAbove);
      var roomH = Math.max(0, flipH ? otherH : naturalH);
      panel.style.height = wantH > roomV ? roomV + 'px' : '';
      panel.style.width = wantW > roomH ? roomH + 'px' : '';
    }

    function setOpen(next) {
      open = next;
      if (open) { ensureFrame(); reposition(); panel.classList.add('open'); }
      else { panel.classList.remove('open'); }
    }

    // ── drag-to-reposition ──────────────────────────────────────────────
    var DRAG_THRESHOLD = 6;
    var dragging = false, moved = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;

    function clampPos(left, top) {
      var w = host.offsetWidth || 52, h = host.offsetHeight || 52;
      var maxLeft = Math.max(4, window.innerWidth - w - 4);
      var maxTop = Math.max(4, window.innerHeight - h - 4);
      return [Math.min(Math.max(4, left), maxLeft), Math.min(Math.max(4, top), maxTop)];
    }
    function applyPos(left, top) {
      host.style.left = left + 'px';
      host.style.top = top + 'px';
      host.style.right = '';
      host.style.bottom = '';
    }
    function savePos(left, top) {
      try { localStorage.setItem(POS_KEY, JSON.stringify({ left: left, top: top })); } catch (e) { /* private mode etc — position just won't persist */ }
    }
    function restorePos() {
      var saved = null;
      try { saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (e) { /* ignore */ }
      if (!saved || typeof saved.left !== 'number' || typeof saved.top !== 'number') return;
      var c = clampPos(saved.left, saved.top);
      applyPos(c[0], c[1]);
    }

    toggle.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      dragging = true; moved = false;
      var r = host.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY; startLeft = r.left; startTop = r.top;
      if (toggle.setPointerCapture) { try { toggle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
    });
    toggle.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX, dy = e.clientY - startY;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      moved = true;
      var c = clampPos(startLeft + dx, startTop + dy);
      applyPos(c[0], c[1]);
      if (open) reposition();
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      if (moved) {
        var r = host.getBoundingClientRect();
        savePos(r.left, r.top);
      } else {
        setOpen(!open);
      }
    }
    toggle.addEventListener('pointerup', endDrag);
    toggle.addEventListener('pointercancel', function () { dragging = false; });

    closeBtn.addEventListener('click', function (e) { e.stopPropagation(); setOpen(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && open) setOpen(false); });
    window.addEventListener('resize', function () {
      if (host.style.left) {
        var r = host.getBoundingClientRect();
        var c = clampPos(r.left, r.top);
        applyPos(c[0], c[1]);
      }
      if (open) reposition();
    });

    panel.appendChild(closeBtn);
    wrap.appendChild(panel);
    wrap.appendChild(toggle);
    root.appendChild(style);
    root.appendChild(wrap);

    restorePos();
  }
})();
