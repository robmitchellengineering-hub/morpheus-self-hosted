import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { MORPHEUS_BUILD_TARGETS } from '@/lib/morpheusCapabilities';

// A technical briefing on three systems: Morpheus (a self-hosting build engine),
// MorpheOS (a self-healing operating system) and AirMatrix (broadcast-grade audio
// over consumer Wi-Fi). Written in the voice of an engineering document — what
// each is, how it works, and the measured numbers with their source — not a
// marketing page. Every figure on this page is measured and read from the
// systems' own repositories and experiment records.

const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// ── flow diagrams (hand-drawn SVG, no chart library) ─────────────────────────

// A horizontal pipeline: boxes joined by arrows, one annotation row underneath.
function FlowRow({ nodes, annotations = [], markerId }) {
  const last = nodes[nodes.length - 1];
  const totalW = last.x + last.w;
  const boxY = 24;
  const boxH = 40;
  const mid = boxY + boxH / 2;
  return (
    <svg viewBox={`0 0 ${totalW} 100`} className="w-full h-auto" role="img">
      <defs>
        <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="hsl(var(--primary))" fillOpacity="0.6" />
        </marker>
      </defs>
      {nodes.map((n, i) => (
        <g key={n.label}>
          <rect x={n.x} y={boxY} width={n.w} height={boxH} rx="4" fill="hsl(var(--card))" stroke="hsl(var(--border))" />
          <text x={n.x + n.w / 2} y={mid + 4} textAnchor="middle" fontSize="12.5" fill="hsl(var(--text-ink-strong))" fontFamily={SANS}>{n.label}</text>
          {i < nodes.length - 1 && (
            <line x1={n.x + n.w} y1={mid} x2={nodes[i + 1].x} y2={mid} stroke="hsl(var(--primary))" strokeOpacity="0.6" strokeWidth="1.5" markerEnd={`url(#${markerId})`} />
          )}
        </g>
      ))}
      {annotations.map((a) => (
        <text key={a.text} x={a.x} y={86} textAnchor="middle" fontSize="10.5" fill="hsl(var(--text-ink-max))" opacity="0.7" fontFamily={SANS}>{a.text}</text>
      ))}
    </svg>
  );
}

// The A/B one-shot trial boot, drawn as a decision tree: a committed slot boots a
// trial once; a healthy trial commits, anything else falls back to the committed slot.
function TrialBootDiagram() {
  const box = (x, y, w, label) => (
    <g key={label}>
      <rect x={x} y={y} width={w} height={44} rx="4" fill="hsl(var(--card))" stroke="hsl(var(--border))" />
      <text x={x + w / 2} y={y + 26} textAnchor="middle" fontSize="12.5" fill="hsl(var(--text-ink-strong))" fontFamily={SANS}>{label}</text>
    </g>
  );
  const arrow = (x1, y1, x2, y2) => (
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="hsl(var(--primary))" strokeOpacity="0.6" strokeWidth="1.5" markerEnd="url(#trial-arrow)" />
  );
  return (
    <svg viewBox="0 0 520 256" className="w-full h-auto" role="img">
      <defs>
        <marker id="trial-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="hsl(var(--primary))" fillOpacity="0.6" />
        </marker>
      </defs>
      {box(160, 12, 200, 'slot A — committed')}
      {arrow(260, 56, 260, 96)}
      <text x={268} y={80} textAnchor="start" fontSize="10.5" fill="hsl(var(--text-ink-max))" opacity="0.7" fontFamily={SANS}>boot the trial once</text>
      {box(160, 96, 200, 'slot B — trial')}
      {arrow(260, 140, 260, 168)}
      <line x1={260} y1={168} x2={140} y2={168} stroke="hsl(var(--primary))" strokeOpacity="0.6" strokeWidth="1.5" />
      <line x1={260} y1={168} x2={380} y2={168} stroke="hsl(var(--primary))" strokeOpacity="0.6" strokeWidth="1.5" />
      {arrow(140, 168, 140, 200)}
      {arrow(380, 168, 380, 200)}
      <text x={132} y={188} textAnchor="end" fontSize="10.5" fill="hsl(var(--text-ink-max))" opacity="0.7" fontFamily={SANS}>not healthy</text>
      <text x={388} y={188} textAnchor="start" fontSize="10.5" fill="hsl(var(--text-ink-max))" opacity="0.7" fontFamily={SANS}>healthy</text>
      {box(30, 200, 220, 'fallback — next boot is A')}
      {box(270, 200, 220, 'commit — B becomes A')}
    </svg>
  );
}

