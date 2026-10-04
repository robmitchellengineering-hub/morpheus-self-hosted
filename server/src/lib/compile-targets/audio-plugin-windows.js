// Audio Plugin compile target — **Windows only** — one CLAP source in, VST3 + CLAP + standalone out.
//
// THREE FORMATS, AND THE MISSING ONE IS NOT AN OMISSION. There is no Audio Unit outside Apple's platforms,
// so the `.component` the macOS route emits cannot exist here. The generated CMakeLists drops it — and the
// AudioUnitSDK fetch that comes with it — on anything that is not APPLE (see lib/audioPluginTemplate.js).
// A musician reading "VST3 · AU · CLAP" as one product would be right to ask where the fourth file is, so
// the label says what this route actually builds and the manual says why.
//
// WHY IT IS ITS OWN ROUTE RATHER THAN A SECOND LEG OF THE macOS ONE. Rob, 2026-10-04: "It needs to be
// clear that thats a mac os only audio plugin route same for the windows one your about to build." An OS
// is not a build-matrix detail to leave the user to infer from a filename: they pick a route BEFORE the
// build, and the artifacts are then what they expect. `mac-app` and `windows-exe` are separate picker
// entries for the same reason.
//
// ── THE WINDOWS LAYOUT IS NOT THE macOS ONE, AND THE VERIFY STEP HAS TO KNOW ─────────────────────────────
// Measured from clap-wrapper's own `cmake/make_clapfirst.cmake`, which sends each format somewhere
// different under the assets directory on WIN32 — not the flat layout macOS gets:
//
//     CLAP        -> build/assets/CLAP/<name>.clap
//     VST3        -> build/assets/VST3/<name>.vst3          (a SINGLE FILE by default, not a folder bundle)
//     standalone  -> build/assets/Standalone-morpheus_plugin_standalone/<name>.exe
//
// So a check written for macOS — "look inside the bundle for Contents/MacOS/<name>" — finds nothing here
// and would report every format missing. That is the class of mistake this target's own verify step exists
// to prevent, which is why it asserts the path it actually produced rather than the path it expected.
//
// The plugin PROJECT is shared with the macOS route (lib/audioPluginProject.js): same sources, same
// identity file, and one CMakeLists that configures correctly on either platform. Only the runner, the
// commands and the packaging differ.
import { CLAP_WRAPPER_REF, CLAP_WRAPPER_REPO, PLUGIN_MANIFEST, readManifest, scaffoldPlugin, validatePlugin } from '../audioPluginProject.js';
import { namPlan } from '../namPlugin.js';

export { PLUGIN_MANIFEST, readManifest };

/** The pinned clap-wrapper commit is shared with the macOS route — see lib/audioPluginProject.js. */
export const WINDOWS_ASSETS = 'build/assets';

