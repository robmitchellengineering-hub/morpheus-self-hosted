// Realistic build-time estimates per compile target (seconds), used as the ETA
// fallback before GitHub Actions reports step progress. Once step progress
// arrives, the run timer switches to a dynamic ETA derived from the actual
// completed/total steps — these are just the pre-progress fallbacks.
export const COMPILE_ESTIMATE_SECONDS = {
  'web-app': 180,
  'python-package': 180,
  'arduino-firmware': 240,
  'linux-binary': 360,
  'mac-app': 540,
  'windows-exe': 540,
  'android-apk': 600,
  'ios-app': 780,
  'rpi-distro': 900,
  'linux-distro': 1200,
};

export function getCompileEstimate(target) {
  return COMPILE_ESTIMATE_SECONDS[target] || 360;
}