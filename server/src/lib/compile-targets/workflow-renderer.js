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

  // A TARGET MAY NEED MORE THAN ONE RUNNER. Before 2026-10-01 `runner` was always a string, so a compile
  // target had exactly one machine and therefore exactly one architecture — fine for the Swift path (it
  // cross-builds) and the Node path (it ships both binaries behind a dispatcher), wrong for Python, where
  // PyInstaller can only build for the machine running it. A Python/Qt app therefore came out arm64-only
  // and an Intel Mac refused it with "not supported on this Mac", with no Intel option to ask for.
  //
  // Passing a list renders a matrix: one job per entry, each with `matrix.runner` and `matrix.arch`
  // available to the build steps — which is how the disk image gets the architecture in its filename. A
  // list of ONE still renders a matrix on purpose, so a target whose steps and artifact name reference
  // `${{ matrix.arch }}` behaves the same whether it declared one runner or two.
  const matrix = Array.isArray(runner) ? runner : null;
  const jobHeader = matrix
    ? `    strategy:
      fail-fast: false
      matrix:
        include:
${matrix.map((r) => `          - runner: ${r.runner}\n            arch: ${r.arch}`).join('\n')}
    runs-on: \${{ matrix.runner }}`
    : `    runs-on: ${runner}`;

  return `name: Build

on:
  workflow_dispatch:

jobs:
  build:
${jobHeader}
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
