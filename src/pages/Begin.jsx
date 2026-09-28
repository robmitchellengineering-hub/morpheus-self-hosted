import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, ArrowLeft, ExternalLink, Github, Rocket, Check, Circle, Globe, Server, Database, HelpCircle } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import { useGithubConnection } from '@/hooks/useGithubConnection';
import ConnectionsDialog from '@/components/matrix/ConnectionsDialog';
import { PLATFORMS } from '@/components/matrix/ConnectionsSection';

// /begin — the second on-ramp, beside /start, for someone who wants a website
// or a hosted web app built FOR them rather than a WordPress site operated.
//
// WHY IT IS A PAGE AND NOT A BUTTON: same reason /start is. The link has to be
// openable from the home screen, from a message and on a phone, and the login
// round trip has to come back HERE rather than to the construct list. It also
// has to be the place that guarantees a construct exists, because the whole
// point of the path is that a new account lands somewhere real instead of an
// empty Matrix.
//
// WHAT IT IS HONEST ABOUT, and this is the design constraint rather than a
// disclaimer. Hosting runs on the customer's OWN account with their OWN token:
// Morpheus holds no hosting account, pays for nothing, and takes no custody —
// so the free tier is genuinely free and the site is genuinely theirs. The one
// thing nobody can automate is minting that token (Netlify's token flow is a UI
// action, and any provider that allowed it would still need the user's login),
// so this page detects exactly what is missing, deep-links to the provider's
// own page for that single action, and does everything else itself. One paste,
// once. Saying that plainly is the difference between an onboarding and a
// promise we cannot keep.
//
// WHAT IT ASKS FOR DEPENDS ON WHAT YOU ASKED FOR. The page used to ask everyone
// for the same two connections, which is wrong in both directions: a brochure
// site told to set up a database, or a booking app sent live with nowhere to
// store a booking. The operator describes the thing, the `classify` role decides
// static-or-fullstack and says why (lib/appKind.js), and the connection list
// follows from that. The customer can always overrule the guess — it is a guess,
// and they know their business — which is why the verdict is shown as a sentence
// with two buttons next to it rather than applied silently.
//
// It reuses the construct the WordPress path already opens (ensureWebsiteConstruct
// is idempotent) rather than making a second kind of project: a web-app construct
// is what both paths need, and two would race.

// The token page specifically, with its anchor — the platform registry carries the
// provider's own setup URL, and this is the deeper link for the one action the
// onboarding sends people to do. One constant, so the row and its guard agree.
const NETLIFY_TOKENS_URL = 'https://app.netlify.com/user/applications#personal-access-tokens';

// Label + deep link for a connection the app needs, from the same registry the
// Connections editor renders, so a provider URL exists in exactly one place.
function providerFor(id) {
  if (id === 'netlify') return { label: 'Netlify', url: NETLIFY_TOKENS_URL, host: 'Netlify', icon: Server };
  const p = PLATFORMS.find((x) => x.id === id);
  return {
    label: p?.label || id,
    url: p?.setupUrl || '',
    host: p?.label ? p.label.replace(/\s+/g, '') : id,
    icon: id === 'supabase' || id === 'neon' || id === 'turso' || id === 'planetscale' ? Database : Server,
  };
}

