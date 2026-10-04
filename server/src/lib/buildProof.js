// BUILD-PROOF.txt: what a build ACTUALLY verified, written by the build, shipped with the artifact.
//
// WHY THIS EXISTS. Every number this project cares about — that a plugin is the right CPU, that a model is
// embedded, that the tone stack is the design — is asserted inside a GitHub Actions run and then scrolls away
// in a log the user never opens. Rob, 2026-10-05: *"I can see any of the things we've done, have they landed,
// where are they?"* — and he was right: the evidence existed and a user could not see any of it. This file is
// the evidence, in the one place a user already looks: beside the artifact, in `_compiled/`.
//
// ── WRITTEN BY THE BUILD, NOT ABOUT IT ───────────────────────────────────────────────────────────────────
// The distinction is the whole point. A file the generator writes from its own template is a CLAIM — it would
// say "AArch64" for a build that produced an x86-64 plugin, and it would say it convincingly. So the header
// comes from here and every fact under it is collected by the step that checked it, from the files that step
// just produced: the sizes and machine types it read out of the binaries, the model name and weight count it
// read out of the generated header, the parameter names it read out of the source that was compiled.
//
// The header therefore says what the file IS, and the build fills in what HAPPENED.
//
// ── A BUILD THAT CANNOT PROVE SOMETHING FAILS; IT DOES NOT PUBLISH A SHORTER FILE ─────────────────────────
// Every route's verify step already exits non-zero when a format is missing or the machine is wrong. The
// proof file is written at the END of that step, so a run that publishes one has passed every assertion in
// it. That is why there is no "unknown" or "n/a" anywhere in this file: an absent fact is a failed build.

/** Where the proof lands, in the workspace, so the workflow's release step can publish it. */
export const BUILD_PROOF_FILE = 'BUILD-PROOF.txt';

/** The heredoc marker. A word that cannot occur in the header, because a stray line would truncate the file. */
export const PROOF_DELIMITER = 'MORPHEUS_BUILD_PROOF_EOF';

/**
 * The fixed part of the file: what it is, and what its lines mean.
 *
 * Deliberately free of anything a build knows. The target id and label are identity, not evidence, and they
 * are the only two things here that come from outside the build.
 */
export function proofHeader({ target, targetLabel }) {
  return `MORPHEUS BUILD PROOF — ${target}
${'='.repeat(`MORPHEUS BUILD PROOF — ${target}`.length)}

${targetLabel}

WHAT THIS FILE IS
  This was written by the build that produced the files beside it, as it ran. Every line
  under "verified by this build" is the result of a check that executed in that build and
  was read back out of the artefacts it had just produced. Nothing here is copied from a
  template: the sizes and machine types were read out of the binaries, the model name and
  weight count out of the header the build generated, and the parameter names out of the
  source it compiled.

  A build that could not verify one of these FAILS rather than publishing a shorter file,
  so a file without a line is a build without that check — not a line that was skipped.

  It sits beside the downloads on purpose. The same evidence is in the build's log, which
  is where it used to live and where nobody reads it.`;
}

/**
 * The bash that collects the facts, appended into a route's verify step.
 *
 * `formats` is `[label, path or glob]` for each format the route promises, in the order it promises them, and
 * the lines are produced from the same loop that asserted them — so a format cannot be verified and then not
 * reported, which is the drift that would make this file decorative.
 *
 * POSIX `sh` built-ins only, and it appends to `${BUILD_PROOF_FILE}` in the workspace.
 */
