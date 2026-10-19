// Builds a self-contained HTML document from project files for live preview in an iframe.
// Handles: static HTML/CSS/JS sites (inlined) and React apps (in-browser Babel transpilation).

function normalizePath(p) {
  return p.replace(/^\.\//, '').replace(/^\//, '');
}

function safeParse(json) {
  try { return JSON.parse(json); } catch { return null; }
}

function isExternal(url) {
  return /^https?:\/\//i.test(url) || url.startsWith('//') || url.startsWith('data:') || url.startsWith('blob:');
}

function lookupFile(fileMap, ref, fromPath) {
  const dir = fromPath && fromPath.includes('/') ? fromPath.substring(0, fromPath.lastIndexOf('/')) : '';
  const parts = (dir + '/' + ref).split('/').filter(p => p !== '');
  const resolved = [];
  for (const p of parts) {
    if (p === '..') resolved.pop();
    else if (p !== '.') resolved.push(p);
  }
  const base = resolved.join('/');
  const tries = [
    base,
    base + '.js', base + '.jsx', base + '.ts', base + '.tsx', base + '.mjs', base + '.cjs',
    base + '.css', base + '.html',
    base + '/index.js', base + '/index.jsx', base + '/index.ts', base + '/index.tsx',
    base + '/index.html'
  ];
  for (const t of tries) {
    if (fileMap[normalizePath(t)] !== undefined) return fileMap[normalizePath(t)];
  }
  return null;
}

function buildStaticPreview(indexHtml, fileMap) {
  let html = indexHtml;
  // Inline local stylesheets
  html = html.replace(/<link[^>]*?href=["']([^"']+)["'][^>]*?>/gi, (match, href) => {
    if (!/rel=["']stylesheet["']/i.test(match) || isExternal(href)) return match;
    const content = lookupFile(fileMap, href, '');
    if (content == null) return match;
    return '<style>\n' + content + '\n</style>';
  });
  // Inline local scripts
  html = html.replace(/<script([^>]*?)src=["']([^"']+)["']([^>]*)><\/script>/gi, (match, pre, src, post) => {
    if (isExternal(src)) return match;
    const content = lookupFile(fileMap, src, '');
    if (content == null) return match;
    const isModule = /type=["']module["']/i.test(pre + post);
    return '<script' + (isModule ? ' type="module"' : '') + '>\n' + content + '\n</script>';
  });
  return html;
}

function buildReactPreview(fileMap, pkg, indexHtml) {
  const sourceExts = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
  const sources = {};
  const cssFiles = [];
  for (const [path, content] of Object.entries(fileMap)) {
    if (path.includes('node_modules') || path.includes('.config.')) continue;
    const ext = path.substring(path.lastIndexOf('.'));
    if (sourceExts.includes(ext)) {
      sources[path] = content;
    } else if (ext === '.css') {
      cssFiles.push(content);
    }
  }

  const entryCandidates = [
    'src/main.jsx', 'src/main.tsx', 'src/index.jsx', 'src/index.tsx',
    'src/main.js', 'src/index.js', 'src/App.jsx', 'src/App.tsx',
    'main.jsx', 'index.jsx', 'App.jsx', 'index.js'
  ];
  let entry = entryCandidates.find(p => sources[p]);
  if (!entry) entry = Object.keys(sources).find(p => /main|index|app/i.test(p)) || Object.keys(sources)[0];

  const cssText = cssFiles.join('\n');
  let title = 'Preview';
  if (indexHtml) {
    const m = indexHtml.match(/<title>(.*?)<\/title>/i);
    if (m) title = m[1];
  }

  const sourcesJson = JSON.stringify(sources);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${cssText}</style>
<style>body{margin:0;font-family:system-ui,sans-serif}#__preview_err{position:fixed;bottom:0;left:0;right:0;max-height:45vh;overflow:auto;background:#1a0000;color:#ff8080;padding:10px 14px;font-family:monospace;font-size:12px;white-space:pre-wrap;z-index:99999;display:none;border-top:1px solid #ff0000}</style>
<script src="https://unpkg.com/react@18/umd/react.development.js" crossorigin></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js" crossorigin></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
</head>
<body>
<div id="root"></div>
<div id="__preview_err"></div>
<script>
var __sources = ${sourcesJson};
var __entry = ${JSON.stringify(entry)};
var __modules = {};
var __cache = {};
var __errEl = document.getElementById('__preview_err');
function __showErr(msg){ __errEl.textContent = String(msg); __errEl.style.display='block'; }
window.addEventListener('error', function(e){ __showErr(e.error && e.error.stack || e.message); });
window.addEventListener('unhandledrejection', function(e){ __showErr(e.reason && e.reason.stack || e.reason); });

function __resolvePath(fromPath, spec){
  var dir = fromPath.indexOf('/') >= 0 ? fromPath.substring(0, fromPath.lastIndexOf('/')) : '';
  var parts = (dir + '/' + spec).split('/');
  var resolved = [];
  for (var i=0;i<parts.length;i++){
    var p = parts[i];
    if (p==='..') resolved.pop();
    else if (p!=='.' && p!=='') resolved.push(p);
  }
  return resolved.join('/');
}

function __findSource(base){
  var exts = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '/index.js', '/index.jsx', '/index.ts', '/index.tsx'];
  for (var i=0;i<exts.length;i++){
    var key = base + exts[i];
    if (__sources[key] !== undefined) return key;
  }
  return null;
}

function __makeRequire(fromPath){
  return function(spec){
    if (spec === 'react') return window.React;
    if (spec === 'react-dom') return window.ReactDOM;
    if (spec === 'react-dom/client') return window.ReactDOM;
    if (spec === 'react/jsx-runtime' || spec === 'react/jsx-dev-runtime'){
      return { jsx: window.React.createElement, jsxs: window.React.createElement, Fragment: window.React.Fragment };
    }
    if (/\\.(css|svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|eot)$/.test(spec)) return {};
    var resolved = __resolvePath(fromPath, spec);
    var key = __findSource(resolved);
    if (!key) throw new Error('Cannot resolve module: ' + spec + ' from ' + fromPath);
    if (__cache[key]) return __cache[key].exports;
    var module = { exports: {} };
    __cache[key] = module;
    var factory = __modules[key];
    if (!factory) throw new Error('Module not transpiled: ' + key);
    factory.call(module.exports, module.exports, __makeRequire(key), module, '', key);
    return module.exports;
  };
}

var __ok = true;
for (var path in __sources){
  try {
    var result = Babel.transform(__sources[path], {
      presets: [
        ['react', { runtime: 'classic' }],
        'typescript'
      ],
      plugins: ['transform-modules-commonjs'],
      filename: path
    });
    __modules[path] = new Function('exports', 'require', 'module', '__dirname', '__filename', result.code);
  } catch(e){
    __showErr('Transform error in ' + path + ':\\n' + (e.message || e));
    __ok = false;
  }
}

if (__ok && __entry && __modules[__entry]){
  try {
    __makeRequire('')(__entry);
  } catch(e){
    __showErr(e.stack || e.message || e);
  }
} else if (!__entry) {
  __showErr('No entry point found. Expected src/main.jsx, src/index.jsx, or similar.');
}
</script>
</body>
</html>`;
}

function buildFallbackPreview(fileMap) {
  const fileList = Object.keys(fileMap).filter(p => !p.includes('node_modules')).slice(0, 50);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{background:#0a0a0a;color:#00ff41;font-family:monospace;padding:24px;margin:0}
h2{color:#00ff41;margin:0 0 12px}
p{color:#00ff41;margin:8px 0;opacity:0.7}
ul{list-style:none;padding:0;margin:12px 0}
li{padding:3px 0;color:#00ff41;opacity:0.6}
</style></head><body>
<h2>// No preview available</h2>
<p>Add an <strong>index.html</strong> (static site) or a <strong>package.json</strong> with React + <strong>src/main.jsx</strong> to see a live preview.</p>
<p>Files in project:</p>
<ul>${fileList.map(f => '<li>' + f + '</li>').join('')}</ul>
</body></html>`;
}

// Media Library assets committed to the user's repo are referenced in the
// code by their site-relative path ("/assets/x.jpg") — which the deployed
// host serves, but the in-iframe preview can't. `assetMap` ({ "/assets/x.jpg":
// "<resolvable preview url>" }) swaps those for a URL that loads now (the raw
// GitHub URL for a public repo). A plain string replace of the exact,
// distinctive path catches src / srcset / href / CSS url() / JSX alike.
// Pasted-URL assets are already absolute and need nothing.
function applyAssetMap(html, assetMap) {
  if (!assetMap) return html;
  let out = html;
  for (const [sitePath, previewUrl] of Object.entries(assetMap)) {
    if (!sitePath || !previewUrl || sitePath === previewUrl) continue;
    out = out.split(sitePath).join(previewUrl);
  }
  return out;
}

export function buildPreviewHtml(files, { assetMap } = {}) {
  if (!files || files.length === 0) return buildFallbackPreview({});
  const fileMap = {};
  for (const f of files) {
    fileMap[normalizePath(f.path)] = f.content;
  }

  const indexHtml = fileMap['index.html'] || fileMap['public/index.html'];
  const pkg = safeParse(fileMap['package.json']);
  const hasReact = (pkg && (pkg.dependencies?.react || pkg.devDependencies?.react)) ||
    Object.keys(fileMap).some(p => /\.(jsx|tsx)$/.test(p));

  let html;
  if (hasReact) {
    html = buildReactPreview(fileMap, pkg, indexHtml);
  } else if (indexHtml) {
    html = buildStaticPreview(indexHtml, fileMap);
  } else {
    html = buildFallbackPreview(fileMap);
  }
  return applyAssetMap(html, assetMap);
}