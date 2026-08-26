// Structured GitHub Actions workflow renderer.
// Turns BuildStep[] into valid YAML — no more string concatenation scattered
// across target adapters. Each step is a structured object; this renderer
// handles indentation, block scalars, and nested keys consistently.

function renderStep(step) {
  // Build a flat list of (key, value, indentLevel) tuples, then render with
  // proper indentation. The first tuple goes on the dash line (6 spaces + "- "),
  // subsequent tuples indent to 8 spaces + indentLevel * 2.
  const items = [];

  if (step.name) items.push({ key: 'name', value: step.name, indent: 0 });
  if (step.uses) items.push({ key: 'uses', value: step.uses, indent: 0 });

  if (step.with) {
    items.push({ key: 'with', value: '', indent: 0 });
    for (const [k, v] of Object.entries(step.with)) {
      if (v.includes('\n')) {
        items.push({ key: k, value: '|', indent: 1 });
        for (const line of v.split('\n')) {
          items.push({ key: '', value: line, indent: 2 });
        }
      } else {
        items.push({ key: k, value: v, indent: 1 });
      }
    }
  }

  if (step.run) {
    if (step.run.includes('\n')) {
      items.push({ key: 'run', value: '|', indent: 0 });
      for (const line of step.run.split('\n')) {
        items.push({ key: '', value: line, indent: 1 });
      }
    } else {
      items.push({ key: 'run', value: step.run, indent: 0 });
    }
  }

  if (step.env) {
    items.push({ key: 'env', value: '', indent: 0 });
    for (const [k, v] of Object.entries(step.env)) {
      if (v.includes('\n')) {
        items.push({ key: k, value: '|', indent: 1 });
        for (const line of v.split('\n')) {
          items.push({ key: '', value: line, indent: 2 });
        }
      } else {
        items.push({ key: k, value: v, indent: 1 });
      }
    }
  }

  const lines = [];
  for (let i = 0; i < items.length; i++) {
    const { key, value, indent } = items[i];
    const baseIndent = 8 + indent * 2;
    if (i === 0) {
      // First item: "      - key: value" or "      - key:"
      lines.push(value ? `      - ${key}: ${value}` : `      - ${key}:`);
    } else if (key === '') {
      // Content line (multi-line run block): just the value indented
      lines.push(`${' '.repeat(baseIndent)}${value}`);
    } else {
      // Subsequent key: "        key: value" or "        key:"
      const prefix = ' '.repeat(baseIndent);
      lines.push(value ? `${prefix}${key}: ${value}` : `${prefix}${key}:`);
    }
  }

  return lines.join('\n');
}

export function renderWorkflow(runner, steps, artifact) {
  const yamlSteps = steps.map(renderStep).join('\n');

  // If the adapter declares a verify command, inject it as a step before the release
  const verifySection = artifact.verifyCommand
    ? `\n      - name: Verify artifact\n        run: |\n${artifact.verifyCommand.split('\n').map(l => '          ' + l).join('\n')}`
    : '';

  return `name: Build

on:
  workflow_dispatch:

jobs:
  build:
    runs-on: ${runner}
    permissions:
      contents: write
    steps:
${yamlSteps}${verifySection}
      - name: Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: v\${{ github.run_id }}
          files: ${artifact.glob}
          fail_on_unmatched_files: true
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;
}
