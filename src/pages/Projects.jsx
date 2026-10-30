import { Link } from 'react-router-dom';
import { MORPHEUS_BUILD_TARGETS } from '@/lib/morpheusCapabilities';

// OUR WORK — the investor-facing briefing on four systems: Morpheus, MorpheOS,
// AirMatrix, and the Valiant Verification trust layer that keeps the other three
// honest. The page is styled to mirror public/verification.html (the Valiant
// Verification page): a clean, light engineering document — green accents,
// numbered findings, measured numbers with their source — not a marketing page.
// Every figure below is measured and read from the systems' own repositories.

const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// ── page styles (mirrors the CSS in public/verification.html) ────────────────
const STYLE = `
  .ourwork {
    --ink: #0A1128;
    --muted: #475569;
    --green: #059669;
    --green-dark: #047857;
    --line: #e2e8f0;
    --paper: #ffffff;
    --soft: #f8fafc;
    min-height: 100vh;
    background: var(--paper);
    color: var(--ink);
    font: 17px/1.65 ${SANS};
    -webkit-font-smoothing: antialiased;
  }
  .ourwork * { box-sizing: border-box; }
  .ourwork .wrap { max-width: 760px; margin: 0 auto; padding: 2rem 1.25rem 6rem; }
  .ourwork .kicker {
    font-size: .8rem; font-weight: 700; letter-spacing: .22em; text-transform: uppercase;
    color: var(--green-dark); margin-bottom: 1rem;
  }
  .ourwork h1 { font-size: 2.6rem; line-height: 1.08; letter-spacing: -.02em; margin: 0 0 1rem; font-weight: 800; color: var(--ink); }
  .ourwork h2 { font-size: 1.35rem; letter-spacing: -.01em; margin: 2.75rem 0 .75rem; font-weight: 800; color: var(--ink); }
  .ourwork h3 { font-size: 1.05rem; letter-spacing: -.01em; margin: 2rem 0 .5rem; font-weight: 800; color: var(--ink); }
  .ourwork .lede { font-size: 1.2rem; line-height: 1.5; color: var(--muted); margin: 0 0 2rem; }
  .ourwork p { margin: 0 0 1rem; color: #1e293b; }
  .ourwork .stat { font-weight: 800; color: var(--green-dark); }
  .ourwork .finding {
    border-left: 3px solid var(--green);
    background: var(--soft);
    padding: 1rem 1.25rem;
    margin: 0 0 1rem;
    border-radius: 0 8px 8px 0;
  }
  .ourwork .finding b { color: var(--ink); }
  .ourwork ol.principles { list-style: none; padding: 0; margin: 0; counter-reset: p; }
  .ourwork ol.principles li {
    position: relative; padding: 0 0 1rem 3rem; margin: 0 0 1rem; border-bottom: 1px solid var(--line);
  }
  .ourwork ol.principles li::before {
    counter-increment: p; content: counter(p);
    position: absolute; left: 0; top: .1rem;
    width: 2rem; height: 2rem; border-radius: 50%;
    background: var(--green); color: #fff; font-weight: 800;
    display: flex; align-items: center; justify-content: center;
  }
  .ourwork ol.principles b { display: block; margin-bottom: .2rem; }
  .ourwork ul.mechanisms { margin: 0 0 1rem; padding-left: 1.25rem; }
  .ourwork ul.mechanisms li { margin: 0 0 .5rem; color: #1e293b; }
  .ourwork ul.mechanisms strong { color: var(--green-dark); }
  .ourwork table.measured { width: 100%; border-collapse: collapse; margin: .5rem 0 1rem; font-size: .95rem; }
  .ourwork table.measured th {
    text-align: left; font-size: .75rem; letter-spacing: .12em; text-transform: uppercase;
    color: var(--green-dark); font-weight: 700; padding: .5rem .75rem .5rem 0; border-bottom: 1px solid var(--line);
  }
  .ourwork table.measured td { padding: .5rem .75rem .5rem 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  .ourwork table.measured td.val { font-weight: 800; color: var(--green-dark); white-space: nowrap; }
  .ourwork table.measured td.src { color: var(--muted); font-size: .85rem; }
  .ourwork .figcaption { font-size: .85rem; color: var(--muted); margin: .25rem 0 1rem; }
  .ourwork .repo { font-size: .9rem; color: var(--muted); margin: .75rem 0 0; }
  .ourwork .cta { margin-top: 1rem; }
  .ourwork a.download, .ourwork a.github {
    display: block;
    width: fit-content;
    padding: .9rem 1.6rem; border-radius: 10px;
    font-weight: 700; font-size: 1.05rem; text-decoration: none;
  }
  .ourwork a.download { background: var(--green); color: #fff; box-shadow: 0 1px 2px rgba(4,120,87,.25); }
  .ourwork a.download:hover { background: var(--green-dark); }
  .ourwork a.github { margin-top: .6rem; border: 1px solid var(--green); color: var(--green-dark); }
  .ourwork a.github:hover { background: var(--soft); }
  .ourwork .honest {
    margin-top: 2rem; border: 1px solid #fde68a; background: #fffbeb; color: #78350f;
    padding: 1rem 1.25rem; border-radius: 8px; font-size: .95rem;
  }
  .ourwork a { color: var(--green-dark); }
  .ourwork a.back { display: inline-flex; align-items: center; gap: .35rem; text-decoration: none; font-size: .9rem; font-weight: 600; }
  .ourwork footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .9rem; }
`;

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
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#059669" fillOpacity="0.7" />
        </marker>
      </defs>
      {nodes.map((n, i) => (
        <g key={n.label}>
          <rect x={n.x} y={boxY} width={n.w} height={boxH} rx="4" fill="#ffffff" stroke="#cbd5e1" />
          <text x={n.x + n.w / 2} y={mid + 4} textAnchor="middle" fontSize="12.5" fill="#0A1128" fontFamily={SANS}>{n.label}</text>
          {i < nodes.length - 1 && (
            <line x1={n.x + n.w} y1={mid} x2={nodes[i + 1].x} y2={mid} stroke="#059669" strokeOpacity="0.7" strokeWidth="1.5" markerEnd={`url(#${markerId})`} />
          )}
        </g>
      ))}
      {annotations.map((a) => (
        <text key={a.text} x={a.x} y={86} textAnchor="middle" fontSize="10.5" fill="#475569" opacity="0.85" fontFamily={SANS}>{a.text}</text>
      ))}
    </svg>
  );
}

