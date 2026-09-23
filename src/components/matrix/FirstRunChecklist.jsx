import { useState, useEffect } from 'react';
import { Check, Circle, Github, Globe, GitBranch, MessageSquare, X, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useGithubConnection } from '@/hooks/useGithubConnection';

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
  // The working copy is what `github_repo` means on a project: the repo was
  // created from (or chosen for) this site's theme.
  const steps = [
    {
      key: 'github',
      done: githubConnected,
      icon: Github,
      title: githubConnected ? `GitHub connected${login ? ` as ${login}` : ''}` : 'Connect GitHub',
      body: githubConnected
        ? 'Your code and builds live in your own account.'
        : 'Morpheus pushes to your repos using your free GitHub Actions minutes, and keeps your code yours.',
      action: githubConnected ? null : { label: 'CONNECT', onClick: onOpenConnections },
    },
    {
      key: 'site',
      done: siteConnected,
      icon: Globe,
      title: siteConnected ? `Website connected — ${String(site.siteUrl || '').replace(/^https?:\/\//, '')}` : 'Connect your WordPress site',
      body: siteConnected
        ? `Running plugin v${site.version || '?'}. Deploy, Shop, Pages and SEO work from here now.`
        : 'One small plugin, then Morpheus can deploy code, run your shop, manage content and own your SEO — from your phone.',
      action: siteConnected ? null : { label: 'SET UP', onClick: onOpenWebsite },
    },
    {
      key: 'copy',
      done: hasRepo,
      icon: GitBranch,
      title: hasRepo ? `Working copy in ${project.github_repo}` : 'Make a working copy',
      body: hasRepo
        ? 'Changes go to the repo, then to your site through a pull request.'
        : 'If your theme is not in a repo yet, Morpheus can copy it into a private one so you can start shipping changes.',
      action: hasRepo ? null : { label: 'CREATE IT', onClick: onOpenWebsite },
    },
    {
      key: 'change',
      done: false,
      icon: MessageSquare,
      title: 'Ask for a change',
      body: 'Describe what you want different and Morpheus plans it, writes it, and shows you the result before anything ships.',
      action: { label: 'START', onClick: onStartChat },
    },
  ];

  const remaining = steps.filter((s) => !s.done).length;
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
              <span className={`shrink-0 mt-[3px] ${s.done ? 'text-ink' : 'text-ink'}`}>
                {s.done ? <Check size={13} /> : <Circle size={13} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className={`text-[11px] ${s.done ? 'text-ink-max' : 'text-ink-max'}`}>{s.title}</div>
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
