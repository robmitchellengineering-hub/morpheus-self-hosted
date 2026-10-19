// Remote access for a local Portable Morpheus — the rule, and the words, kept import-free so
// `scripts/verify-portable-remote.mjs` can assert them in CI's no-install job.
//
// DECIDED (Rob, 2026-09-29): Tailscale, not a Cloudflare tunnel and not a public port. The reasoning is
// in MORPHEUS-BIG-PICTURE.md → Portable Morpheus; short version: a portable install belongs to a
// stranger who has no domain and no Cloudflare account, quick tunnels change hostname on every restart,
// and a tunnel that terminates TLS at someone else's edge sits badly against "all data stays on your
// machine". Tailscale is the VPN-equivalent — end-to-end encrypted, NAT-traversed, and the machine gets
// a stable name, which is also what cookies and any future OAuth need.
//
// WHAT THIS DELIBERATELY DOES NOT DO: install Tailscale, or guess its command syntax.
//
//   * Installing it is a system-level change needing admin rights AND an account sign-in. A setup
//     script that silently installs a VPN is not one anybody should trust.
//   * `tailscale serve`'s syntax has changed across versions (a `serve https / http://…` form, then
//     `--bg`, then `--https=443`). The repo's own front-page lesson is exactly this: a button's label
//     changes and the copy that named it becomes a lie. So the script asks the INSTALLED cli to do the
//     work and shows the cli's own error if that version disagrees — it never pretends to know a syntax
//     it cannot see.
//
// `tailscale serve`, not `funnel`: serve exposes the app to YOUR tailnet, which is what "log in from
// anywhere" means for one person's own machine. Funnel would publish it to the open internet.

/** What the operator has to do themselves, per platform. `null` means we have no hint for it. */
export function tailscaleInstallHint(platform) {
  switch (platform) {
    case 'darwin':
      return {
        command: 'brew install --cask tailscale',
        also: 'Or download the Mac app: https://tailscale.com/download/mac',
        note: 'Then open Tailscale and sign in — the same account on your phone is what makes it reachable.',
      };
    case 'linux':
      return {
        command: 'curl -fsSL https://tailscale.com/install.sh | sh',
        also: 'Most distros also package it (apt/dnf/pacman) as "tailscale".',
        note: 'Then run: sudo tailscale up — and sign in.',
      };
    case 'win32':
      return {
        command: 'winget install tailscale.tailscale',
        also: 'Or download the Windows installer: https://tailscale.com/download/windows',
        note: 'Then open Tailscale and sign in.',
      };
    default:
      return null;
  }
}

/** The steps, in order, as `--check` prints them and as `--enable` performs them. */
export const REMOTE_STEPS = [
  { id: 'installed', title: 'Tailscale installed and signed in on this machine (yours to do, once)' },
  { id: 'server', title: 'The local server is answering, so there is something to expose' },
  { id: 'serve', title: 'Expose it to your tailnet with `tailscale serve` — not funnel, so it stays private' },
  { id: 'url', title: 'Read the machine\'s stable tailnet name back from the CLI and print the URL' },
  { id: 'env', title: 'Set BACKEND_PUBLIC_URL to that URL, so links made without a request stop saying localhost' },
];

/**
 * The tailnet URL, from `tailscale status --json`.
 *
 * `Self.DNSName` is where the CLI reports this machine's MagicDNS name. It arrives as a DNS FQDN with a
 * trailing dot, and `serve` always presents HTTPS, so the URL is `https://<name>` with no port. Returns
 * null when the shape is not what we expect, rather than inventing a URL from it.
 */
export function remoteUrlFromStatus(status) {
  const name = status?.Self?.DNSName;
  if (typeof name !== 'string' || !name.trim()) return null;
  const host = name.trim().replace(/\.$/, '');
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return null;
  return `https://${host}`;
}

/** Is the tailnet side actually up? Checked BEFORE anything is mutated. */
export function tailscaleReady(status) {
  if (!status || typeof status !== 'object') return { ok: false, reason: 'no status from the tailscale CLI' };
  if (status.BackendState && status.BackendState !== 'Running') {
    return { ok: false, reason: `Tailscale reports BackendState "${status.BackendState}" — sign in first (tailscale up)` };
  }
  if (!remoteUrlFromStatus(status)) return { ok: false, reason: 'the CLI did not report a tailnet DNS name for this machine' };
  return { ok: true };
}

/**
 * The commands, built here so the plan and the run cannot disagree. `enable` uses the form current CLIs
 * accept (`serve --bg <port>` proxies http://127.0.0.1:<port>); an older CLI will say so, and that
 * message is shown verbatim rather than swallowed.
 */
export function serveCommands(port) {
  return {
    status: ['tailscale', 'status', '--json'],
    serveStatus: ['tailscale', 'serve', 'status'],
    enable: ['tailscale', 'serve', '--bg', String(port)],
    disable: ['tailscale', 'serve', 'reset'],
    help: ['tailscale', 'serve', '--help'],
  };
}

/** The `.env` line written when remote access is switched on, and the one that turns it back off. */
export function backendPublicUrlLine(url) {
  return `BACKEND_PUBLIC_URL=${url || ''}`;
}

/** What stays true even with remote access working. Printed, and asserted by the guard. */
export const REMOTE_CAVEATS = [
  'Only devices signed in to YOUR tailnet can reach it. That is the point, and also the limit.',
  'Morpheus does not install Tailscale or create the account — a setup script has no business silently installing a VPN.',
  'Google and GitHub sign-in stay off: they need redirect URIs registered against a stable hostname, and a tailnet name is yours, not one we can register.',
];
