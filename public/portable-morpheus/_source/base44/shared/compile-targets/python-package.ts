// Python Package compile target — builds a .whl distribution.
// Auto-generates pyproject.toml from requirements.txt if missing,
// detects entry points (console_scripts), and includes data files via MANIFEST.in.

import { CompileTarget, ProjectFile, BuildStep } from './types.ts';
import { hasAny, hasFile, cloneFiles, getFile } from './utils.ts';

function parseRequirementsTxt(content: string): string[] {
  return content.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith('-'))
    .map(l => l.split('==')[0].split('>=')[0].split('<=')[0].split('~=')[0].trim())
    .filter(l => l);
}

function detectPackageName(files: ProjectFile[]): string {
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

function detectEntryPoint(files: ProjectFile[]): { module: string; func: string } | null {
  for (const f of files) {
    if (f.path.endsWith('.py') && /def\s+main\s*\(/.test(f.content) &&
        /if\s+__name__\s*==\s*['"]__main__['"]/.test(f.content)) {
      const module = f.path.replace(/\.py$/, '').replace(/\//g, '.');
      return { module, func: 'main' };
    }
  }
  return null;
}

export const pythonPackage: CompileTarget = {
  id: 'python-package',
  label: 'Python Package',
  runner: 'ubuntu-latest',

  validate(files: ProjectFile[]) {
    const warnings: string[] = [];
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

  scaffold(files: ProjectFile[]) {
    const generated: string[] = [];
    const warnings: string[] = [];
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

    const lines: string[] = [
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
    const dataDirs = new Set<string>();
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

  buildSteps(files: ProjectFile[]): BuildStep[] {
    return [
      { uses: 'actions/checkout@v4' },
      {
        uses: 'actions/setup-python@v5',
        with: { 'python-version': "'3.12'" }
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
      { run: 'python -m build' },
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