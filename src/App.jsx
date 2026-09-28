import { lazy, Suspense, useEffect, useRef } from 'react';
import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, Navigate, useLocation } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import ScrollToTop from './components/ScrollToTop';
import InsufficientCreditsModal from '@/components/matrix/InsufficientCreditsModal';
import RootErrorBoundary from '@/components/RootErrorBoundary';
// Add page imports here
import ProtectedRoute from '@/components/ProtectedRoute';
import MobileTabBar from '@/components/matrix/MobileTabBar';
import Login from '@/pages/Login';
import Register from '@/pages/Register';
import ForgotPassword from '@/pages/ForgotPassword';
import ResetPassword from '@/pages/ResetPassword';
import AuthCallback from '@/pages/AuthCallback';
// Code-split the heavier top-level routes so the mobile WebView boots fast.
const Landing = lazy(() => import('@/pages/Landing'));
const Start = lazy(() => import('@/pages/Start'));
const Begin = lazy(() => import('@/pages/Begin'));
const Workspace = lazy(() => import('@/pages/Workspace'));
const Settings = lazy(() => import('@/pages/Settings'));
const Market = lazy(() => import('@/pages/Market'));
const StoreItem = lazy(() => import('@/pages/StoreItem'));
const Architect = lazy(() => import('@/pages/Architect'));
const PortableMorpheusDownload = lazy(() => import('@/pages/PortableMorpheusDownload'));
const Terms = lazy(() => import('@/pages/Terms'));
const Privacy = lazy(() => import('@/pages/Privacy'));
const RefundPolicy = lazy(() => import('@/pages/RefundPolicy'));
const BackendDocs = lazy(() => import('@/pages/BackendDocs'));
const RebuildBlueprint = lazy(() => import('@/pages/RebuildBlueprint'));
const Screenshots = lazy(() => import('@/pages/Screenshots'));
const UpdatesPlan = lazy(() => import('@/pages/UpdatesPlan'));
const CostTracker = lazy(() => import('@/pages/CostTracker'));
const SelfDev = lazy(() => import('@/pages/SelfDev'));
const ProvingGround = lazy(() => import('@/pages/ProvingGround'));
const AdminPanel = lazy(() => import('@/pages/AdminPanel'));
const Embed = lazy(() => import('@/pages/Embed'));
const AliceStats = lazy(() => import('@/pages/AliceStats'));
const ConnectDevice = lazy(() => import('@/pages/ConnectDevice'));
const CommandDeck = lazy(() => import('@/pages/CommandDeck'));
const DeckHome = lazy(() => import('@/pages/CommandDeck/DeckHome'));
const DeckJarvis = lazy(() => import('@/pages/CommandDeck/DeckJarvis'));
const DeckTools = lazy(() => import('@/pages/CommandDeck/DeckTools'));
const DeckSettings = lazy(() => import('@/pages/CommandDeck/DeckSettings'));
import { HelpModeProvider } from '@/contexts/HelpModeContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { GithubConnectionProvider } from '@/contexts/GithubConnectionContext';
import { GoogleDriveConnectionProvider } from '@/contexts/GoogleDriveConnectionContext';


const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();
  const location = useLocation();
  // The embeddable-widget surface authenticates itself with a widget token
  // (see src/pages/Embed.jsx) — it must never be gated by, or redirected to,
  // the normal user-session login flow, and it has no app chrome.
  const isEmbed = location.pathname === '/embed';
  // Command Deck (Valiant Music's own board, internal codename "Deck") is a
  // self-contained "Tweed & Walnut" themed surface with no Morpheus chrome —
  // same no-tab-bar treatment as /embed.
  const isDeck = location.pathname.startsWith('/deck');

  // Show loading spinner while checking app public settings or auth
  if ((isLoadingPublicSettings || isLoadingAuth) && !isEmbed) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
      </div>
    );
  }

  // Handle authentication errors
  if (authError && !isEmbed) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    } else if (authError.type === 'auth_required') {
      // Redirect to login automatically — but ONLY from somewhere else. Doing
      // this while already on a sign-in page navigates /login to /login
      // forever (see src/lib/authRedirect.js), which is exactly what an expired
      // token used to do: an app that never opens and a form nobody can reach.
      // `navigateToLogin()` now returns without navigating in that case, so
      // falling through renders the login form.
      navigateToLogin();
    }
  }

  // Render the main app
  return (
    <>
      <AnimatedRoutes />
      {!isEmbed && !isDeck && <MobileTabBar />}
    </>
  );
};