// The A/B one-shot trial boot, drawn as a decision tree: a committed slot boots a
// trial once; a healthy trial commits, anything else falls back to the committed slot.
function TrialBootDiagram() {
  const box = (x, y, w, label) => (
    <g key={label}>
      <rect x={x} y={y} width={w} height={44} rx="4" fill="#ffffff" stroke="#cbd5e1" />
      <text x={x + w / 2} y={y + 26} textAnchor="middle" fontSize="12.5" fill="#0A1128" fontFamily={SANS}>{label}</text>
    </g>
  );
  const arrow = (x1, y1, x2, y2) => (
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#059669" strokeOpacity="0.7" strokeWidth="1.5" markerEnd="url(#trial-arrow)" />
  );
  return (
    <svg viewBox="0 0 520 256" className="w-full h-auto" role="img">
      <defs>
        <marker id="trial-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#059669" fillOpacity="0.7" />
        </marker>
      </defs>
      {box(160, 12, 200, 'slot A — committed')}
      {arrow(260, 56, 260, 96)}
      <text x={268} y={80} textAnchor="start" fontSize="10.5" fill="#475569" opacity="0.85" fontFamily={SANS}>boot the trial once</text>
      {box(160, 96, 200, 'slot B — trial')}
      {arrow(260, 140, 260, 168)}
      <line x1={260} y1={168} x2={140} y2={168} stroke="#059669" strokeOpacity="0.7" strokeWidth="1.5" />
      <line x1={260} y1={168} x2={380} y2={168} stroke="#059669" strokeOpacity="0.7" strokeWidth="1.5" />
      {arrow(140, 168, 140, 200)}
      {arrow(380, 168, 380, 200)}
      <text x={132} y={188} textAnchor="end" fontSize="10.5" fill="#475569" opacity="0.85" fontFamily={SANS}>not healthy</text>
      <text x={388} y={188} textAnchor="start" fontSize="10.5" fill="#475569" opacity="0.85" fontFamily={SANS}>healthy</text>
      {box(30, 200, 220, 'fallback — next boot is A')}
      {box(270, 200, 220, 'commit — B becomes A')}
    </svg>
  );
}

