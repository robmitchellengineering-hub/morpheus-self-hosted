import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Globe, ArrowLeft, ExternalLink, RefreshCw } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import SetupTab from '@/components/matrix/website/SetupTab';

// /start — the WordPress onboarding, as a place rather than a hidden drawer.
//
// WHY A ROUTE: this is the link handed to someone who has just bought into
// "Morpheus runs my WordPress site". It has to be openable from the home
// screen, from the construct list, from a message, and on a phone — and the
// WEBSITE panel is a side drawer designed for someone already inside a
// construct. So the flow gets its own page, reusing the same wizard component
// the panel uses, so the two can never drift.
//
// It ensures a WEBSITE construct exists (ensureWebsiteConstruct), because the
// WEBSITE panel is gated on the web-app compile target — landing here without
// one would show the operator a project where none of the website controls
// exist. Connecting a site, then making the GitHub working copy, then getting
// out of the way: everything after the first connection is the same panel.

export default function Start() {
  const navigate = useNavigate();
  // Outside the generic protected group (see App.jsx) so the returnTo survives
  // the login round trip: someone who pressed "set up my website" comes back
  // HERE, not to the construct list.
  const { authChecked, isAuthenticated, navigateToLogin } = useAuth();
  const [project, setProject] = useState(null);
  const [store, setStore] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const loadStore = useCallback(async (projectId) => {
    try {
      const { data } = await base44.functions.invoke('getWordPressStore', { projectId });
      setStore(data);
      return data;
    } catch (e) {
      setErr(e?.data?.error || e.message);
      return null;
    }
  }, []);

  useEffect(() => {
    if (authChecked && !isAuthenticated) {
      navigateToLogin();
      return;
    }
    if (!authChecked) return; // still checking; the spinner below covers it
    (async () => {
      setLoading(true); setErr(null);
      try {
        const { data } = await base44.functions.invoke('ensureWebsiteConstruct', {});
        if (!data?.project) throw new Error('Could not open a website construct.');
        setProject(data.project);
        await loadStore(data.project.id);
      } catch (e) {
        setErr(e?.data?.error || e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [authChecked, isAuthenticated, navigateToLogin, loadStore]);

  return (
    <div className="min-h-dvh bg-background text-primary font-mono safe-px">
      <div className="max-w-md mx-auto min-h-dvh flex flex-col border-x border-primary/15">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/20 shrink-0">
          <button onClick={() => navigate(project ? `/workspace/${project.id}` : '/workspace')}
            className="text-primary/50 hover:text-primary" title="Back">
            <ArrowLeft size={16} />
          </button>
          <Globe size={15} className="text-primary" />
          <span className="font-display tracking-wider text-[13px] truncate">
            {project ? project.name : 'Set up your website'}
          </span>
          {project && (
            <button onClick={() => { setStore(null); loadStore(project.id); }}
              className="ml-auto text-primary/40 hover:text-primary" title="Check the connection again">
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>
          )}
        </div>

        {loading && !project && (
          <div className="p-6 flex items-center gap-2 text-primary/60 text-xs">
            <Loader2 size={14} className="animate-spin" /> Opening your website construct…
          </div>
        )}

        {err && (
          <div className="m-4 text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>
        )}

        {project && !loading && (
          <>
            <p className="px-4 pt-4 text-[11px] text-primary/50 leading-relaxed">
              This is where Morpheus takes over the running of your WordPress site — deploys, products, content and SEO,
              from here and from your phone. Nothing is changed on your site until you publish something.
            </p>
            <div className="flex-1 min-h-0 pt-2">
              <SetupTab
                store={store}
                projectId={project.id}
                onChanged={async () => { await loadStore(project.id); }}
              />
            </div>
            <div className="px-4 py-3 border-t border-primary/15 shrink-0 flex items-center justify-between gap-2">
              <button onClick={() => navigate(`/workspace/${project.id}`)}
                className="text-[10px] text-primary/45 hover:text-primary">
                open the full construct
              </button>
              <a href="https://morpheus.nz" target="_blank" rel="noreferrer"
                className="text-[10px] text-primary/30 hover:text-primary/60 flex items-center gap-1">
                morpheus.nz <ExternalLink size={9} />
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
