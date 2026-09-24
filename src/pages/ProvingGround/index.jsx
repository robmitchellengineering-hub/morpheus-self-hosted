import { Link } from 'react-router-dom';
import { ArrowLeft, FlaskConical, AlertTriangle } from 'lucide-react';
import MatrixRain from '@/components/matrix/MatrixRain';
import { PROVING_GROUND_CARDS } from './cards';
import StatusStrip from './components/StatusStrip';

// /proving-ground — an admin-only surface for LOOKING at a change that shipped
// through self-dev, before it goes anywhere near a customer.
//
// Why it exists: self-dev verifies twice and neither tier renders. engine/verify.js
// parses and bundles with esbuild and checks cross-file exports; smokeCheckSelfDev
// probes live URLs over HTTP, where a single-page app answers 200 for every path.
// So a change can pass every gate self-dev has and still be a blank screen — that
// is how a dock panel shipped opening off the bottom of the screen past both a
// bundle check and an HTTP 200.
//
// The route is registered inside the `adminOnly` ProtectedRoute group in
// src/App.jsx, alongside /self-dev and /admin, and it is deliberately NOT linked
// from any customer-facing surface. scripts/verify-proving-ground.mjs asserts
// both of those facts, because "not customer facing" is a claim that decays the
// moment someone adds a link.
//
// The card mechanism is `import.meta.glob`, mirrored from DeckHome.jsx: a file
// dropped into ./cards/ is picked up on the next build with no edit here. See
// cards.js for the rule a card has to follow.
const cardModules = import.meta.glob('./cards/*.jsx', { eager: true });
const cardComponents = Object.fromEntries(
  Object.entries(cardModules).map(([p, mod]) => [p.replace('./cards/', '').replace('.jsx', ''), mod.default]),
);

export default function ProvingGround() {
  // Both directions of the registry/module split are checked HERE, at render
  // time, and not only in the guard — because the failure this page exists to
  // catch is a thing that silently does not appear. DeckHome.jsx renders `null`
  // for a widget key with no module, so a widget can vanish with a green build
  // and no signal anywhere; that is the specific mistake not repeated here.
  const registered = PROVING_GROUND_CARDS.map((c) => c.key);
  const present = Object.keys(cardComponents);
  const missingModule = PROVING_GROUND_CARDS.filter((c) => !cardComponents[c.key]);
  const unregistered = present.filter((k) => !registered.includes(k));

  return (
    <div className="relative min-h-screen bg-background text-ink font-mono">
      <MatrixRain opacity={0.04} />
      <div className="relative z-10 max-w-5xl mx-auto px-6 py-12 safe-top">
        <Link to="/" className="inline-flex items-center gap-1.5 text-primary/60 hover:text-primary text-sm mb-6 transition-colors">
          <ArrowLeft size={14} /> BACK
        </Link>

        <div className="flex items-center gap-3 mb-2">
          <FlaskConical size={24} className="text-primary neon-glow" />
          <h1 className="text-2xl md:text-3xl font-display tracking-widest neon-glow text-heading">PROVING GROUND</h1>
        </div>

        <p className="text-ink text-sm mb-6 max-w-3xl">
          Internal test surface. Nothing here is customer facing, nothing here is linked from
          anywhere a customer can reach, and nothing here is expected to be polished or permanent.
          A card is here so a change shipped through self-dev can be looked at by a person before it
          goes near a real surface.
        </p>

        <div className="border border-amber-500/40 bg-amber-500/5 p-3 mb-8 flex items-start gap-2">
          <AlertTriangle size={14} className="text-amber-400 mt-0.5 shrink-0" />
          <p className="text-xs text-ink-strong">
            Admin only. To add a card: one file in <span className="text-ink-strong">src/pages/ProvingGround/cards/</span> named
            <span className="text-ink-strong"> &lt;key&gt;.jsx</span> default-exporting a component, plus one entry in
            <span className="text-ink-strong"> cards.js</span>. No route, no nav, no App.jsx edit — the loader below finds the file.
          </p>
        </div>

        {(missingModule.length > 0 || unregistered.length > 0) && (
          <div className="border border-red-500/50 bg-red-500/5 p-3 mb-8 space-y-1">
            <p className="text-xs text-red-300 font-bold">THE REGISTRY AND THE FILES DISAGREE — this is a real failure, not a warning.</p>
            {missingModule.map((c) => (
              <p key={c.key} className="text-xs text-ink-strong">
                registered but no module: <span className="text-red-300">&quot;{c.key}&quot;</span> — expected src/pages/ProvingGround/cards/{c.key}.jsx
              </p>
            ))}
            {unregistered.map((k) => (
              <p key={k} className="text-xs text-ink-strong">
                module but not registered: <span className="text-red-300">&quot;{k}&quot;</span> — it is on disk and invisible here
              </p>
            ))}
          </div>
        )}

        <p className="text-[11px] text-ink-max mb-3">
          {PROVING_GROUND_CARDS.length} card(s) registered · {present.length} module(s) on disk
        </p>

        <StatusStrip />

        <div className="grid gap-4 md:grid-cols-2">
          {PROVING_GROUND_CARDS.map((card) => {
            const Card = cardComponents[card.key];
            return (
              <section key={card.key} className="border border-primary/25 bg-black/30 p-4">
                <h2 className="text-sm font-display tracking-wider text-heading mb-1">{card.title}</h2>
                <p className="text-[11px] text-ink-max mb-3">{card.what}</p>
                {Card
                  ? <Card />
                  : (
                    <p className="text-xs text-red-300">
                      MISSING MODULE — expected src/pages/ProvingGround/cards/{card.key}.jsx
                    </p>
                  )}
                <p className="text-[10px] text-ink-max mt-3 pt-3 border-t border-primary/15">
                  {card.key} · added by {card.addedBy} · {card.ref}
                </p>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
