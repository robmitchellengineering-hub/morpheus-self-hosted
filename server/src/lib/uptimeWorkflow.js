// Uptime monitoring (2026-09-09) — a scheduled GitHub Action that lives in
// the operator's own repo. It pings the production URL on a cron and opens
// (then auto-closes) a GitHub issue when the site is down. ZERO INFRA on
// Morpheus's side: no polling, no cron, no stored state — the check runs on
// GitHub's runners against the operator's repo, using only first-party
// actions (checkout isn't even needed — just github-script).

export const UPTIME_PATH = '.github/workflows/morpheus-uptime.yml';

export const UPTIME_INTERVALS = [15, 30, 60];

export function cronFor(minutes) {
  const m = UPTIME_INTERVALS.includes(minutes) ? minutes : 15;
  if (m === 60) return '0 * * * *';
  return `*/${m} * * * *`;
}

// Pull the watched URL + interval back out of an existing workflow file so
// the panel can show what's configured.
export function parseUptimeWorkflow(yaml) {
  if (typeof yaml !== 'string') return null;
  const url = yaml.match(/TARGET_URL:\s*'([^']+)'/)?.[1] || null;
  const cron = yaml.match(/cron:\s*'([^']+)'/)?.[1] || null;
  let intervalMinutes = null;
  if (cron === '0 * * * *') intervalMinutes = 60;
  else {
    const m = cron?.match(/^\*\/(\d+) /);
    if (m) intervalMinutes = Number(m[1]);
  }
  return { url, cron, intervalMinutes };
}

// `url` must be a full https URL. Produces a self-contained workflow file.
export function uptimeWorkflowYaml(url, minutes = 15) {
  const cron = cronFor(minutes);
  const safeUrl = String(url).replace(/["\n\r]/g, '');
  return `# Managed by Morpheus — uptime check for ${safeUrl}
# Runs on GitHub's schedule (every ~${UPTIME_INTERVALS.includes(minutes) ? minutes : 15} min, best effort). Opens an issue
# labelled "uptime" when the site is down and closes it when it recovers.
# Delete this file to stop monitoring.
name: Morpheus uptime
on:
  schedule:
    - cron: '${cron}'
  workflow_dispatch: {}
permissions:
  issues: write
concurrency:
  group: morpheus-uptime
  cancel-in-progress: true
jobs:
  check:
    runs-on: ubuntu-latest
    env:
      TARGET_URL: '${safeUrl}'
    steps:
      - name: Ping the site
        id: ping
        run: |
          code=$(curl -sS -o /dev/null -w '%{http_code}' -L --max-time 30 --retry 2 "$TARGET_URL" || echo 000)
          echo "code=$code" >> "$GITHUB_OUTPUT"
          if [ "$code" -ge 200 ] && [ "$code" -lt 400 ]; then
            echo "up=true" >> "$GITHUB_OUTPUT"
          else
            echo "up=false" >> "$GITHUB_OUTPUT"
          fi
      - name: Open or close the incident issue
        uses: actions/github-script@v7
        env:
          UP: \${{ steps.ping.outputs.up }}
          CODE: \${{ steps.ping.outputs.code }}
        with:
          script: |
            const up = process.env.UP === 'true';
            const code = process.env.CODE;
            const url = process.env.TARGET_URL;
            const { owner, repo } = context.repo;
            const label = 'uptime';
            const existing = await github.rest.issues.listForRepo({ owner, repo, state: 'open', labels: label, per_page: 1 });
            const open = existing.data[0];
            const now = new Date().toISOString();
            if (!up && !open) {
              await github.rest.issues.create({
                owner, repo,
                title: \`🔴 \${url} is down (HTTP \${code})\`,
                body: \`The scheduled uptime check got **HTTP \${code}** from \${url} at \${now}.\\n\\nThis issue will close automatically when the next check succeeds.\`,
                labels: [label],
              });
            } else if (up && open) {
              await github.rest.issues.createComment({ owner, repo, issue_number: open.number, body: \`✅ Recovered — HTTP \${code} at \${now}.\` });
              await github.rest.issues.update({ owner, repo, issue_number: open.number, state: 'closed' });
            }
`;
}