// ── small building blocks ────────────────────────────────────────────────────

// A measured-numbers table: one green header row, values in bold green, sources in ink.
function Measured({ rows }) {
  return (
    <table className="w-full text-sm border-collapse mt-2">
      <thead>
        <tr className="border-b border-primary/30">
          <th className="text-left text-primary font-medium py-2 pr-4">MEASURE</th>
          <th className="text-left text-primary font-medium py-2 pr-4">VALUE</th>
          <th className="text-left text-primary font-medium py-2">SOURCE</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.measure} className="border-b border-primary/10 align-top">
            <td className="py-2 pr-4 text-ink">{r.measure}</td>
            <td className="py-2 pr-4 text-primary font-semibold whitespace-nowrap">{r.value}</td>
            <td className="py-2 text-xs text-ink-strong leading-relaxed">{r.source}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// A mechanism: a bolded name followed by its description, as one list item.
function Mechanism({ name, children }) {
  return (
    <li>
      <strong className="text-primary">{name}.</strong> {children}
    </li>
  );
}

// ── the page ─────────────────────────────────────────────────────────────────

export default function Projects() {
  const targetCount = MORPHEUS_BUILD_TARGETS.length;
  return (
    <div className="min-h-screen bg-background text-ink font-sans">
      <header className="border-b border-primary/20">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-primary/70 hover:text-primary transition-colors">
            <ArrowLeft size={14} /> Morpheus
          </Link>
          <span className="inline-flex items-center gap-2">
            <img src="/morpheus-icon.svg" alt="" className="w-4 h-4" />
            <span className="text-[11px] text-ink-max tracking-wide">OUR WORK</span>
          </span>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6">
        <section className="pt-14 pb-12 border-b border-primary/10">
          <h1 className="text-3xl font-semibold text-primary tracking-tight">OUR WORK</h1>
          <p className="mt-4 text-base text-ink leading-relaxed">
            Three systems, built by one team: a self-hosting build engine, a self-healing operating system,
            and broadcast-grade audio over consumer Wi-Fi. What follows is an engineering briefing — what each
            system is, how it works, and the measured numbers behind it.
          </p>
        </section>

        {/* 1 · Morpheus */}
        <section className="py-12 border-b border-primary/10">
          <h2 className="text-xl font-semibold text-primary">1 · Morpheus — a self-hosting build engine</h2>
          <p className="mt-4 text-base text-ink leading-relaxed">
            Morpheus turns a description of software into working, installable artifacts. It does not stop at
            generated code: it lands a compiled, installable result for each target it supports, and it builds
            itself the same way.
          </p>

          <div className="mt-6">
            <FlowRow
              markerId="morpheus-arrow"
              nodes={[
                { x: 0, w: 120, label: 'planner' },
                { x: 144, w: 120, label: 'coder' },
                { x: 288, w: 120, label: 'reviewer' },
                { x: 432, w: 130, label: 'merge gate' },
                { x: 586, w: 134, label: `${targetCount} targets` },
              ]}
              annotations={[
                { x: 348, text: 'a different model' },
                { x: 497, text: 'GitHub · strict · 3 checks' },
              ]}
            />
          </div>

          <p className="mt-3 text-sm text-ink leading-relaxed">
            <strong className="text-primary">Why it matters.</strong> The loop lands a compiled, installable
            artifact — not a code suggestion — and the merge gate cannot land a broken change.
          </p>

          <ul className="mt-6 space-y-2.5 text-sm text-ink leading-relaxed">
            <Mechanism name="Three-role loop">planner → coder → reviewer. The reviewer runs a <em className="text-primary">different model</em> from the coder on purpose — a same-model review grades its own work, so it is not a safety net.</Mechanism>
            <Mechanism name="Merge gate">branch protection on the main branch, with strict up-to-date heads and three required checks (guards, lint + build, render). A broken change physically cannot land.</Mechanism>
            <Mechanism name="Compile targets">Android, iOS, macOS, Windows, Linux, Raspberry Pi, Python, web, Arduino, and audio plugins for all three desktop OSes.</Mechanism>
            <Mechanism name="Mutation-tested guards">every check is proven to fail before it ships — a guard that cannot fail is not a guard.</Mechanism>
            <Mechanism name="Portable">installs and runs anywhere, offline.</Mechanism>
          </ul>

          <div className="mt-6">
            <p className="text-[11px] text-primary uppercase tracking-wide">MEASURED</p>
            <Measured
              rows={[
                { measure: 'Compile targets', value: String(targetCount), source: 'server/src/lib/compile-targets/ — asserted by scripts/reality.mjs' },
                { measure: 'Mutation-tested guards', value: '456', source: 'scripts/verify-guard-mutations.mjs — "proven: 456 guard(s)"' },
              ]}
            />
          </div>

          <p className="mt-5 text-xs text-ink-strong">
            Repository →{' '}
            <a href="https://github.com/robmitchellengineering-hub/morpheus-self-hosted" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">github.com/robmitchellengineering-hub/morpheus-self-hosted</a>
          </p>
        </section>

        {/* 2 · MorpheOS */}
        <section className="py-12 border-b border-primary/10">
          <h2 className="text-xl font-semibold text-primary">2 · MorpheOS — a self-healing operating system</h2>
          <p className="mt-4 text-base text-ink leading-relaxed">
            MorpheOS is built around one property: it does not break, and when it does, it repairs itself.
            The mechanism is a one-shot trial for every change, not a promise.
          </p>

          <div className="mt-6">
            <TrialBootDiagram />
            <p className="mt-2 text-xs text-ink-strong leading-relaxed">
              Rollback is boot-counted, not self-reported: a panicking kernel cannot mark its own trial failed,
              so the fallback is decided by the boot counter, not by the kernel&rsquo;s word.
            </p>
          </div>

          <p className="mt-3 text-sm text-ink leading-relaxed">
            <strong className="text-primary">Why it matters.</strong> The update that bricks a machine is
            handled end-to-end — trial, fallback, self-repair — rather than promised.
          </p>

          <ul className="mt-6 space-y-2.5 text-sm text-ink leading-relaxed">
            <Mechanism name="A/B one-shot trial boot">a new version boots once as a trial; it is committed only if healthy, and falls back automatically otherwise — including the crash case.</Mechanism>
            <Mechanism name="Transaction engine">arm → apply → health-check → commit | rollback. A process that dies mid-change leaves a machine that rolls itself back.</Mechanism>
            <Mechanism name="Heal engine">rebuilds a broken slot in ~7.4 seconds, measured.</Mechanism>
            <Mechanism name="Manifest applier">a service-graph change that breaks an invariant is refused, never applied — the machine stops accepting changes that would break it.</Mechanism>
            <Mechanism name="Flow shell">a Wayland compositor written in Rust (Smithay), not a skin over GNOME.</Mechanism>
          </ul>

          <div className="mt-6">
            <p className="text-[11px] text-primary uppercase tracking-wide">MEASURED</p>
            <Measured
              rows={[
                { measure: 'Broken-slot rebuild (heal)', value: '~7.4 s', source: 'x86 test VM, serial logs (2026-10-11)' },
              ]}
            />
          </div>

          <p className="mt-5 text-xs text-ink-strong">
            Repository →{' '}
            <a href="https://github.com/robmitchellengineering-hub/MorpheOS" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">github.com/robmitchellengineering-hub/MorpheOS</a>
            {' '}· Apache-2.0, open source
          </p>
        </section>

        {/* 3 · AirMatrix */}
        <section className="py-12 border-b border-primary/10">
          <h2 className="text-xl font-semibold text-primary">3 · AirMatrix — broadcast-grade audio over consumer Wi-Fi</h2>
          <p className="mt-4 text-base text-ink leading-relaxed">
            AirMatrix replaces the proprietary wireless audio of live sound with software running on the Wi-Fi
            already installed in the room. The transport is sample-accurate, and its failure modes are measured
            rather than guessed.
          </p>

          <div className="mt-6">
            <FlowRow
              markerId="airmatrix-arrow"
              nodes={[
                { x: 0, w: 84, label: 'capture' },
                { x: 96, w: 84, label: 'encode' },
                { x: 192, w: 84, label: 'sync' },
                { x: 288, w: 96, label: 'network' },
                { x: 396, w: 108, label: 'jitter buffer' },
                { x: 516, w: 108, label: 'concealment' },
                { x: 636, w: 84, label: 'playout' },
              ]}
              annotations={[
                { x: 234, text: 'AMT-Sync' },
                { x: 570, text: 'no audible gap' },
              ]}
            />
          </div>

          <p className="mt-3 text-sm text-ink leading-relaxed">
            <strong className="text-primary">Why it matters.</strong> Broadcast-grade wireless audio becomes
            software on the network already in the room, rather than a locked, per-channel hardware system.
          </p>

          <ul className="mt-6 space-y-2.5 text-sm text-ink leading-relaxed">
            <Mechanism name="Sample-accurate sync and concealment">a dropped packet is recovered with no audible gap — 132 dB through the loopback.</Mechanism>
            <Mechanism name="Lock-free audio tap">the audio thread does a plain copy (no lock, no allocation, no FFT); analysis runs off the packet path, so metering never touches latency.</Mechanism>
            <Mechanism name="E22 field result">when a link under-performed, the culprit was measured — a same-channel extender concealing 22–30% of packets, collapsing to 1.4% on the direct path.</Mechanism>
            <Mechanism name="The open mt76 driver">the only Wi-Fi stack that can be tuned end-to-end for real-time — power-save off at the driver, real-time IRQs.</Mechanism>
          </ul>

          <div className="mt-6">
            <p className="text-[11px] text-primary uppercase tracking-wide">MEASURED</p>
            <Measured
              rows={[
                { measure: 'Loopback signal-to-noise', value: '132 dB', source: 'tone SNR, no processing — AirMatrix technical disclosure and field runs' },
                { measure: 'Downlink concealment, extender vs direct', value: '22–30% vs 1.4%', source: 'E22-R1 field run, 5 GHz, same room (2026-10-12)' },
              ]}
            />
          </div>

          <p className="mt-5 text-xs text-ink-strong">Repository — private.</p>
        </section>

        <section className="py-12">
          <p className="text-sm text-ink leading-relaxed">
            All figures above are measured and taken from the systems&rsquo; own repositories and experiment
            records. Where a mechanism is not yet built, that is stated rather than implied.
          </p>
        </section>
      </main>

      <footer className="border-t border-primary/10">
        <div className="max-w-3xl mx-auto px-6 py-6 flex items-center justify-between gap-4">
          <span className="text-[11px] text-ink-max">MORPHEUS · MORPHEOS · AIRMATRIX</span>
          <Link to="/" className="text-sm text-primary/70 hover:text-primary transition-colors">HOME</Link>
        </div>
      </footer>
    </div>
  );
}
