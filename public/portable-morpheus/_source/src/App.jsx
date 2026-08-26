import { lazy, Suspense, useEffect } from 'react';
import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes, Navigate, useLocation } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import ScrollToTop from './components/ScrollToTop';
// Add page imports here
import ProtectedRoute from '@/components/ProtectedRoute';
import { AnimatePresence, motion } from 'framer-motion';
import MobileTabBar from '@/components/matrix/MobileTabBar';
import Login from '@/pages/Login';
import Register from '@/pages/Register';
import ForgotPassword from '@/pages/ForgotPassword';
import ResetPassword from '@/pages/ResetPassword';
// Code-split the heavier top-level routes so the mobile WebView boots fast.
const Landing = lazy(() => import('@/pages/Landing'));
const Workspace = lazy(() => import('@/pages/Workspace'));
const Settings = lazy(() => import('@/pages/Settings'));
const Market = lazy(() => import('@/pages/Market'));
const StoreItem = lazy(() => import('@/pages/StoreItem'));
const Architect = lazy(() => import('@/pages/Architect'));
const PortableMorpheusDownload = lazy(() => import('@/pages/PortableMorpheusDownload'));
import { HelpModeProvider } from '@/contexts/HelpModeContext';


const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();

  // Show loading spinner while checking app public settings or auth
  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
      </div>
    );
  }

  // Handle authentication errors
  if (authError) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    } else if (authError.type === 'auth_required') {
      // Redirect to login automatically
      navigateToLogin();
      return null;
    }
  }

  // Render the main app
  return (
    <>
      <AnimatedRoutes />
      <MobileTabBar />
    </>
  );
};

// Slide-transitioned route outlet. The motion.div is a fixed full-viewport
// scroll container so position:fixed descendants (modals, panels) stay
// anchored to the viewport instead of the transformed wrapper. Bottom
// padding on mobile clears the fixed MobileTabBar; restored to 0 on desktop.
function AnimatedRoutes() {
  const location = useLocation();
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0, x: 24 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -24 }}
        transition={{ duration: 0.22, ease: 'easeInOut' }}
        className="fixed inset-0 overflow-y-auto scrollbar-matrix pb-[3.75rem] md:pb-0"
      >
        <Suspense fallback={<div className="fixed inset-0 flex items-center justify-center"><div className="w-8 h-8 border-4 border-[#00ff41]/30 border-t-[#00ff41] rounded-full animate-spin" /></div>}>
        <Routes location={location}>
          {/* Add your page Route elements here */}
          <Route path="/" element={<Landing />} />
          <Route path="/market" element={<Market />} />
          <Route path="/store/:templateId" element={<StoreItem />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route element={<ProtectedRoute unauthenticatedElement={<Navigate to="/login" replace />} />}>
            <Route path="/workspace" element={<Workspace />} />
            <Route path="/workspace/:projectId" element={<Workspace />} />
            <Route path="/architect" element={<Architect />} />
          <Route path="/portable-morpheus" element={<PortableMorpheusDownload />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
          <Route path="*" element={<PageNotFound />} />
        </Routes>
        </Suspense>
      </motion.div>
    </AnimatePresence>
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
    <AuthProvider>
      <HelpModeProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <ScrollToTop />
          <AuthenticatedApp />
        </Router>
        <Toaster />
      </QueryClientProvider>
      </HelpModeProvider>
    </AuthProvider>
  )
}

export default App