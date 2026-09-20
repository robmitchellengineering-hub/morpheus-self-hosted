// Self-hosted replacement for the original Base44-platform AuthContext.
// Base44's version checked "app public settings" (multi-tenant platform
// concept — is auth required, is this user registered for this app) before
// checking the user session; a self-hosted single-tenant deployment has no
// such concept, so that step collapses to "is there a token, and is it
// valid" — but the exported shape (user, isAuthenticated, isLoadingAuth,
// authError, authChecked, logout, navigateToLogin, checkUserAuth,
// checkAppState) is kept identical so ProtectedRoute.jsx, App.jsx, and every
// page that calls useAuth() needed zero changes.
import React, { createContext, useState, useContext, useEffect, useCallback } from 'react';
import { base44, getToken } from '@/api/base44Client';
import { loginRedirectTarget } from '@/lib/authRedirect';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [isLoadingPublicSettings, setIsLoadingPublicSettings] = useState(false); // no multi-tenant settings to load, self-hosted
  const [authError, setAuthError] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [appPublicSettings] = useState({ id: 'self-hosted', public_settings: {} });

  const checkUserAuth = useCallback(async () => {
    setIsLoadingAuth(true);
    setAuthError(null);
    if (!getToken()) {
      setUser(null);
      setIsAuthenticated(false);
      setIsLoadingAuth(false);
      setAuthChecked(true);
      return;
    }
    try {
      const currentUser = await base44.auth.me();
      setUser(currentUser);
      setIsAuthenticated(true);
    } catch (error) {
      setUser(null);
      setIsAuthenticated(false);
      if (error.status === 401 || error.status === 403) {
        // A 401 from /auth/me means the stored token is definitively dead
        // (expired, revoked, or from a deleted account). Clearing it makes the
        // next render a clean logged-out state — the login form — instead of
        // repeatedly presenting a token the server will keep rejecting.
        // 403 is left alone: that is "this token may not", not "no session".
        if (error.status === 401) base44.auth.setToken(null);
        setAuthError({ type: 'auth_required', message: 'Authentication required' });
      }
    } finally {
      setIsLoadingAuth(false);
      setAuthChecked(true);
    }
  }, []);

  const checkAppState = useCallback(async () => {
    await checkUserAuth();
  }, [checkUserAuth]);

  useEffect(() => {
    checkAppState();
  }, [checkAppState]);

  const logout = (shouldRedirect = true) => {
    setUser(null);
    setIsAuthenticated(false);
    base44.auth.logout(shouldRedirect ? '/' : undefined);
  };

  const navigateToLogin = () => {
    // No-op when a redirect would land on a sign-in page (from a sign-in
    // page): the caller renders, and the form is reachable.
    const target = loginRedirectTarget(window.location.pathname, window.location.search);
    if (target) window.location.href = target;
  };

  return (
    <AuthContext.Provider value={{
      user,
      isAuthenticated,
      isLoadingAuth,
      isLoadingPublicSettings,
      authError,
      appPublicSettings,
      authChecked,
      logout,
      navigateToLogin,
      checkUserAuth,
      checkAppState,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
