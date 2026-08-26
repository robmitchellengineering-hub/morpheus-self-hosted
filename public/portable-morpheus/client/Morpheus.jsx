import MorpheusPanel from './MorpheusPanel.jsx';

// Drop-in Morpheus page. Mount anywhere in your React app:
//   import Morpheus from 'portable-morpheus/client/Morpheus.jsx';
//   <Route path="/morpheus" element={<Morpheus />} />
//
// Set window.MORPHEUS_API_BASE to your deployed Morpheus server URL
// before mounting (e.g. https://api.yourapp.com/morpheus).

export default function Morpheus({ projectId }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 16, background: '#000' }}>
      <div style={{ width: '100%', maxWidth: 760 }}>
        <MorpheusPanel projectId={projectId} />
      </div>
    </div>
  );
}