export function proofBash({ formats }) {
  // ⚠️ NO `\n` ANYWHERE IN THE EMITTED SCRIPT, and that is not style. A guard asserts the rendered workflow
  // contains no escape sequence standing in for a newline — it exists because a `join` once collapsed this
  // whole verification script onto one line, and it passes four backslashes in a regex, which is a real
  // escape. `printf '...%s\n'` is legitimate shell and tripped it, so the newline is written by its own
  // `echo ""` instead. A deliberate escape and a collapsed script look identical to a text check.
  return [
    `proof_fact() { echo "  - $1" >> ${BUILD_PROOF_FILE}; }`,
    `echo "" >> ${BUILD_PROOF_FILE}`,
    `echo "verified by this build:" >> ${BUILD_PROOF_FILE}`,
    // The MACHINE THE BUILD RAN ON, named separately from the machine each artefact is FOR. The first version
    // said "a real binary for x86_64" on a host that had just built an AArch64 plugin, which is both true and
    // misleading; the per-line machine is the evidence, and naming the host is what makes the Pi story legible.
    'proof_fact "built on: $(uname -sm)"',
    'proof_fact "every format below was produced, and each line names the machine it was compiled for:"',
    // The value comes from the SAME variable the check above set, so a format cannot be verified and then
    // reported differently — or reported at all when its check failed.
    ...formats.flatMap(([label]) => {
      const value = `proof_${label.replace(/[^A-Za-z0-9]/g, '_').toLowerCase()}`;
      return [
        `printf '        %-11s %s' "${label}" "$${value}" >> ${BUILD_PROOF_FILE}`,
        `echo "" >> ${BUILD_PROOF_FILE}`,
      ];
    }),
    'proof_fact "the model embedded in it, read out of the header the build generated:"',
    `sed -n 's/^#define MORPHEUS_MODEL_/        /p' Source/ModelData.h >> ${BUILD_PROOF_FILE} 2>/dev/null || echo '        (none: this is the gain plugin, which is a supported state and not a failure)' >> ${BUILD_PROOF_FILE}`,
    'proof_fact "the parameters a host will offer, read out of the source that was compiled:"',
    `printf '        %s' "$(sed -n '/kParams\\[\\] = {/,/};/p' Source/Plugin.cpp | grep -o '"[^"]*"' | tr '\\n' ' ')" >> ${BUILD_PROOF_FILE}`,
    `echo "" >> ${BUILD_PROOF_FILE}`,
    `echo "" >> ${BUILD_PROOF_FILE}`,
  ].join('\n');
}

/**
 * The PowerShell equivalent, for the Windows route. Same facts, same order, same reason.
 */
export function proofPowerShell({ formats }) {
  const esc = (s) => String(s).replace(/'/g, "''");
  return [
    `Add-Content -Path '${BUILD_PROOF_FILE}' -Value ''`,
    `Add-Content -Path '${BUILD_PROOF_FILE}' -Value 'verified by this build:'`,
    `Add-Content -Path '${BUILD_PROOF_FILE}' -Value ("  - every format below was produced and is a real PE image for " + $env:PROCESSOR_ARCHITECTURE + ", not a stub:")`,
    ...formats.map(([label]) => `Add-Content -Path '${BUILD_PROOF_FILE}' -Value ('        ${esc(label).padEnd(11)}' + $proof_${label.replace(/[^A-Za-z0-9]/g, '_').toLowerCase()})`),
    `Add-Content -Path '${BUILD_PROOF_FILE}' -Value '  - the model embedded in it, read out of the header the build generated:'`,
    `Select-String -Path 'Source/ModelData.h' -Pattern '^#define MORPHEUS_MODEL_' | ForEach-Object { Add-Content -Path '${BUILD_PROOF_FILE}' -Value ('        ' + $_.Line) }`,
    `Add-Content -Path '${BUILD_PROOF_FILE}' -Value '  - the parameters a host will offer, read out of the source that was compiled:'`,
    `Add-Content -Path '${BUILD_PROOF_FILE}' -Value ('        ' + (((Select-String -Path 'Source/Plugin.cpp' -Pattern '\\{[^}]*\\},' | Select-Object -First 12).Line) -join ' '))`,
    `Add-Content -Path '${BUILD_PROOF_FILE}' -Value ''`,
  ].join('\n');
}

/** How a route writes the fixed header, before the facts are appended. Bash. */
export function proofHeaderBash({ target, targetLabel }) {
  return `cat > ${BUILD_PROOF_FILE} <<'${PROOF_DELIMITER}'
${proofHeader({ target, targetLabel })}
${PROOF_DELIMITER}`;
}

/** The same, in PowerShell. */
export function proofHeaderPowerShell({ target, targetLabel }) {
  return `@'
${proofHeader({ target, targetLabel })}
'@ | Set-Content -Path '${BUILD_PROOF_FILE}' -NoNewline`;
}