export const audioPlugin = {
  id: 'audio-plugin-windows',
  label: 'Audio Plugin — Windows (VST3 · CLAP)',
  runner: 'windows-latest',

  validate: validatePlugin,
  scaffold: scaffoldPlugin,

  buildSteps(files) {
    const manifest = readManifest(files);
    const name = manifest.name;
    // Shared with the other two routes — see lib/namPlugin.js. Empty unless the project carries a model.
    const nam = namPlan(files, manifest);
    // WHERE clap-wrapper PUTS THEM ON WINDOWS — the DIRECTORY, not the path. The file is not at
    // `<dir>/<name>.vst3` and assuming it was is a mistake this target already made once on a runner: the
    // Visual Studio generator is MULTI-CONFIG, so CMake appends the configuration to every output directory
    // and the artifact is one level deeper (`…/VST3/Release/<name>.vst3`). The build had worked; the check
    // looked in the wrong place. So these are the directories the artifacts are searched in, and `Release`
    // is never written down — a Debug build would put them somewhere else again.
    const clapDir = `${WINDOWS_ASSETS}/CLAP`;
    const vst3Dir = `${WINDOWS_ASSETS}/VST3`;
    const standaloneDir = `${WINDOWS_ASSETS}/Standalone-morpheus_plugin_standalone`;

    return [
      { uses: 'actions/checkout@v4' },

      {
        name: 'Fetch the plugin wrappers',
        // Shallow and pinned: this is third-party code executed as part of the user's build, so the ref is
        // a constant rather than whatever main happens to be.
        // Separate lines rather than `&&`, because the runner's default Windows shell is PowerShell and a
        // failing `git clone` must stop the step rather than be reported by whatever runs next.
        run: [
          '$ErrorActionPreference = "Stop"',
          `git clone ${CLAP_WRAPPER_REPO} "$env:RUNNER_TEMP/clap-wrapper"`,
          'if ($LASTEXITCODE -ne 0) { throw "cloning clap-wrapper failed" }',
          `git -C "$env:RUNNER_TEMP/clap-wrapper" checkout ${CLAP_WRAPPER_REF}`,
          'if ($LASTEXITCODE -ne 0) { throw "checking out the pinned clap-wrapper commit failed" }',
        ].join('\n'),
      },

      // Only when the project carries a model — see lib/namPlugin.js. The submodule update is the part that
      // matters: Eigen is a submodule, and a plain clone leaves the include directory empty.
      ...(nam.hasModel ? [{
        name: 'Fetch the neural engine',
        run: nam.clone.powershell.join('\n'),
      }] : []),

      {
        name: 'Configure',
        // NO -DCMAKE_BUILD_TYPE: the default generator on a Windows runner is Visual Studio, which is
        // multi-config, and CMake ignores CMAKE_BUILD_TYPE for those. The configuration is chosen at BUILD
        // time with --config Release, in every build step below.
        run: [
          '$ErrorActionPreference = "Stop"',
          `cmake -B build -DCLAP_WRAPPER_DIR="$env:RUNNER_TEMP/clap-wrapper"${nam.hasModel ? ` ${nam.configure.powershell}` : ''}`,
          'if ($LASTEXITCODE -ne 0) { throw "cmake configure failed" }',
        ].join('\n'),
      },

      {
        name: 'Build CLAP and VST3',
        // EACH FORMAT IS ITS OWN TARGET, deliberately — the same reason as the macOS route. Building them
        // together means one format's failure aborts the build before the others link, and a format that
        // was skipped is left on disk as something that passes a file-exists check.
        run: [
          '$ErrorActionPreference = "Stop"',
          'foreach ($t in @("morpheus_plugin_clap", "morpheus_plugin_vst3")) {',
          '  Write-Host "::group::building $t"',
          '  cmake --build build --config Release --target $t',
          '  if ($LASTEXITCODE -ne 0) { throw "build failed: $t" }',
          '  Write-Host "::endgroup::"',
          '}',
        ].join('\n'),
      },

      {
        name: 'Build the standalone',
        // Its own step: the standalone is the format that pulls RtAudio, RtMidi and (on Windows) the
        // Windows Implementation Library, and a failure there must not strand the two a musician loads in
        // a DAW. It is also the format a user can try without owning one.
        run: [
          '$ErrorActionPreference = "Stop"',
          'cmake --build build --config Release --target morpheus_plugin_standalone',
          'if ($LASTEXITCODE -ne 0) { throw "build failed: morpheus_plugin_standalone" }',
        ].join('\n'),
      },

      {
        name: 'Verify every format is a real plugin binary',
        // THE CHECK THE macOS ROUTE PAID FOR, adapted to this platform's layout. A VST3 that is 0 bytes, or
        // a standalone that was never linked because another format failed first, both pass a
        // "did the build produce a file?" check. So: the file must exist, must be a PE image (the MZ/PE
        // signature, read here rather than inferred from the extension), and must be too big to be a stub.
        //
        // The entry-point symbols are asserted only if `dumpbin` is on PATH, and the step FAILS if it is
        // not — a check that silently does not run reads as a check that passed (H17), which is the lesson
        // this repository keeps paying for.
        run: [
          '$ErrorActionPreference = "Stop"',
          'function Test-PE([string]$Path) {',
          '  $fs = [System.IO.File]::OpenRead($Path)',
          '  try {',
          '    $br = New-Object System.IO.BinaryReader($fs)',
          '    if ($br.ReadUInt16() -ne 0x5A4D) { return $false }   # MZ',
          '    $fs.Position = 0x3C',
          '    $peOffset = $br.ReadUInt32()',
          '    $fs.Position = $peOffset',
          '    return ($br.ReadUInt32() -eq 0x00004550)             # PE\\0\\0',
          '  } finally { $fs.Dispose() }',
          '}',
          `$formats = @(`,
          `  @{ format = 'CLAP';       dir = '${clapDir}';       file = '${name}.clap'; symbol = 'clap_entry' }`,
          `  @{ format = 'VST3';       dir = '${vst3Dir}';       file = '${name}.vst3'; symbol = 'GetPluginFactory' }`,
          `  @{ format = 'standalone'; dir = '${standaloneDir}'; file = '${name}.exe';  symbol = $null }`,
          ')',
          // dumpbin IS NOT ON PATH ON A WINDOWS RUNNER, and the first run proved it: the build finished and
          // this step refused to pass, which is what it is for. CMake finds the MSVC toolchain through the
          // registry; the DEVELOPER environment is never entered, so the tools are installed and absent from
          // PATH at the same time. Located with vswhere rather than by adding a third-party action to the
          // supply chain, and rather than weakening the check — the entry-point assertion is what separates a
          // real plugin from a DLL with the right name.
          '$dumpbin = $null',
          "$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\\Installer\\vswhere.exe'",
          'if (Test-Path $vswhere) {',
          '  $vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath',
          '  if ($vsPath) {',
          "    $dumpbin = Get-ChildItem -Path (Join-Path $vsPath 'VC\\Tools\\MSVC') -Recurse -Filter dumpbin.exe -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'Hostx64\\\\x64' } | Select-Object -First 1",
          '  }',
          '}',
          'if (-not $dumpbin) { throw "dumpbin could not be located (looked with vswhere at $vswhere), so the entry-point assertions cannot run. Do not let this step pass (H17)." }',
          'Write-Host "using $($dumpbin.FullName)"',
          '$bad = @()',
          'foreach ($t in $formats) {',
          '  $hit = Get-ChildItem -Path $t.dir -Recurse -Filter $t.file -ErrorAction SilentlyContinue | Select-Object -First 1',
          '  if (-not $hit) { Write-Host "MISSING ($($t.format)): no $($t.file) anywhere under $($t.dir)"; $bad += $t.format; continue }',
          '  $p = $hit.FullName',
          '  $size = $hit.Length',
          '  if ($size -lt 8192) { Write-Host "TOO SMALL TO BE A PLUGIN ($($t.format)): $p ($size bytes)"; $bad += $t.format; continue }',
          '  if (-not (Test-PE $p)) { Write-Host "NOT A PE IMAGE ($($t.format)): $p"; $bad += $t.format; continue }',
          '  if ($t.symbol) {',
          '    $exports = & $dumpbin.FullName /nologo /exports $p | Out-String',
          '    if ($exports -notmatch "\\b$($t.symbol)\\b") { Write-Host "MISSING ENTRY POINT $($t.symbol) IN ($($t.format)): $p"; $bad += $t.format; continue }',
          '  }',
          '  Write-Host ("  {0,-11} {1,10:N0} bytes  {2}" -f $t.format, $size, $p)',
          '}',
          'if ($bad.Count -gt 0) { throw "the build did not produce usable plugins: $($bad -join \', \')" }',
          'Write-Host "all three formats produced, each a PE image with its real entry point"',
        ].join('\n'),
      },

      {
        name: 'Package',
        // One zip per format, because they go to different folders on the user's machine and a single
        // archive would mean unpacking all of it to use one. `Compress-Archive` preserves the file itself;
        // a VST3 here is a single file, not a folder bundle, so there is no structure to preserve.
        run: [
          '$ErrorActionPreference = "Stop"',
          // Searched for the same reason the verification searches: the configuration subdirectory is the
          // generator's business, not something to hardcode here.
          '$zips = @(',
          `  @{ file = '${name}.vst3'; out = 'plugin-windows-vst3.zip' }`,
          `  @{ file = '${name}.clap'; out = 'plugin-windows-clap.zip' }`,
          `  @{ file = '${name}.exe';  out = 'plugin-windows-standalone.zip' }`,
          ')',
          'foreach ($z in $zips) {',
          `  $hit = Get-ChildItem -Path '${WINDOWS_ASSETS}' -Recurse -Filter $z.file -ErrorAction SilentlyContinue | Select-Object -First 1`,
          '  if (-not $hit) { throw "cannot package $($z.file): it was not produced" }',
          `  Compress-Archive -Path $hit.FullName -DestinationPath (Join-Path '${WINDOWS_ASSETS}' $z.out) -Force`,
          '}',
          `Get-ChildItem '${WINDOWS_ASSETS}/plugin-windows-*.zip' | Select-Object Name, Length`,
        ].join('\n'),
      },
    ];
  },

  artifact: {
    // Three downloads, one per format. The `plugin-windows-` prefix is not decoration: macOS and Windows
    // builds of the same plugin are different files for different machines, and H20's rule is that the
    // filename must say which machine an artifact runs on.
    glob: `${WINDOWS_ASSETS}/plugin-windows-*.zip`,
    isGlob: true,
    verifyCommand: `dir build\\assets\\plugin-windows-vst3.zip build\\assets\\plugin-windows-clap.zip build\\assets\\plugin-windows-standalone.zip`,
  },

  errorPatterns: [
    /CMake Error/i,
    /CLAP_WRAPPER_DIR is not set/,
    /error C\d{4}/,             // an MSVC compile error, named as one
    /fatal error C\d{4}/,
    /LNK\d{4}/,                 // an MSVC link error — the class that leaves a missing binary
    /MISSING ENTRY POINT/,
    /NOT A PE IMAGE/,
    /TOO SMALL TO BE A PLUGIN/,
    /'cmake' is not recognized/,
    /error: /i,
  ],
};

export default audioPlugin;
