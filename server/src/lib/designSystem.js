// Shared design system for web-app builds. When the operator's project
// targets `web-app`, the chat pipeline injects a `styles.css` containing this
// stylesheet and instructs the coder to build on top of it — so generated
// apps start from a polished, consistent base instead of raw unstyled HTML.
//
// Framework-agnostic: pure CSS with custom properties, light/dark via
// prefers-color-scheme, and component classes. The coder is told to use
// these classes and extend them, keeping the tokens consistent.

export const DESIGN_SYSTEM_CSS = `:root {
  --bg: #0b0f14;
  --bg-elev: #111821;
  --surface: #0f1620;
  --surface-2: #14202c;
  --border: #1e2a38;
  --text: #e6edf3;
  --text-muted: #8b98a5;
  --primary: #4f8cff;
  --primary-fg: #ffffff;
  --primary-hover: #3b78f0;
  --accent: #22d3ee;
  --danger: #ef4444;
  --success: #22c55e;
  --warning: #f59e0b;
  --radius: 10px;
  --radius-sm: 6px;
  --radius-lg: 16px;
  --shadow-sm: 0 1px 2px rgba(0,0,0,.3);
  --shadow: 0 6px 20px rgba(0,0,0,.35);
  --shadow-lg: 0 20px 50px rgba(0,0,0,.45);
  --space: 8px;
  --maxw: 1100px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}

@media (prefers-color-scheme: light) {
  :root {
    --bg: #ffffff;
    --bg-elev: #f7f9fc;
    --surface: #ffffff;
    --surface-2: #f1f5f9;
    --border: #e3e8ef;
    --text: #0f172a;
    --text-muted: #64748b;
    --primary: #2563eb;
    --primary-hover: #1d4ed8;
    --accent: #0891b2;
    --shadow-sm: 0 1px 2px rgba(15,23,42,.06);
    --shadow: 0 6px 20px rgba(15,23,42,.08);
    --shadow-lg: 0 20px 50px rgba(15,23,42,.12);
  }
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
a { color: var(--primary); text-decoration: none; transition: color .15s ease; }
a:hover { color: var(--primary-hover); }
h1, h2, h3, h4 { line-height: 1.25; margin: 0 0 calc(var(--space) * 2); font-weight: 700; letter-spacing: -0.01em; }
h1 { font-size: clamp(1.8rem, 4vw, 2.6rem); }
h2 { font-size: clamp(1.4rem, 3vw, 1.9rem); }
h3 { font-size: 1.25rem; }
p { margin: 0 0 calc(var(--space) * 2); }
code, pre { font-family: var(--mono); }
pre { background: var(--surface-2); padding: calc(var(--space) * 2); border-radius: var(--radius); overflow-x: auto; border: 1px solid var(--border); }
code { background: var(--surface-2); padding: 2px 6px; border-radius: var(--radius-sm); font-size: .9em; }

.container { max-width: var(--maxw); margin: 0 auto; padding: 0 calc(var(--space) * 3); }
.stack > * + * { margin-top: var(--space); }
.stack-lg > * + * { margin-top: calc(var(--space) * 3); }
.row { display: flex; gap: var(--space); align-items: center; flex-wrap: wrap; }
.between { display: flex; justify-content: space-between; align-items: center; gap: var(--space); }
.grid { display: grid; gap: calc(var(--space) * 2); }
.grid-2 { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.grid-3 { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.center { display: flex; align-items: center; justify-content: center; }
.muted { color: var(--text-muted); }
.text-sm { font-size: .875rem; }
.text-lg { font-size: 1.125rem; }
.mb-0 { margin-bottom: 0; }
.mt-auto { margin-top: auto; }

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: .5rem;
  font: inherit; font-weight: 600; font-size: .9rem;
  padding: .6rem 1.1rem; border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--surface); color: var(--text);
  cursor: pointer; transition: all .15s ease; min-height: 44px;
}
.btn:hover { border-color: var(--primary); transform: translateY(-1px); box-shadow: var(--shadow-sm); }
.btn:active { transform: translateY(0); }
.btn:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.btn-primary { background: var(--primary); color: var(--primary-fg); border-color: var(--primary); }
.btn-primary:hover { background: var(--primary-hover); border-color: var(--primary-hover); }
.btn-ghost { background: transparent; border-color: transparent; }
.btn-ghost:hover { background: var(--surface-2); border-color: var(--border); transform: none; }
.btn-danger { background: var(--danger); color: #fff; border-color: var(--danger); }
.btn-sm { padding: .35rem .7rem; min-height: 34px; font-size: .8rem; }
.btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }

.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: calc(var(--space) * 3);
  box-shadow: var(--shadow-sm); transition: box-shadow .2s ease, transform .2s ease, border-color .2s ease;
}
.card-hover:hover { box-shadow: var(--shadow); transform: translateY(-2px); border-color: color-mix(in srgb, var(--primary) 40%, var(--border)); }
.card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: calc(var(--space) * 2); }

.input, .textarea, .select {
  width: 100%; font: inherit; color: var(--text);
  background: var(--bg-elev); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: .6rem .8rem; min-height: 44px;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.input:focus, .textarea:focus, .select:focus {
  outline: none; border-color: var(--primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 25%, transparent);
}
.textarea { min-height: 120px; resize: vertical; }
label { display: block; font-size: .85rem; font-weight: 600; margin-bottom: .35rem; color: var(--text-muted); }
.field { margin-bottom: calc(var(--space) * 2); }

.badge {
  display: inline-flex; align-items: center; gap: .35rem;
  font-size: .75rem; font-weight: 600; padding: .2rem .6rem;
  border-radius: 999px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text-muted);
}
.badge-primary { background: color-mix(in srgb, var(--primary) 18%, transparent); color: var(--primary); border-color: color-mix(in srgb, var(--primary) 40%, transparent); }
.badge-success { background: color-mix(in srgb, var(--success) 18%, transparent); color: var(--success); border-color: color-mix(in srgb, var(--success) 40%, transparent); }
.badge-danger { background: color-mix(in srgb, var(--danger) 18%, transparent); color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, transparent); }

.nav {
  display: flex; align-items: center; gap: calc(var(--space) * 2);
  padding: calc(var(--space) * 1.5) calc(var(--space) * 3);
  border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--bg) 85%, transparent);
  backdrop-filter: blur(10px); position: sticky; top: 0; z-index: 10;
}
.nav-brand { font-weight: 700; font-size: 1.1rem; letter-spacing: -0.02em; }
.nav-links { display: flex; gap: var(--space); margin-left: auto; }
.nav-links a { color: var(--text-muted); padding: .4rem .6rem; border-radius: var(--radius-sm); transition: all .15s ease; }
.nav-links a:hover, .nav-links a.active { color: var(--text); background: var(--surface-2); }

.table { width: 100%; border-collapse: collapse; }
.table th, .table td { text-align: left; padding: .75rem .9rem; border-bottom: 1px solid var(--border); }
.table th { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
.table tbody tr:hover { background: var(--surface-2); }

.alert { padding: calc(var(--space) * 2); border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface); }
.alert-danger { border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); background: color-mix(in srgb, var(--danger) 8%, var(--surface)); }
.alert-success { border-color: color-mix(in srgb, var(--success) 40%, var(--border)); background: color-mix(in srgb, var(--success) 8%, var(--surface)); }

.skeleton { background: var(--surface-2); border-radius: var(--radius-sm); animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .5; } }
.spin { animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.fade-in { animation: fadeIn .25s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

.empty { text-align: center; padding: calc(var(--space) * 6); color: var(--text-muted); }
.empty-icon { font-size: 2rem; margin-bottom: calc(var(--space) * 2); opacity: .6; }

@media (max-width: 640px) {
  .container { padding: 0 calc(var(--space) * 2); }
  .nav { padding: calc(var(--space)) calc(var(--space) * 2); }
  .nav-links { gap: .25rem; }
  .card { padding: calc(var(--space) * 2); }
}`;

