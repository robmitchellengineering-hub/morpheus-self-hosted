import { useState, useEffect, useCallback } from 'react';
import { Check, Circle, Github, Globe, GitBranch, MessageSquare, X, Loader2, Server } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useGithubConnection } from '@/hooks/useGithubConnection';
import { checklistRows, isOptionalRow, remainingCount } from '@/lib/onrampChecklist';

// FIRST-RUN CHECKLIST — what to do next, in the construct the operator just
// landed in.
//
// WHY THIS EXISTS: the website flow opens a construct so a new account is
// somewhere real rather than an empty list — but a construct with no files,
// no repo and no connected site looks like a wall if you don't already know
// the order things have to happen in. This is that order, with the state of
// each step read from the system rather than assumed, and every row a link to
// the thing that does it.
//
// TWO PATHS, and this is the 2026-09-28 correction. There are now two ways into
// a web-app construct: /start, for a WordPress site someone already runs, and
// /begin, for a website or web app Morpheus is going to BUILD. This component
// used to show the WordPress rows to both, so someone who had just pressed
// "build a website" was told to install a WordPress plugin — the same
// conflation Rob asked to have removed from the landing page, still sitting
// inside the construct. The rows are now chosen from what the construct
// actually IS (is a WordPress site connected?) rather than from an assumption:
//   * a connected WordPress site  → the WordPress steps, exactly as before;
//   * anything else               → the build-and-host steps, with the
//     WordPress path kept as an explicitly OPTIONAL row so it stays findable
//     without being the instruction someone gets by default.
// Optional rows are excluded from the "N to go" count and cannot keep the
// checklist alive on their own — otherwise "done" would mean "you dismissed the
// thing you were never asked to do".
//
// It disappears when there is nothing left to do, and can be dismissed for a
// construct (remembered per construct, so it doesn't nag someone who has read
// it). Deliberately NOT a wizard: nothing is blocked on these steps, and
// someone who came here to write code should be able to ignore all of it.

const DISMISS_KEY = 'morpheus_firstrun_dismissed';