// Route outlet with a lightweight CSS fade (see .route-fade in index.css —
// deliberately a plain CSS animation, not framer-motion: a persistent
// composited layer on this fixed scroll container is what reversed typed
// text in the Android WebView IME, so that's staying off the table here).
//
// 2026-09-17 (Rob — "page transitions system wide need to be looked at
// cause its janky as fuck, command colored backgrounds flashing inbetween
// morphus pages"): the fade-in div used to sit OUTSIDE <Suspense>, so it
// mounted (and finished its 180ms animation) immediately regardless of how
// long a lazy chunk took to load. On any not-yet-cached route (Command
// Deck's own sub-routes are separate chunks from the rest of the app, so
// easy to hit uncached) the fade was already done by the time the real
// content replaced the spinner fallback, making that swap an unanimated
// pop. Moved inside <Suspense> so the div — and its fade — only mounts once
// the page has actually resolved, whatever that took. The fallback also now
// has an explicit background instead of being fully transparent, so the
// wait itself is a deliberate, calm frame rather than a bare spinner
// floating on whatever's behind it. A true crossfade (the outgoing page
// fading out under the incoming one, instead of an instant cut) would need
// something that keeps the old page mounted during its own exit — out of
// reach without reintroducing the exact composited-layer risk above, so
// left as a known, scoped-out limitation rather than solved here.
//
// The fade is skipped on the very first mount (initial page load) so the
// destination page shows at full opacity immediately instead of fading up
// from nothing. overflow-x-hidden guards against any fixed-positioned
// background layer pushing the viewport wider on mobile.
function AnimatedRoutes() {
  const location = useLocation();
  const firstRender = useRef(true);
  useEffect(() => { firstRender.current = false; }, []);
  return (
    <Suspense fallback={<div className="fixed inset-0 flex items-center justify-center bg-background"><div className="w-8 h-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>}>
      <div
        key={location.pathname}
        className={`min-h-dvh pb-[3.75rem] md:pb-0 overflow-x-hidden ${firstRender.current ? '' : 'route-fade'}`}
      >
        <Routes location={location}>
          {/* Add your page Route elements here */}
          <Route path="/" element={<Landing />} />
          <Route path="/market" element={<Market />} />
          <Route path="/store/:templateId" element={<StoreItem />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/refund-policy" element={<RefundPolicy />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/embed" element={<Embed />} />
          <Route path="/stats/alice" element={<AliceStats />} />
          {/* Not wrapped in the generic ProtectedRoute group — that redirects to a
              bare /login with no returnTo, which would lose the ?code= a device
              flow needs to survive the login round trip. ConnectDevice checks auth
              itself and preserves the full URL via redirectToLogin. */}
          <Route path="/connect" element={<ConnectDevice />} />
          {/* Same reason as /connect: the generic group redirects to a bare
              /login, and someone who pressed "set up my website" must land back
              on THIS page after signing in, not on the workspace list. Start
              checks auth itself and sends them to /login?returnTo=/start. */}
          <Route path="/start" element={<Start />} />
          {/* The second on-ramp, for a website or web app Morpheus BUILDS,
              rather than a WordPress site it operates. Same reason as /start to
              sit outside the protected group: the button that leads here must
              come back to THIS page after signing in (returnTo=/begin). */}
          <Route path="/begin" element={<Begin />} />
          <Route element={<ProtectedRoute unauthenticatedElement={<Navigate to="/login" replace />} />}>
            <Route path="/workspace" element={<Workspace />} />
            <Route path="/workspace/:projectId" element={<Workspace />} />
            <Route path="/architect" element={<Architect />} />
          <Route path="/portable-morpheus" element={<PortableMorpheusDownload />} />
            <Route path="/settings" element={<Settings />} />
            {/* Command Deck/Jarvis — 2026-09-17: opened up to every signed-in
                account (Rob: "they dont see my command deck, they see their
                own customisable command deck for their life"). The data
                layer was already fully multi-tenant (every Deck* entity is
                scoped by created_by_id through the generic entity engine);
                this was the only real gate left. */}
            <Route path="/deck" element={<CommandDeck />}>
              <Route index element={<DeckHome />} />
              <Route path="jarvis" element={<DeckJarvis />} />
              <Route path="tools" element={<DeckTools />} />
              <Route path="settings" element={<DeckSettings />} />
            </Route>
          </Route>
          <Route element={<ProtectedRoute unauthenticatedElement={<Navigate to="/" replace />} adminOnly />}>
            <Route path="/backend-docs" element={<BackendDocs />} />
            <Route path="/rebuild-blueprint" element={<RebuildBlueprint />} />
            <Route path="/screenshots" element={<Screenshots />} />
            <Route path="/updates-plan" element={<UpdatesPlan />} />
            <Route path="/cost-tracker" element={<CostTracker />} />
            <Route path="/self-dev" element={<SelfDev />} />
            <Route path="/proving-ground" element={<ProvingGround />} />
            <Route path="/admin" element={<AdminPanel />} />
          </Route>
          <Route path="*" element={<PageNotFound />} />
        </Routes>
      </div>
    </Suspense>
  );
}


function App() {
  // Conform to the system color-scheme preference (Android/Web dark mode) by
  // toggling the 'dark' class on <html> whenever the preference changes.
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (e) => {
      document.documentElement.classList.toggle('dark', e.matches);
    };
    apply(mql);
    mql.addEventListener('change', apply);
    return () => mql.removeEventListener('change', apply);
  }, []);

  return (
    <ThemeProvider>
      <AuthProvider>
        <HelpModeProvider>
        <QueryClientProvider client={queryClientInstance}>
          <GithubConnectionProvider>
          <GoogleDriveConnectionProvider>
            <Router>
              <ScrollToTop />
              <RootErrorBoundary>
                <AuthenticatedApp />
              </RootErrorBoundary>
            </Router>
            <Toaster />
            <InsufficientCreditsModal />
          </GoogleDriveConnectionProvider>
          </GithubConnectionProvider>
        </QueryClientProvider>
        </HelpModeProvider>
      </AuthProvider>
    </ThemeProvider>
  )
}

export default App