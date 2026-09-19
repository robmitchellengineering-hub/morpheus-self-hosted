// Python Package compile target — builds a .whl distribution.
// Auto-generates pyproject.toml from requirements.txt if missing,
// detects entry points (console_scripts), and includes data files via MANIFEST.in.

import { hasAny, hasFile, cloneFiles, getFile, detectPythonVersion, parseRequirementsTxt } from './utils.js';

function detectPackageName(files) {
  // Look for a top-level Python package (dir with __init__.py)
  for (const f of files) {
    const match = f.path.match(/^([^\/]+)\/__init__\.py$/);
    if (match && !['tests', 'test', 'src', 'venv', 'env'].includes(match[1])) {
      return match[1];
    }
  }
  // Fall back to a common name
  return 'morpheus_app';
}

function detectEntryPoint(files) {
  for (const f of files) {
    if (f.path.endsWith('.py') && /def\s+main\s*\(/.test(f.content) &&
        /if\s+__name__\s*==\s*['"]__main__['"]/.test(f.content)) {
      const module = f.path.replace(/\.py$/, '').replace(/\//g, '.');
      return { module, func: 'main' };
    }
  }
  return null;
}

export const pythonPackage = {
  id: 'python-package',
  label: 'Python Package',
  runner: 'ubuntu-latest',

  validate(files) {
    const warnings = [];
    const hasConfig = hasAny(files, ['pyproject.toml', 'setup.py', 'setup.cfg']);
    const hasPython = hasAny(files, ['requirements.txt']) || files.some(f => f.path.endsWith('.py'));
    if (!hasConfig && !hasPython) {
      return {
        valid: false,
        error: 'python-package target requires a Python file or a build config (pyproject.toml, setup.py).',
        warnings
      };
    }
    return { valid: true, warnings };
  },

  scaffold(files) {
    const generated = [];
    const warnings = [];
    const augmented = cloneFiles(files);

    const hasConfig = hasAny(augmented, ['pyproject.toml', 'setup.py', 'setup.cfg']);
    if (hasConfig) {
      return { files: augmented, generated, warnings };
    }

    // Auto-generate pyproject.toml
    const pkgName = detectPackageName(augmented);
    const reqContent = getFile(augmented, 'requirements.txt')?.content;
    const dependencies = reqContent ? parseRequirementsTxt(reqContent) : [];
    const entryPoint = detectEntryPoint(augmented);

    const lines = [
      '[build-system]',
      'requires = ["setuptools>=61.0"]',
      'build-backend = "setuptools.build_meta"',
      '',
      '[project]',
      `name = "${pkgName}"`,
      'version = "0.1.0"',
      'requires-python = ">=3.8"',
    ];

    if (dependencies.length > 0) {
      lines.push('dependencies = [');
      for (const dep of dependencies) {
        lines.push(`    "${dep}",`);
      }
      lines.push(']');
    }

    if (entryPoint) {
      lines.push('', '[project.scripts]');
      lines.push(`${pkgName.replace(/_/g, '-')} = "${entryPoint.module}:${entryPoint.func}"`);
    }

    // Detect package structure (src layout vs flat)
    const hasSrcDir = augmented.some(f => f.path.startsWith('src/'));
    lines.push('', '[tool.setuptools.packages.find]');
    if (hasSrcDir) {
      lines.push('where = ["src"]');
    } else {
      lines.push('where = ["."]');
    }

    augmented.push({ path: 'pyproject.toml', content: lines.join('\n') + '\n' });
    generated.push('pyproject.toml');
    warnings.push(`Auto-generated pyproject.toml (package: ${pkgName}${entryPoint ? `, entry point: ${entryPoint.module}:${entryPoint.func}` : ''}).`);

    // Auto-generate MANIFEST.in for data files
    const dataDirs = new Set();
    for (const f of augmented) {
      if (/^(templates?|static|assets?|data|config|resources?)\//.test(f.path)) {
        dataDirs.add(f.path.split('/')[0]);
      }
    }
    if (dataDirs.size > 0) {
      const manifestLines = Array.from(dataDirs).map(d => `recursive-include ${d} *`);
      augmented.push({ path: 'MANIFEST.in', content: manifestLines.join('\n') + '\n' });
      generated.push('MANIFEST.in');
    }

    return { files: augmented, generated, warnings };
  },

  buildSteps(files) {
    const pythonVersion = detectPythonVersion(files) || '3.12';
    return [
      { uses: 'actions/checkout@v4' },
      {
        uses: 'actions/setup-python@v5',
        with: { 'python-version': `'${pythonVersion}'` }
      },
      {
        name: 'Cache pip',
        uses: 'actions/cache@v4',
        with: {
          path: '~/.cache/pip',
          key: "pip-${{ runner.os }}-${{ hashFiles('requirements.txt', 'pyproject.toml') }}",
          'restore-keys': 'pip-${{ runner.os }}-'
        }
      },
      { run: 'pip install build' },
      {
        name: 'Build wheel',
        // Run `build` from OUTSIDE the project directory.
        //
        // `python -m build` puts the current working directory on sys.path, so a
        // project that ships its own `build.py` SHADOWS the `build` package and
        // `python -m build` executes the project's script instead. That script
        // usually exits 0, so the step reports success, produces no wheel, and
        // the target fails later at "No wheel produced" — with nothing in the log
        // explaining why. Confirmed live 2026-09-19: the step printed the
        // project's own script output and no dist/ was created.
        //
        // This is a real case, not a hypothetical: utils.js explicitly detects
        // projects that ship their own build script, and both linux-binary and
        // windows-exe build those. So a project can legitimately contain
        // build.py and still want a wheel.
        //
        // Passing the project as the source directory while standing in
        // $RUNNER_TEMP keeps build.py off sys.path. Output still lands in
        // <project>/dist, which is where the verify step and the release glob
        // below both expect it. Each `run:` step starts in the workspace, so the
        // `cd` does not leak into the verify step.
        run: [
          'cd "$RUNNER_TEMP"',
          'python -m build "$GITHUB_WORKSPACE"',
        ].join('\n')
      },
      {
        name: 'Verify package',
        run: [
          'ls -la dist/',
          'compgen -G "dist/*.whl" > /dev/null || { echo "No wheel produced"; exit 1; }'
        ].join('\n')
      }
    ];
  },

  artifact: {
    glob: 'dist/*',
    isGlob: true,
    verifyCommand: 'compgen -G "dist/*.whl" > /dev/null || { echo "No wheel produced"; exit 1; }'
  },

  errorPatterns: [
    /Traceback \(most recent call last\)/i,
    /ModuleNotFoundError/i,
    /ImportError/i,
    /error: invalid command/i
  ]
};

export default pythonPackage;
