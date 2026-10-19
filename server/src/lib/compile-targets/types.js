// Compile Target Adapter shape (documentation only — plain JS, no runtime effect).
// Each compile target (android-apk, web-app, etc.) implements this shape.
// compileProject looks up the adapter by target ID and delegates validation,
// scaffolding, and build-step generation to it. This isolates each target's
// logic so fixing one never risks breaking another.

/**
 * @typedef {Object} ProjectFile
 * @property {string} path
 * @property {string} content
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid
 * @property {string} [error]
 * @property {string[]} warnings
 */

/**
 * @typedef {Object} ScaffoldResult
 * @property {ProjectFile[]} files    augmented file list (originals + generated)
 * @property {string[]} generated     paths of auto-generated files
 * @property {string[]} warnings
 */

/**
 * @typedef {Object} BuildStep
 * @property {string} [name]
 * @property {string} [uses]
 * @property {Object<string,string>} [with]
 * @property {string} [run]           shell commands (multi-line string for block scalar)
 * @property {Object<string,string>} [env]
 */

/**
 * @typedef {Object} ArtifactSpec
 * @property {string} glob            what to upload to the GitHub release
 * @property {boolean} isGlob         true = fail_on_unmatched_files on glob
 * @property {string} [verifyCommand] shell command to verify artifact before release
 * @property {string} [artifactName]  normalized name for _compiled/ (e.g. "app.apk"); omit for glob targets
 */

/**
 * @typedef {Object} CompileTarget
 * @property {string} id
 * @property {string} label
 * @property {string} runner                     "ubuntu-latest" or "macos-latest"
 * @property {(files: ProjectFile[]) => ValidationResult} validate
 * @property {(files: ProjectFile[]) => ScaffoldResult} scaffold
 * @property {(files: ProjectFile[]) => BuildStep[]} buildSteps
 * @property {ArtifactSpec} artifact
 * @property {string[]} [requiredSecrets]
 * @property {RegExp[]} [errorPatterns]
 */

export {};
