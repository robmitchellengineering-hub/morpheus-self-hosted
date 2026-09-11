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
 *   Meant for a site-wide, admin-only embed (gate the <script> tag itself
 *   server-side — e.g. a PHP snippet that only prints it for a logged-in
 *   admin — so the token is never sent to an ordinary visitor's browser).
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

  var embedSrc = origin + '/embed?token=' + encodeURIComponent(token);
  var isDock = script.getAttribute('data-dock') === '1';

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
  function mountDock() {
    var onLeft = (script.getAttribute('data-position') || '').toLowerCase().indexOf('left') !== -1;
    var panelW = parseInt(script.getAttribute('data-panel-width'), 10) || 380;
    var panelH = parseInt(script.getAttribute('data-panel-height'), 10) || 600;
    var side = onLeft ? 'left' : 'right';

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
        'cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.4);user-select:none;transition:background .15s;}',
      '.toggle:hover{background:#0a1f12;}',
      '.panel{position:absolute;bottom:64px;' + side + ':0;width:min(' + panelW + 'px,94vw);' +
        'height:min(' + panelH + 'px,80vh);border-radius:14px;overflow:hidden;' +
        'border:1px solid rgba(57,255,20,.35);box-shadow:0 16px 48px rgba(0,0,0,.5);' +
        'background:#05130a;display:none;}',
      '.panel.open{display:block;}',
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
    toggle.setAttribute('aria-label', 'Open Morpheus');

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
    function setOpen(next) {
      open = next;
      if (open) ensureFrame();
      if (open) { panel.classList.add('open'); } else { panel.classList.remove('open'); }
    }

    toggle.addEventListener('click', function () { setOpen(!open); });
    closeBtn.addEventListener('click', function (e) { e.stopPropagation(); setOpen(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && open) setOpen(false); });

    panel.appendChild(closeBtn);
    wrap.appendChild(panel);
    wrap.appendChild(toggle);
    root.appendChild(style);
    root.appendChild(wrap);
  }
})();
