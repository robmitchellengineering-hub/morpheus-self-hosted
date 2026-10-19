import { NavLink } from 'react-router-dom';
import { Home, Mic, Wrench, Settings } from 'lucide-react';
import { C } from './deckConstants';

const TABS = [
  { to: '/deck', label: 'Deck', icon: Home, end: true },
  { to: '/deck/jarvis', label: 'Jarvis', icon: Mic },
  { to: '/deck/tools', label: 'Tools', icon: Wrench },
  { to: '/deck/settings', label: 'Settings', icon: Settings },
];

// Command Deck's own bottom tab bar — Tweed & Walnut styled, structurally
// like src/components/matrix/MobileTabBar.jsx (fixed to the viewport
// bottom, safe-area aware) but themed for Deck instead of Matrix green.
export default function DeckTabBar() {
  return (
    <nav
      style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 40,
        display: 'flex', background: C.walnut, borderTop: `1px solid ${C.line}`,
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}
    >
      {TABS.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          style={({ isActive }) => ({
            flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.2rem',
            padding: '0.55rem 0 0.5rem', textDecoration: 'none',
            color: isActive ? C.gold : 'rgba(246,240,223,0.55)',
          })}
        >
          <Icon size={20} />
          <span style={{ fontSize: '0.64rem', fontWeight: 600, letterSpacing: '0.02em' }}>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
