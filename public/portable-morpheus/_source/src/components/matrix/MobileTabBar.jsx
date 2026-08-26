import { useEffect } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Boxes, Store, Settings as SettingsIcon, Terminal } from 'lucide-react';

// Fixed bottom navigation tab bar — mobile only (hidden on >= md).
// Uses NavLink so navigation pushes onto the history stack, preserving
// back-button behavior and route state. Sits above page content, below
// modals (z-40), with bottom safe-area padding for notched devices.
//
// Tabs flagged with `memory` remember the last visited sub-route (e.g.
// /workspace/:projectId) in localStorage so re-tapping the tab returns to
// that nested view instead of clearing the selection back to the root path.
const TABS = [
  { to: '/workspace', label: 'Construct', icon: Terminal, memory: true },
  { to: '/architect', label: 'Architect', icon: Boxes },
  { to: '/market', label: 'Market', icon: Store },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

const lastPathKey = (to) => `morpheus.tab.${to}.lastPath`;

export default function MobileTabBar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  // Persist the current path whenever a memory-enabled tab is visited so the
  // tab can restore the nested sub-route (e.g. an open project) on re-tap.
  useEffect(() => {
    for (const t of TABS) {
      if (t.memory && (pathname === t.to || pathname.startsWith(t.to + '/'))) {
        localStorage.setItem(lastPathKey(t.to), pathname);
      }
    }
  }, [pathname]);

  if (['/', '/login', '/register', '/forgot-password', '/reset-password'].includes(pathname)) return null;
  return (
    <nav className="fixed bottom-0 inset-x-0 z-40 md:hidden border-t border-[#00ff41]/30 bg-black/95 backdrop-blur-sm flex pb-[env(safe-area-inset-bottom)]">
      {TABS.map((t) => {
        const Icon = t.icon;
        return (
          <NavLink
            key={t.to}
            to={t.to}
            onClick={(e) => {
              if (t.memory) {
                // Restore the last nested sub-route (e.g. /workspace/:id)
                // instead of NavLink's default root destination.
                e.preventDefault();
                const last = localStorage.getItem(lastPathKey(t.to)) || t.to;
                if (pathname !== last) navigate(last);
                return;
              }
              // Tapping the already-active tab resets to that tab's root path
              // (e.g. /workspace/:id -> /workspace) so the user can escape a
              // nested view without reaching for the back button.
              const active = pathname === t.to || pathname.startsWith(t.to + '/');
              if (active) {
                e.preventDefault();
                navigate(t.to, { replace: true });
              }
            }}
            className={({ isActive }) =>
              `flex-1 flex flex-col items-center justify-center gap-0.5 py-2 transition-colors ${isActive ? 'text-[#00ff41] neon-glow' : 'text-[#00ff41]/75'}`
            }
          >
            <Icon size={18} />
            <span className="text-[10px] tracking-wider">{t.label.toUpperCase()}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}