// ── small building blocks ────────────────────────────────────────────────────

// A measured-numbers table: green header row, values in bold green, sources in ink.
function Measured({ rows }) {
  return (
    <table className="measured">
      <thead>
        <tr>
          <th>Measure</th>
          <th>Value</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.measure}>
            <td>{r.measure}</td>
            <td className="val">{r.value}</td>
            <td className="src">{r.source}</td>
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
      <strong>{name}.</strong> {children}
    </li>
  );
}

// ── the page ─────────────────────────────────────────────────────────────────

export default function Projects() {
  const targetCount = MORPHEUS_BUILD_TARGETS.length;
  return (
    <div className="ourwork">
      <style>{STYLE}</style>
      <div className="wrap">

        <Link className="back" to="/">← Morpheus</Link>

        <div className="kicker" style={{ marginTop: '1.5rem' }}>Our Work</div>
        <h1>Three systems, one team — and the trust layer that verifies them.</h1>
        <p className="lede">A self-hosting build engine, a self-healing operating system, and
        broadcast-grade audio over consumer Wi-Fi. The fourth entry is not a product but the
        discipline behind all three — Valiant Verification, the layer that makes &ldquo;done&rdquo;
        mean &ldquo;verified&rdquo;. What follows is an engineering briefing: what each is, how it
        works, and the measured numbers behind it.</p>

        {/* 1 · Morpheus */}
        <section>
          <h2>1 · Morpheus — a self-hosting build engine</h2>
          <p>Morpheus turns a description of software into working, installable artifacts. It does not stop at
          generated code: it lands a compiled, installable result for each target it supports, and it builds
          itself the same way.</p>

          <FlowRow
            markerId="morpheus-arrow"
            nodes={[
              { x: 0, w: 120, label: 'planner' },
              { x: 144, w: 120, label: 'coder' },
              { x: 288, w: 120, label: 'reviewer' },
              { x: 432, w: 130, label: 'merge gate' },
              { x: 586, w: 133, label: `${targetCount} targets` },
            ]}
            annotations={[
              { x: 348, text: 'a different model' },
              { x: 497, text: 'GitHub · strict · 3 checks' },
            ]}
          />
          <p className="figcaption">The loop lands a compiled, installable artifact — not a code suggestion.</p>

          <ul className="mechanisms">
            <Mechanism name="Three-role loop">planner → coder → reviewer. The reviewer runs a <em>different model</em> from the coder on purpose — a same-model review grades its own work, so it is not a safety net.</Mechanism>
            <Mechanism name="Merge gate">branch protection on the main branch, with strict up-to-date heads and three required checks (guards, lint + build, render). A broken change physically cannot land.</Mechanism>
            <Mechanism name="Compile targets">Android, iOS, macOS, Windows, Linux, Raspberry Pi, Python, web, Arduino, and audio plugins for all three desktop OSes.</Mechanism>
            <Mechanism name="Mutation-tested guards">every check is proven to fail before it ships — a guard that cannot fail is not a guard.</Mechanism>
            <Mechanism name="Portable">installs and runs anywhere, offline.</Mechanism>
          </ul>

          <h3>Measured</h3>
          <Measured
            rows={[
              { measure: 'Compile targets', value: String(targetCount), source: 'server/src/lib/compile-targets/ — asserted by scripts/reality.mjs' },
              { measure: 'Automated guards', value: '130', source: 'scripts/seo-static.mjs — count of scripts/verify-*.mjs at build time' },
            ]}
          />

          <p className="repo">Repository →{' '}
            <a href="https://github.com/robmitchellengineering-hub/morpheus-self-hosted" target="_blank" rel="noopener noreferrer">github.com/robmitchellengineering-hub/morpheus-self-hosted</a>
          </p>
        </section>

        {/* 2 · MorpheOS */}
        <section>
          <h2>2 · MorpheOS — a self-healing operating system</h2>
          <p>MorpheOS is built around one property: it does not break, and when it does, it repairs itself.
          The mechanism is a one-shot trial for every change, not a promise.</p>

          <TrialBootDiagram />
          <p className="figcaption">Rollback is boot-counted, not self-reported: a panicking kernel cannot mark its own
          trial failed, so the fallback is decided by the boot counter, not by the kernel&rsquo;s word.</p>

          <ul className="mechanisms">
            <Mechanism name="A/B one-shot trial boot">a new version boots once as a trial; it is committed only if healthy, and falls back automatically otherwise — including the crash case.</Mechanism>
            <Mechanism name="Transaction engine">arm → apply → health-check → commit | rollback. A process that dies mid-change leaves a machine that rolls itself back.</Mechanism>
            <Mechanism name="Heal engine">rebuilds a broken slot in ~7.4 seconds, measured.</Mechanism>
            <Mechanism name="Manifest applier">a service-graph change that breaks an invariant is refused, never applied — the machine stops accepting changes that would break it.</Mechanism>
            <Mechanism name="Flow shell">a Wayland compositor written in Rust (Smithay), not a skin over GNOME.</Mechanism>
          </ul>

          <h3>Measured</h3>
          <Measured
            rows={[
              { measure: 'Broken-slot rebuild (heal)', value: '~7.4 s', source: 'x86 test VM, serial logs (2026-10-11)' },
            ]}
          />

          <p className="repo">Repository →{' '}
            <a href="https://github.com/robmitchellengineering-hub/MorpheOS" target="_blank" rel="noopener noreferrer">github.com/robmitchellengineering-hub/MorpheOS</a>
            {' '}· Apache-2.0, open source
          </p>
        </section>

        {/* 3 · AirMatrix */}
        <section>
          <h2>3 · AirMatrix — broadcast-grade audio over consumer Wi-Fi</h2>
          <p>AirMatrix replaces the proprietary wireless audio of live sound with software running on the Wi-Fi
          already installed in the room. The transport is sample-accurate, and its failure modes are measured
          rather than guessed.</p>

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

          <ul className="mechanisms">
            <Mechanism name="Sample-accurate sync and concealment">a dropped packet is recovered with no audible gap — 132 dB through the loopback.</Mechanism>
            <Mechanism name="Lock-free audio tap">the audio thread does a plain copy (no lock, no allocation, no FFT); analysis runs off the packet path, so metering never touches latency.</Mechanism>
            <Mechanism name="E22 field result">when a link under-performed, the culprit was measured — a same-channel extender concealing 22–30% of packets, collapsing to 1.4% on the direct path.</Mechanism>
            <Mechanism name="The open mt76 driver">the only Wi-Fi stack that can be tuned end-to-end for real-time — power-save off at the driver, real-time IRQs.</Mechanism>
          </ul>

          <h3>Measured</h3>
          <Measured
            rows={[
              { measure: 'Loopback signal-to-noise', value: '132 dB', source: 'tone SNR, no processing — AirMatrix technical disclosure and field runs' },
              { measure: 'Downlink concealment, extender vs direct', value: '22–30% vs 1.4%', source: 'E22-R1 field run, 5 GHz, same room (2026-10-12)' },
            ]}
          />

          <p className="repo">Repository — private.</p>
        </section>

        {/* 4 · Valiant Verification */}
        <section>
          <h2>4 · Valiant Verification — done means verified</h2>
          <p>Generation is solved. Verification is not — it is the bottleneck the leading AI coding tools leave
          open. This is the verification discipline the rest of the field is missing, built and running here,
          and available to license as a trust layer for any agent toolchain.</p>

          <h3>The results, measured</h3>
          <div className="finding"><b><span className="stat">137 automated guards</span></b> — each asserts a real
          failure mode, and each is proven to fail: <span className="stat">510 recorded mutation tests</span> inject
          a seeded fault and confirm the guard goes red. The unproven backlog has been ratcheted from 44 to{' '}
          <span className="stat">5</span>.</div>
          <div className="finding"><b><span className="stat">26 documented breakages</span></b> — every self-inflicted
          failure is filed with a detection rule and fed back to the reviewer on every turn, so the same mistake
          cannot repeat unnoticed.</div>
          <div className="finding"><b>A reviewer that never grades its own work</b> — review runs on a different
          model than the coder, against its own evidence, so a green build is not a model approving itself.</div>
          <div className="finding"><b>10 of 12 leading tools leave verification optional.</b> Here, verification
          is a structural gate — a skipped or neutral check is a fail, never a silent pass.</div>

          <h3>The five principles</h3>
          <ol className="principles">
            <li><b>The gate is structural, not a choice.</b>Required checks are matched by name; a skipped or neutral check is a fail.</li>
            <li><b>Prove the check can fail.</b>Every guard is mutation-tested: break it, confirm it goes red. A check that has never failed proves nothing.</li>
            <li><b>The reviewer must not grade its own work.</b>Review runs on a different model than the coder, against its own evidence.</li>
            <li><b>Failures become memory.</b>Every breakage is filed with a detection rule and fed back every turn.</li>
            <li><b>Evidence carries provenance.</b>A result must name who produced it, that it ran, and what would falsify it.</li>
          </ol>

          <h3>Licensing</h3>
          <p>Three layers, framed as <strong>available to license</strong>:</p>
          <ul className="mechanisms">
            <li><strong>The specification</strong> — open, free to implement, so the standard spreads.</li>
            <li><strong>The reference SDK</strong> — source-available, licensed per product, tiered by licensee size.</li>
            <li><strong>The guard corpus + hazard library</strong> — subscription; the breakages, bought with real incidents, updated continuously.</li>
          </ul>

          <h3>For investors &amp; partners</h3>
          <p>The full case — why verification became the bottleneck, the twelve-tool survey, how this compares
          to the funded field, and the disruptor thesis, with its honest boundary stated alongside it — now
          lives under Valiant Verification.</p>
          <p>
            <a href="https://vvs.morpheus.nz/" target="_blank" rel="noopener">Read it at vvs.morpheus.nz &rarr;</a>
          </p>

          <div className="cta">
            <a className="download" href="https://vvs.morpheus.nz/certification.html" target="_blank" rel="noopener">Read the full verification page</a>
            <a className="github" href="https://github.com/robmitchellengineering-hub/valiant-verification" target="_blank" rel="noopener">View on GitHub — star · fork · integrate</a>
          </div>

          <div className="honest"><strong>Stated honestly:</strong> this is pre-revenue. We are seeking the first
          design partners — AI-tooling teams and dev agencies shipping agent-generated work — to integrate the
          layer and earn the first references.</div>
        </section>

        <footer>
          <p>All figures above are measured and taken from the systems&rsquo; own repositories and experiment
          records. Where a mechanism is not yet built, that is stated rather than implied.</p>
          <p>Morpheus · MorpheOS · AirMatrix · Valiant Verification — <Link to="/">morpheus.nz</Link></p>
        </footer>

      </div>
    </div>
  );
}
