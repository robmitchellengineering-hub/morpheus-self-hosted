// Publish-readiness (2026-09-09). Each compile-target adapter declares its own
// `publishChecklist` — "what a *shipped* one of these looks like". The build
// pipeline surfaces it to the planner/coder so output lands launch-ready
// instead of as a bare scaffold, and the PUBLISH panel shows it as a
// checklist run against the current files. Generalizes: a new target declares
// its own list (an APK → icon sets + permission justification, a Python
// package → LICENSE + pyproject metadata, …) with no core change.
import { getCompileTarget } from './compile-targets/index.js';

function checklistFor(target) {
  const adapter = getCompileTarget(target);
  return Array.isArray(adapter?.publishChecklist) ? adapter.publishChecklist : [];
}

// Concatenated views of the project the `check` predicates run against.
function fileViews(files) {
  const paths = (files || []).map((f) => f.path);
  let html = '';
  let jsx = '';
  for (const f of files || []) {
    const c = f.content || '';
    if (/\.html?$/i.test(f.path)) html += '\n' + c;
    else if (/\.[jt]sx?$/i.test(f.path)) jsx += '\n' + c;
  }
  return { paths, html, jsx };
}

// The block handed to the planner + coder on a build for a target that
// declares a checklist. Not prescriptive on a tiny/unrelated request, but a
// build that creates or reworks the deliverable should cover these.
export function publishPromptBlock(target) {
  const items = checklistFor(target);
  if (items.length === 0) return '';
  const lines = items.map((i) => `  - ${i.label}${i.when === 'data' ? ' (only if the site collects data)' : ''}: ${i.detail}`);
  return `
SHIPPABLE ${String(target).toUpperCase()} — a finished, launchable one of these includes:
${lines.join('\n')}
On a build that creates or substantially reworks the deliverable, include these unless the operator says otherwise. On a small or unrelated change, don't force them — but never remove one that already exists. If something needs an asset that isn't available (e.g. a real logo), say so rather than shipping a placeholder.
`;
}

// [{ id, label, detail, when, done }] for the PUBLISH panel.
export function evaluatePublishChecklist(target, files) {
  const items = checklistFor(target);
  if (items.length === 0) return { supported: false, items: [] };
  const v = fileViews(files);
  return {
    supported: true,
    items: items.map((i) => {
      let done = false;
      try { done = !!i.check?.(v); } catch { done = false; }
      return { id: i.id, label: i.label, detail: i.detail, when: i.when || 'always', done };
    }),
  };
}
