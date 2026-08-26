// Compile Target Adapter Interface
// Each compile target (android-apk, web-app, etc.) implements this interface.
// compileProject looks up the adapter by target ID and delegates validation,
// scaffolding, and build-step generation to it. This isolates each target's
// logic so fixing one never risks breaking another.

export interface ProjectFile {
  path: string;
  content: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  warnings: string[];
}

export interface ScaffoldResult {
  files: ProjectFile[];    // augmented file list (originals + generated)
  generated: string[];     // paths of auto-generated files
  warnings: string[];
}

export interface BuildStep {
  name?: string;
  uses?: string;
  with?: Record<string, string>;
  run?: string;             // shell commands (multi-line string for block scalar)
  env?: Record<string, string>;
}

export interface ArtifactSpec {
  glob: string;             // what to upload to the GitHub release
  isGlob: boolean;          // true = fail_on_unmatched_files on glob
  verifyCommand?: string;   // shell command to verify artifact before release
  artifactName?: string;    // normalized name for _compiled/ (e.g. "app.apk"); omit for glob targets
}

export interface CompileTarget {
  id: string;
  label: string;
  runner: string;           // "ubuntu-latest" or "macos-latest"

  // 1. Validate: does this project have the essential source files this target needs?
  validate(files: ProjectFile[]): ValidationResult;

  // 2. Scaffold: auto-generate missing config files ( Gradle, pyproject, etc.)
  scaffold(files: ProjectFile[]): ScaffoldResult;

  // 3. Build steps: structured GitHub Actions job steps
  buildSteps(files: ProjectFile[]): BuildStep[];

  // 4. Artifact: what to release and how to verify it
  artifact: ArtifactSpec;

  // 5. Required secrets (checked before dispatch; empty = none needed)
  requiredSecrets?: string[];

  // 6. Error patterns for log filtering (what lines are "real errors" for this target)
  errorPatterns?: RegExp[];
}