export default function Begin() {
  const navigate = useNavigate();
  const { authChecked, isAuthenticated, navigateToLogin } = useAuth();
  const gh = useGithubConnection();
  const [project, setProject] = useState(null);
  const [projectErr, setProjectErr] = useState(null);
  const [connections, setConnections] = useState({});
  const [showConnections, setShowConnections] = useState(false);
  const [loading, setLoading] = useState(true);

  const [description, setDescription] = useState('');
  const [verdict, setVerdict] = useState(null);   // { kind, reason, needs, fellBack, chosen }
  const [verdictErr, setVerdictErr] = useState(null);
  const [checking, setChecking] = useState(false);

  const loadConnections = useCallback(async () => {
    try {
      const rows = await base44.entities.UserSettings.filter({}, '-updated_date', 1);
      if (rows[0]) {
        try { setConnections(JSON.parse(rows[0].connections || '{}')); } catch { setConnections({}); }
      }
    } catch { /* a settings read must never block the page — "not connected" is honest */ }
  }, []);

  useEffect(() => {
    if (authChecked && !isAuthenticated) {
      navigateToLogin();
      return;
    }
    if (!authChecked) return; // still checking; the spinner below covers it
    (async () => {
      setLoading(true);
      try {
        const { data } = await base44.functions.invoke('ensureWebsiteConstruct', {});
        if (!data?.project) throw new Error('Could not open a construct to build in.');
        setProject(data.project);
      } catch (e) {
        setProjectErr(e?.data?.error || e.message);
      } finally {
        setLoading(false);
      }
      await loadConnections();
    })();
  }, [authChecked, isAuthenticated, navigateToLogin, loadConnections]);

  const checkNeeds = async () => {
    const text = description.trim();
    if (!text || checking) return;
    setChecking(true);
    setVerdictErr(null);
    try {
      const { data } = await base44.functions.invoke('classifyAppKind', { description: text });
      setVerdict(data);
    } catch (e) {
      // A failed classification is recoverable, because the choice is the
      // operator's anyway: say so and offer the two buttons rather than leaving
      // them with an error and no way forward.
      setVerdictErr(e?.data?.error || e.message || 'Could not work that out.');
      setVerdict(null);
    } finally {
      setChecking(false);
    }
  };

  // The operator's own answer wins, and is not re-classified. `reason` stays empty
  // rather than being invented for them.
  const chooseKind = (kind) => {
    setVerdictErr(null);
    setVerdict({
      kind,
      reason: '',
      needs: kind === 'fullstack' ? ['github', 'netlify', 'supabase'] : ['github', 'netlify'],
      fellBack: false,
      chosen: true,
    });
  };

  const isConnected = (id) => {
    const c = connections?.[id];
    return !!(c && Object.values(c).some((v) => v && String(v).trim()));
  };

  const startBuilding = () => {
    if (!project?.id) return;
    navigate(`/workspace/${project.id}`);
  };

  // Until the operator tells us what they are building, ask only for what any site
  // needs. The extra connection appears when there is a reason for it, not before.
  const needs = verdict?.needs || ['github', 'netlify'];

  const steps = [
    {
      key: 'github',
      done: gh.connected,
      icon: Github,
      title: gh.connected ? `GitHub connected${gh.login ? ` as ${gh.login}` : ''}` : 'Connect GitHub',
      body: gh.connected
        ? 'Morpheus pushes your code to your own repo and GitHub builds it — on your free Actions minutes.'
        : 'Your code lives in your own repo, and GitHub builds it for free. Signing in takes one tap; there is nothing to paste.',
      action: gh.connected ? null : { label: 'CONNECT', onClick: () => gh.connect && gh.connect() },
    },
    ...needs.filter((id) => id !== 'github').map((id) => {
      const p = providerFor(id);
      const done = isConnected(id);
      const isDb = p.icon === Database;
      return {
        key: id,
        done,
        icon: p.icon,
        title: done ? `${p.label} connected` : isDb ? `Connect a database (${p.label})` : `Connect hosting (${p.label})`,
        body: (
          <>
            {done
              ? (isDb
                ? `${p.label} holds your app's data, on your own account. Morpheus never stores it for you.`
                : `Your site goes live on your own ${p.label} account with a free subdomain — Morpheus never holds the account or pays for it.`)
              : (isDb
                ? 'Your app needs somewhere to keep its data. '
                : 'A free subdomain on your own account, so the site is yours and stays yours. ')}
            {!done && p.url && (
              <>
                Create a token at{' '}
                <a href={p.url} target="_blank" rel="noreferrer" className="underline hover:text-primary">
                  {p.host} <ExternalLink size={9} className="inline" />
                </a>
                , then paste it here. It is encrypted at rest.
              </>
            )}
          </>
        ),
        action: done ? null : { label: 'PASTE IT', onClick: () => setShowConnections(true) },
      };
    }),
    {
      key: 'build',
      done: false,
      icon: Rocket,
      title: 'Describe what you want',
      body: 'Say what the site or app should do. Morpheus plans it, writes it, and shows you the result before anything ships.',
      action: project?.id ? { label: 'START', onClick: startBuilding } : null,
    },
  ];

  const remaining = steps.filter((s) => !s.done).length;

  return (
    <div className="min-h-dvh bg-background text-ink font-mono safe-px">
      <div className="max-w-md mx-auto min-h-dvh flex flex-col border-x border-primary/15">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/20 shrink-0">
          <button onClick={() => navigate(project ? `/workspace/${project.id}` : '/')}
            className="text-primary/50 hover:text-primary" title="Back">
            <ArrowLeft size={16} />
          </button>
          <Globe size={15} className="text-primary" />
          <span className="font-display tracking-wider text-[13px] truncate">BUILD A WEBSITE OR WEB APP</span>
        </div>

        <p className="px-4 pt-4 text-[11px] text-ink-max leading-relaxed">
          Morpheus builds it and takes it live on your own free accounts. Nothing to install, and no Morpheus
          account beyond the one you are signed in with.
        </p>

        {projectErr && (
          <div className="mx-4 mt-3 text-red-400 text-[11px] border border-red-500/30 px-3 py-2">
            {projectErr} You can still connect the pieces below.
          </div>
        )}

        {/* What it needs — asked first, because it decides what to ask for next. */}
        <div className="px-4 pt-4">
          <label className="text-[10px] text-primary/50 uppercase tracking-wider">What should it do?</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="e.g. a booking page for my dog grooming business"
            className="w-full mt-1 bg-transparent border border-primary/30 text-ink-strong px-3 py-2 outline-none focus:border-primary text-[12px] resize-none"
          />
          <button onClick={checkNeeds} disabled={!description.trim() || checking}
            className="mt-2 w-full py-2 border border-primary/60 text-primary hover:bg-primary hover:text-black disabled:opacity-30 transition-colors text-[12px] tracking-wider flex items-center justify-center gap-2">
            {checking ? <><Loader2 size={13} className="animate-spin" /> WORKING IT OUT</> : <>WHAT DOES IT NEED?</>}
          </button>

          {verdict && (
            <div className="mt-3 border border-primary/25 px-3 py-3">
              <div className="text-[12px] text-ink-strong">
                {verdict.kind === 'fullstack'
                  ? 'This needs a backend — somewhere to keep data.'
                  : 'This is a static website — no database needed.'}
              </div>
              {verdict.reason && (
                <div className="text-[10px] text-ink-max leading-relaxed mt-1">{verdict.reason}</div>
              )}
              {verdict.fellBack && (
                <div className="text-[10px] text-ink-max leading-relaxed mt-1">
                  I could not tell from that description — pick the one you want.
                </div>
              )}
              <div className="flex items-center gap-2 mt-2">
                <button onClick={() => chooseKind('static')}
                  className="text-[10px] px-2.5 py-1.5 border border-primary/40 text-primary/80 hover:border-primary hover:text-primary transition-colors">
                  It's just a website
                </button>
                <button onClick={() => chooseKind('fullstack')}
                  className="text-[10px] px-2.5 py-1.5 border border-primary/40 text-primary/80 hover:border-primary hover:text-primary transition-colors">
                  It needs a backend
                </button>
              </div>
            </div>
          )}
          {verdictErr && (
            <div className="mt-2 text-[10px] text-ink-max leading-relaxed flex items-start gap-1.5">
              <HelpCircle size={11} className="shrink-0 mt-[1px] text-primary/60" />
              <span>
                {verdictErr} You can just pick one:{' '}
                <button onClick={() => chooseKind('static')} className="underline hover:text-primary">a website</button>
                {' or '}
                <button onClick={() => chooseKind('fullstack')} className="underline hover:text-primary">one with a backend</button>.
              </span>
            </div>
          )}
        </div>

        <div className="px-4 py-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-display tracking-wider text-primary">
              {loading ? 'GETTING SET UP' : `GET SET UP · ${remaining} to go`}
            </span>
            {loading && <Loader2 size={12} className="animate-spin text-primary/60" />}
          </div>

          {steps.map((s) => {
            const Icon = s.icon;
            return (
              <div key={s.key} className="flex items-start gap-2.5 border border-primary/15 px-3 py-3">
                <span className="shrink-0 mt-[2px] text-ink">
                  {s.done ? <Check size={14} /> : <Circle size={14} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] text-ink-strong">{s.title}</div>
                  <div className="text-[10px] text-ink-max leading-relaxed mt-1">{s.body}</div>
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

          <button onClick={startBuilding} disabled={!project?.id}
            className="w-full py-2.5 border border-primary text-primary hover:bg-primary hover:text-black disabled:opacity-30 transition-colors font-bold text-sm tracking-wider">
            START BUILDING
          </button>
          <p className="text-[10px] text-ink-max leading-relaxed">
            Every connection is a free tier on an account you own. Morpheus facilitates and never takes custody of
            your code, your site or your credentials.
          </p>
        </div>

        <div className="mt-auto px-4 py-3 border-t border-primary/15 flex items-center justify-between gap-2">
          <button onClick={() => navigate('/start')} className="text-[10px] text-primary/45 hover:text-primary">
            I have a WordPress site instead
          </button>
          <a href="https://morpheus.nz" target="_blank" rel="noreferrer"
            className="text-[10px] text-primary/30 hover:text-primary/60 flex items-center gap-1">
            morpheus.nz <ExternalLink size={9} />
          </a>
        </div>
      </div>

      <ConnectionsDialog open={showConnections} onClose={() => { setShowConnections(false); loadConnections(); }} />
    </div>
  );
}
