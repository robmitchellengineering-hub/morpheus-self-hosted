import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { ghHeaders, ghJson } from '../../shared/githubPush.ts';
import { getAppUserGithubToken } from '../../shared/githubConnection.ts';
import { getCompileTarget } from '../../shared/compile-targets/index.ts';

const GH_API = 'https://api.github.com';

// Default error patterns — used when no adapter-specific patterns are available.
const DEFAULT_ERROR_PATTERNS = /\b(error|ERROR|Error|failed|FAILED|Failed|exception|Exception|fatal|FATAL|cannot|Cannot|undefined|not found|No such file|permission denied|command not found|exited with code|BUILD FAILED|FAILURE:|BackendException|IR lowering|FunctionCodegen|CodegenUtil|Task :.*:FAILED|Command CodeSign failed|xcodebuild|swift build failed)\b/;
const NOISE_PATTERNS = /(Unzipping|Downloading|Installing|Extracting|Progress|^\s*\[=|^\s*\]|sdkmanager|licenses|terms|agreement|governing law|Controlling Law|Pre-Release|Evaluation|release-notes|highlights of this release)/;

// Extract error-relevant lines from a GitHub Actions log.
// The actual build error is rarely at the very end — the tail is usually
// post-job cleanup. Instead, find lines matching error/failure patterns
// and include surrounding context lines so the AI has the real error.
// If the compile target's adapter declares its own errorPatterns, use those
// (they're more precise than the generic catch-all).
function extractErrorContext(fullLog: string, errorPatterns?: RegExp[]): string {
  const lines = fullLog.split('\n');
  const patterns = (errorPatterns && errorPatterns.length > 0) ? errorPatterns : [DEFAULT_ERROR_PATTERNS];

  const errorLineIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (patterns.some(p => p.test(lines[i])) && !NOISE_PATTERNS.test(lines[i])) {
      errorLineIdxs.push(i);
    }
  }

  if (errorLineIdxs.length === 0) {
    // No error lines found — fall back to the tail
    return fullLog.length > 10000 ? fullLog.slice(-10000) : fullLog;
  }

  // Build context windows around each error line (3 lines before/after)
  const contextRanges: Array<[number, number]> = [];
  for (const idx of errorLineIdxs) {
    const start = Math.max(0, idx - 3);
    const end = Math.min(lines.length - 1, idx + 3);
    // Merge with previous range if overlapping
    if (contextRanges.length > 0 && start <= contextRanges[contextRanges.length - 1][1] + 1) {
      contextRanges[contextRanges.length - 1][1] = Math.max(contextRanges[contextRanges.length - 1][1], end);
    } else {
      contextRanges.push([start, end]);
    }
  }

  let result = '';
  for (const [start, end] of contextRanges) {
    result += lines.slice(start, end + 1).join('\n') + '\n...\n';
    if (result.length > 10000) break;
  }
  return result.substring(0, 10000);
}

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { repoFullName, target } = body;
    if (!repoFullName) return Response.json({ error: 'repoFullName required' }, { status: 400 });

    // Look up the adapter's error patterns for target-specific log filtering.
    // Falls back to the generic patterns if no adapter or no errorPatterns.
    const adapter = target ? getCompileTarget(target) : null;
    const adapterErrorPatterns = adapter?.errorPatterns;

    let accessToken;
    try {
      accessToken = await getAppUserGithubToken(base44);
    } catch (e) {
      return Response.json({ error: e.message }, { status: 400 });
    }
    const h = ghHeaders(accessToken);

    // Get latest workflow run
    const runsRes = await fetch(`${GH_API}/repos/${repoFullName}/actions/runs?per_page=1`, { headers: h });
    const runsData = await ghJson(runsRes);
    const latestRun = runsData.workflow_runs?.[0];

    if (!latestRun) {
      return Response.json({ status: 'queued', message: 'Build queued...' });
    }

    const runStatus = latestRun.status;
    const runConclusion = latestRun.conclusion;

    let message = 'Build queued...';
    if (runStatus === 'in_progress') message = 'Compiling on GitHub Actions...';
    else if (runStatus === 'completed' && runConclusion === 'success') message = 'Build complete!';
    else if (runStatus === 'completed' && runConclusion !== 'success') message = 'Build failed';

    const result: any = {
      status: runStatus,
      conclusion: runConclusion,
      runUrl: latestRun.html_url,
      message
    };

    // Fetch step-level progress while the build is running, so the UI can
    // show a "step 4/13" counter and the name of the step currently executing.
    if (runStatus === 'in_progress' || runStatus === 'queued') {
      try {
        const jobsRes = await fetch(`${GH_API}/repos/${repoFullName}/actions/runs/${latestRun.id}/jobs`, { headers: h });
        const jobsData = await ghJson(jobsRes);
        const job = jobsData.jobs?.[0];
        if (job && job.steps && job.steps.length > 0) {
          const steps = job.steps;
          const completedSteps = steps.filter((s: any) => s.conclusion).length;
          const totalSteps = steps.length;
          const currentStep = steps.find((s: any) => !s.conclusion && s.status === 'in_progress');
          const failedStep = steps.find((s: any) => s.conclusion === 'failure');
          result.stepProgress = {
            completed: completedSteps,
            total: totalSteps,
            currentStep: currentStep?.name || (failedStep ? `Failed: ${failedStep.name}` : 'Queued...')
          };
        }
      } catch (stepErr) {
        console.error('Failed to fetch job steps:', stepErr?.message || stepErr);
      }
    }

    // If the build failed, fetch the actual job logs so the AI fixer has real
    // error output to diagnose. GitHub returns logs as a redirect to a text file.
    if (runStatus === 'completed' && runConclusion && runConclusion !== 'success') {
      try {
        const jobsRes = await fetch(`${GH_API}/repos/${repoFullName}/actions/runs/${latestRun.id}/jobs`, { headers: h });
        const jobsData = await ghJson(jobsRes);
        const failedJobs = (jobsData.jobs || []).filter((j: any) => j.conclusion && j.conclusion !== 'success');
        if (failedJobs.length > 0) {
          const jobLogs = await Promise.all(failedJobs.slice(0, 3).map(async (job: any) => {
            try {
              const logRes = await fetch(`${GH_API}/repos/${repoFullName}/actions/jobs/${job.id}/logs`, { headers: h, redirect: 'follow' });
              if (logRes.ok) {
                const text = await logRes.text();
                return { job: job.name, log: extractErrorContext(text, adapterErrorPatterns) };
              }
              return { job: job.name, log: `[Log fetch failed: HTTP ${logRes.status}]` };
            } catch (e) {
              return { job: job.name, log: `[Log fetch error: ${e.message}]` };
            }
          }));
          result.logs = jobLogs.filter(Boolean);
        } else {
          // No failed jobs found — fall back to the run-level logs zip endpoint
          try {
            const runLogsRes = await fetch(`${GH_API}/repos/${repoFullName}/actions/runs/${latestRun.id}/logs`, { headers: h, redirect: 'follow' });
            if (runLogsRes.ok) {
              const text = await runLogsRes.text();
              const trimmed = text.length > 10000 ? text.slice(-10000) : text;
              result.logs = [{ job: 'workflow', log: trimmed }];
            }
          } catch (e) {
            console.error('Run-level logs fallback failed:', e?.message || e);
          }
        }
      } catch (logErr) {
        console.error('Failed to fetch job logs:', logErr?.message || logErr);
      }
    }

    // If completed successfully, fetch the release. Retry a few times — GitHub
    // sometimes marks a run complete a moment before the release API indexes it.
    if (runStatus === 'completed' && runConclusion === 'success') {
      for (let attempt = 0; attempt < 4; attempt++) {
        const releaseRes = await fetch(`${GH_API}/repos/${repoFullName}/releases/latest`, { headers: h });
        if (releaseRes.ok) {
          const release = await ghJson(releaseRes);
          if (release && release.assets && release.assets.length > 0) {
            result.releaseUrl = release.html_url;
            result.assets = release.assets.map((a: any) => ({
              name: a.name,
              downloadUrl: a.browser_download_url,
              size: a.size
            }));
            break;
          }
        }
        await new Promise(r => setTimeout(r, 2000));
      }
      if (!result.assets) {
        result.assets = [];
        result.message = 'Build succeeded but no downloadable artifact was published.';
      }
    }

    return Response.json(result);
  } catch (error) {
    console.error('Compile status error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
}