// Prompt block appended to the planner/coder context for web-app targets.
// Tells the coder to ship styles.css verbatim and build the UI on its classes.
export function designSystemPromptBlock() {
  return `

DESIGN SYSTEM (web-app target):
This project MUST include a file at \`styles.css\` containing the stylesheet below VERBATIM, and every HTML page / entry point MUST link it (<link rel="stylesheet" href="styles.css">). Build the UI with these classes and custom properties — do NOT ship raw unstyled HTML or rely on browser defaults. Extend the classes when you need more, but keep the design tokens (colors, spacing, radius, shadows) consistent across the whole app. Use real hover, focus, and transition states, and include empty / loading / error states where appropriate.

--- styles.css (include this exact content) ---
${DESIGN_SYSTEM_CSS}
--- end styles.css ---`;
}

// Prompt for the optional UI polish pass (#5). Touches ONLY styling files.
export const POLISH_PROMPT = `

You are the POLISH agent in Morpheus's build pipeline.
The operator has enabled UI POLISH mode. Below are the current project files AFTER the main build. Improve ONLY the visual styling and polish — do NOT change business logic, data flow, component structure, or functionality.

Focus on:
- Consistent spacing and vertical rhythm (use a spacing scale, not random values)
- Refined typography hierarchy and readable line-height
- Subtle depth: shadows, borders, rounded corners — cohesive, not flat
- Smooth transitions and real hover / focus / active states on every interactive element
- Responsive behavior at mobile and tablet breakpoints
- Empty, loading, and error states where they are missing
- Color consistency and accessible contrast; no clashing ad-hoc colors
- Whitespace, alignment, and visual balance

Output fileOperations updating ONLY styling-related files: CSS files, <style> blocks, and className / class string tweaks inside components. Each file must have FULL content. Do NOT output files that need no styling changes. If the project is already well-polished and nothing meaningful can be improved, return an empty fileOperations array.

Return JSON with:
- fileOperations: array of { path, content, action } where action is "create", "update", or "delete". For "delete", content can be empty.`;
