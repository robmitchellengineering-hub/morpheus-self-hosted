// The launcher layer — starting and stopping a local Portable Morpheus without a terminal vocabulary.
//
// WHY THIS EXISTS. The installer got someone to a working server in one command, but a command is not
// an app: after a reboot there is no memory of it, and "cd server && npm start" is not something to ask
// of the person this download is for. So there are three small pieces — a start command, a stop
// command, and a double-clickable file per platform that runs the start command.
//
// WHAT THIS DELIBERATELY DOES NOT DO: pretend to be a signed native app. The launchers are shell
// wrappers, so macOS Gatekeeper quarantines a downloaded .command and Windows SmartScreen warns on a
// .bat. Both are surmountable in one step, and the alternative — shipping an unsigned bundle that
// claims to be an app — is the kind of claim this repo keeps catching elsewhere. The caveat is stated
// in PORTABLE_GATEKEEPER_NOTE, printed by the setup, and asserted by the guard.

/** How long to wait for the server to answer before giving up on opening a browser. */
export const READY_TIMEOUT_MS = 90_000;
export const READY_POLL_MS = 750;
export const HEALTH_PATH = '/api/health';
export const LOCAL_PORT = 4500;

/** The launcher files, generated so their contents and the docs cannot disagree. */
export const LAUNCHERS = [
  {
    file: 'Portable-Morpheus.command',
    platform: 'darwin',
    label: 'macOS',
    body: [
      '#!/bin/bash',
      '# Portable Morpheus — double-click this in Finder.',
      '#',
      '# macOS will refuse the first double-click if this file arrived in a download (Gatekeeper marks',
      '# downloaded files as quarantined). Right-click it and choose Open, or run once:',
      '#   xattr -d com.apple.quarantine "Portable-Morpheus.command"',
      'set -e',
      'cd "$(dirname "$0")"',
      'exec npm run portable:start',
      '',
    ].join('\n'),
  },
  {
    file: 'Portable-Morpheus.bat',
    platform: 'win32',
    label: 'Windows',
    body: [
      '@echo off',
      'REM Portable Morpheus — double-click this in Explorer.',
      'REM',
      'REM Windows SmartScreen may warn the first time. Choose "More info" then "Run anyway".',
      'cd /d "%~dp0"',
      'call npm run portable:start',
      'pause',
      '',
    ].join('\n'),
  },
  {
    file: 'Portable-Morpheus.desktop',
    platform: 'linux',
    label: 'Linux',
    body: [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Portable Morpheus',
      'Comment=Start your own Morpheus on this machine',
      'Exec=sh -c \'cd "$(dirname "%k")" && npm run portable:start\'',
      'Terminal=true',
      'Categories=Development;',
      '',
    ].join('\n'),
  },
];

/** The file for this platform, or null. */
export function launcherFor(platform) {
  return LAUNCHERS.find((l) => l.platform === platform) || null;
}

/**
 * The one thing a launcher cannot do for the operator. Stated rather than discovered, because a file
 * that silently refuses to open is indistinguishable from a broken download.
 */
export const PORTABLE_GATEKEEPER_NOTE =
  'The launcher is a shell wrapper, not a signed app: macOS quarantines a downloaded .command '
  + '(right-click → Open, or xattr -d com.apple.quarantine), and Windows SmartScreen warns on a .bat '
  + '(More info → Run anyway). One step, once.';

/** What `portable:start` does, in order, as it prints them. */
export const START_STEPS = [
  { id: 'env', title: 'server/.env exists (otherwise the setup has not been run)' },
  { id: 'db', title: 'The local Postgres cluster is running (started if not)' },
  { id: 'server', title: 'The server is started in this window, so the log is visible and Ctrl+C stops it' },
  { id: 'open', title: 'The browser opens once the server actually answers — not before' },
];

/** Where the operator goes, and how to get out. */
export function startedMessage(port = LOCAL_PORT) {
  return [
    `  Morpheus is running:  http://localhost:${port}`,
    '  Stop it by closing this window or pressing Ctrl+C.',
    '  The local database keeps its data between runs; `npm run portable:stop` stops it too.',
  ].join('\n');
}

/** Why the browser is opened only after a successful health check, in the words of the failure it avoids. */
export const OPEN_AFTER_HEALTHY_WHY =
  'Opening the browser first is how a launcher shows someone a connection-refused page and calls it a '
  + 'success. It waits for /api/health to answer first.';
