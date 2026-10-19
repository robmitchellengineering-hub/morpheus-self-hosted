import ArchitectPanel from './ArchitectPanel.jsx';

// Drop-in Architect page. Mount anywhere in your React app:
//   import Architect from 'portable-architect/client/Architect.jsx';
//   <Route path="/architect" element={<Architect />} />
//
// Set window.ARCHITECT_API_BASE to your deployed Architect server URL
// before mounting (e.g. https://api.yourapp.com/architect).

export default function Architect({ projectId }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 16, background: '#0a0a0a' }}>
      <div style={{ width: '100%', maxWidth: 720 }}>
        <ArchitectPanel projectId={projectId} />
      </div>
    </div>
  );
}