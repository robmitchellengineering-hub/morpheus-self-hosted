/*!
 * Morpheus embeddable widget loader.
 *
 *   <script src="https://morpheus.nz/plugin.js" data-token="wgt_..."></script>
 *
 * Drops an <iframe> where the tag sits, pointed at <origin>/embed, and
 * auto-sizes it to its content. The token scopes the surface to one
 * project + a fixed set of actions (see server/src/lib/widgetToken.js).
 * Optional attributes: data-height (initial px, default 640),
 * data-min-height, data-radius (px, default 12).
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

  var initialHeight = parseInt(script.getAttribute('data-height'), 10) || 640;
  var minHeight = parseInt(script.getAttribute('data-min-height'), 10) || 360;
  var radius = script.getAttribute('data-radius');
  radius = radius == null ? 12 : parseInt(radius, 10) || 0;

  var frame = document.createElement('iframe');
  frame.src = origin + '/embed?token=' + encodeURIComponent(token);
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
})();
