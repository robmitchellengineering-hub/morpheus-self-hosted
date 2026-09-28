// The compile-target picker: ONE list, so three surfaces cannot drift.
//
// WHY THIS EXISTS
//
// The same target list was hardcoded in three places — the create-construct
// dialog, the in-workspace switcher and the GitHub import dialog — and they had
// already drifted: two of them omitted `linux-distro`, which the switcher
// offered, and the same target carried a different label in each. On 2026-09-28
// Rob asked for the web-app option to lead the list and to say it is also how
// you make a plain website, which is exactly the kind of edit that lands on one
// surface and misses the others.
//
// So the order and the wording live here, once. A surface picks a label style
// and gets the same targets in the same order; adding a target means adding one
// entry, not three. `scripts/verify-onramp.mjs` fails the build if a surface
// goes back to a hardcoded array or if web-app stops leading.
//
// `web-app` is first because it is the only target a non-developer is likely to
// want (a website or a web app) — the rest are binaries for people who already
// know they want one.

/**
 * Canonical order and per-surface wording.
 *
 * `web-app`'s wording is the one that carries a meaning the others do not: it is
 * how someone makes an ordinary website, not just a "web app". Do not shorten it
 * back to "Web app" without also checking the create dialog's helper line.
 *
 * style:
 *   create — the INITIALIZE CONSTRUCT dialog (long, says "build locally")
 *   import — the GitHub import dialog (long, no suffix; the repo already builds)
 *   bar    — the in-workspace switcher (short; it shares a toolbar row)
 */
export const COMPILE_TARGETS = [
  { value: 'web-app', create: 'Web app or website (build locally)', import: 'Web app or website', bar: 'web app / site' },
  { value: 'source', create: 'Source code only', import: 'Source code only', bar: 'source' },
  { value: 'windows-exe', create: 'Windows .exe (build locally)', import: 'Windows .exe', bar: 'win .exe' },
  { value: 'mac-app', create: 'macOS .app (build locally)', import: 'macOS .app', bar: 'mac .app' },
  { value: 'linux-binary', create: 'Linux binary (build locally)', import: 'Linux binary', bar: 'linux bin' },
  { value: 'android-apk', create: 'Android APK (build locally)', import: 'Android APK', bar: 'android apk' },
  { value: 'ios-app', create: 'iOS app (build locally)', import: 'iOS app', bar: 'ios app' },
  { value: 'python-package', create: 'Python package (build locally)', import: 'Python package', bar: 'py pkg' },
  { value: 'rpi-distro', create: 'Raspberry Pi distro (build locally)', import: 'Raspberry Pi distro', bar: 'rpi distro' },
  { value: 'linux-distro', create: 'Linux distro (build locally)', import: 'Linux distro', bar: 'linux distro' },
  { value: 'arduino-firmware', create: 'Arduino firmware (build locally)', import: 'Arduino firmware', bar: 'arduino' },
];

/** The value at the top of every list — the target a website is built from. */
export const DEFAULT_TARGET_VALUE = COMPILE_TARGETS[0].value;

/**
 * Options for a `SheetSelect`, in canonical order.
 *
 * Every target is included on every surface. The two that used to omit
 * `linux-distro` were not making a decision — nothing in the app gates it out of
 * creation — they had simply drifted, and a target that cannot be chosen at
 * creation but appears in the switcher is the kind of gap that reads as a bug.
 */
export function targetOptions(style) {
  return COMPILE_TARGETS.map((t) => ({ value: t.value, label: t[style] }));
}

/** The label a surface shows for one value; '' when the value is unknown. */
export function targetLabel(value, style) {
  const found = COMPILE_TARGETS.find((t) => t.value === value);
  return found ? found[style] : '';
}

/** True when `value` names a real target — used before persisting a selection. */
export function isCompileTarget(value) {
  return COMPILE_TARGETS.some((t) => t.value === value);
}