function loadDismissed() {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export default function FirstRunChecklist({ project, onOpenWebsite, onOpenConnections, onStartChat }) {
  const { connected: githubConnected, login } = useGithubConnection();
  const [site, setSite] = useState(null);      // { connected, siteUrl, version }
  const [loadingSite, setLoadingSite] = useState(true);
  const [hostingConnected, setHostingConnected] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const projectId = project?.id;
  const hasRepo = !!project?.github_repo;

  useEffect(() => {
    if (projectId) setDismissed(!!loadDismissed()[projectId]);
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      setLoadingSite(true);
      try {
        const { data } = await base44.functions.invoke('getWordPressStore', { projectId });
        if (!cancelled) setSite(data || { connected: false });
      } catch {
        if (!cancelled) setSite({ connected: false });
      } finally {
        if (!cancelled) setLoadingSite(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  // The same read /begin performs, so the construct and the on-ramp can never
  // disagree about whether hosting is connected. Netlify's token is what "can
  // this go live" means today; `decodeConnections` runs server-side in the
  // entity route, so this is the decoded object.
  const loadHosting = useCallback(async () => {
    try {
      const rows = await base44.entities.UserSettings.filter({}, '-updated_date', 1);
      const conns = rows?.[0] ? JSON.parse(rows[0].connections || '{}') : {};
      setHostingConnected(!!(conns?.netlify?.token && String(conns.netlify.token).trim()));
    } catch { /* a settings read must never block the checklist — "not connected" is the honest default */ }
  }, []);

  useEffect(() => {
    loadHosting();
    // The token is pasted in a dialog owned by the Workspace, so this component
    // cannot be told when it closes. Re-reading on focus covers the real gesture
    // (go to Netlify in another tab, come back) without inventing a prop that
    // only this caller would ever pass.
    const onFocus = () => loadHosting();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadHosting]);

  const dismiss = () => {
    setDismissed(true);
    try {
      const all = loadDismissed();
      all[projectId] = true;
      localStorage.setItem(DISMISS_KEY, JSON.stringify(all));
    } catch { /* dismissing is a nicety; a full storage must not break the page */ }
  };

  if (!project || dismissed) return null;

  const siteConnected = !!site?.connected;

  // What each row looks like. Which of them render, and which count towards
  // "N to go", is decided by lib/onrampChecklist.js so the rule can be tested
  // without a browser.
  const rowFor = {
    github: {
      key: 'github',
      done: githubConnected,
      icon: Github,
      title: githubConnected ? `GitHub connected${login ? ` as ${login}` : ''}` : 'Connect GitHub',
      body: githubConnected
        ? 'Your code and builds live in your own account.'
        : 'Morpheus pushes to your repos using your free GitHub Actions minutes, and keeps your code yours.',
      action: githubConnected ? null : { label: 'CONNECT', onClick: onOpenConnections },
    },
    // The WordPress rows — a connected site, then its working copy. `github_repo`
    // on a project means the repo was created from (or chosen for) this site's theme.
    site: {
      key: 'site',
      done: true,
      icon: Globe,
      title: `Website connected — ${String(site?.siteUrl || '').replace(/^https?:\/\//, '')}`,
      body: `Running plugin v${site?.version || '?'}. Deploy, Shop, Pages and SEO work from here now.`,
      action: null,
    },
    copy: {
      key: 'copy',
      done: hasRepo,
      icon: GitBranch,
      title: hasRepo ? `Working copy in ${project.github_repo}` : 'Make a working copy',
      body: hasRepo
        ? 'Changes go to the repo, then to your site through a pull request.'
        : 'If your theme is not in a repo yet, Morpheus can copy it into a private one so you can start shipping changes.',
      action: hasRepo ? null : { label: 'CREATE IT', onClick: onOpenWebsite },
    },
    // The build path's rows. Hosting is the customer's own Netlify account with
    // their own token — see /begin, which reads the same state so the two cannot
    // disagree about whether a site can go live.
    hosting: {
      key: 'hosting',
      done: hostingConnected,
      icon: Server,
      title: hostingConnected ? 'Hosting connected' : 'Connect hosting (Netlify)',
      body: hostingConnected
        ? 'Your site goes live on your own Netlify account with a free subdomain. Nothing is hosted by Morpheus.'
        : 'A free subdomain on your own Netlify account, so the site is yours. One token, one paste — encrypted at rest.',
      action: hostingConnected ? null : { label: 'CONNECT', onClick: onOpenConnections },
    },
    wordpress: {
      key: 'wordpress',
      done: false,
      icon: Globe,
      title: 'Running a WordPress site?',
      body: 'That is the other path: connect it and Morpheus operates the deploys, the shop, the content and the SEO.',
      action: { label: 'SET UP', onClick: onOpenWebsite },
    },
    change: {
      key: 'change',
      done: false,
      icon: MessageSquare,
      title: 'Ask for a change',
      // The last mile, said out loud — see the same sentence in /begin. COMPILE and
      // TAKE IT LIVE are the real control labels, and a first-time user cannot guess
      // that those two presses are what turns a construct into a live URL.
      body: 'Describe what you want different and Morpheus plans it, writes it, and shows you the result before anything ships. When it looks right, press COMPILE, then TAKE IT LIVE — that publishes it to your own hosting and gives you the URL.',
      action: { label: 'START', onClick: onStartChat },
    },
  };

  const rowKeys = checklistRows({ loadingSite, siteConnected });
  const steps = rowKeys.map((k) => ({ ...rowFor[k], optional: isOptionalRow(k) })).filter((s) => s.key);
  const remaining = remainingCount(rowKeys, Object.fromEntries(steps.map((s) => [s.key, s.done])));

  // Nothing left but "ask for a change" — the construct is set up, so the
  // checklist has done its job and gets out of the way.
  if (remaining <= 1 && !loadingSite) return null;

  return (
    <div className="border-b border-primary/20 bg-primary/[0.03] shrink-0">
      <div className="px-4 py-3 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-display tracking-wider text-primary">
            GET SET UP{loadingSite ? '' : ` · ${remaining} to go`}
          </span>
          <button onClick={dismiss} className="text-primary/40 hover:text-primary p-1" title="Hide this">
            <X size={14} />
          </button>
        </div>

        {steps.map((s) => {
          const Icon = s.icon;
          return (
            <div key={s.key} className="flex items-start gap-2.5">
              <span className="shrink-0 mt-[3px] text-ink">
                {s.done ? <Check size={13} /> : <Circle size={13} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-ink-max">
                  {s.title}
                  {s.optional && <span className="text-ink-max"> · optional</span>}
                </div>
                {!s.done && <div className="text-[10px] text-ink-max leading-relaxed mt-0.5">{s.body}</div>}
              </div>
              {s.action && (
                <button onClick={s.action.onClick}
                  className="shrink-0 text-[10px] px-2.5 py-1.5 border border-primary/50 text-primary hover:bg-primary hover:text-black transition-colors flex items-center gap-1">
                  <Icon size={10} /> {s.action.label}
                </button>
              )}
            </div>
          );
        })}

        {loadingSite && (
          <div className="text-[10px] text-ink-max flex items-center gap-1.5">
            <Loader2 size={10} className="animate-spin" /> checking your site…
          </div>
        )}
      </div>
    </div>
  );
}
