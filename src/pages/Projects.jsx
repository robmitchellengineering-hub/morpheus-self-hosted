import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { MORPHEUS_BUILD_TARGETS } from '@/lib/morpheusCapabilities';

// The three products, as a single page. Every number here is measured and read
// from the projects' own repositories and experiment records — not estimated
// from memory. Where a figure is a target rather than a measurement it says so.
// This is an investor-facing surface: the work speaks, so there is no "invest"
// call-to-action and no hard sell anywhere on the page.

// ── data ─────────────────────────────────────────────────────────────────────

// The heal ladder, from MorpheOS docs/adr/0009-heal-ladder.md (H0–H5, Phoenix as
// H5). "What is real at each rung" is the ADR's own state column. fill encodes it
// for the staircase: 1 = built, 0.5 = mechanism exists but unwired, 0 = not built.
const HEAL_LADDER = [
  { rung: 'H0', name: 'Restart the process or service', fill: 0, state: 'not built' },
  { rung: 'H1', name: 'Rebuild a capsule from its recipe', fill: 0, state: 'not built (phase 2)' },
  { rung: 'H2', name: 'Roll back one offending transaction', fill: 0, state: 'not built' },
  { rung: 'H3', name: 'Roll back to the last known-good system', fill: 1, state: 'built, as boot policy' },
  { rung: 'H4', name: 'Rebuild in place from the recovery image', fill: 0.5, state: 'mechanism exists, unwired' },
  { rung: 'H5', name: 'Phoenix restore from a mesh peer or backup', fill: 0, state: 'not built' },
];

// ── charts (hand-drawn SVG + CSS, no chart library) ──────────────────────────

// Graph 1 · AirMatrix — "found it, fixed it". One bar pair: a same-channel
// extender conceals 22–30% of downlink packets, the direct path 1.4%. The whole
// story in one chart. (E22-R1, measured 2026-10-12, 5 GHz, same room.)
function ConcealmentChart() {
  // Scale: 30% = full width, so the ~20× gap is honest on screen.
  const max = 30;
  const direct = 1.4;
  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-baseline justify-between gap-3 mb-1.5">
          <span className="text-xs text-ink-strong font-mono">same-channel extender</span>
          <span className="text-primary font-display tracking-wider">22–30%</span>
        </div>
        <div className="h-3 w-full bg-primary/10 rounded-sm overflow-hidden">
          <div className="h-full rounded-sm" style={{ width: `${(30 / max) * 100}%`, backgroundColor: 'hsl(var(--chart-5))', opacity: 0.82 }} />
        </div>
        <p className="text-[10px] text-ink-max font-mono mt-1">packets concealed, downlink</p>
      </div>
      <div>
        <div className="flex items-baseline justify-between gap-3 mb-1.5">
          <span className="text-xs text-ink-strong font-mono">direct path</span>
          <span className="text-primary font-display tracking-wider">1.4%</span>
        </div>
        <div className="h-3 w-full bg-primary/10 rounded-sm overflow-hidden">
          <div className="h-full rounded-sm" style={{ width: `${(direct / max) * 100}%`, backgroundColor: 'hsl(var(--chart-1))' }} />
        </div>
        <p className="text-[10px] text-ink-max font-mono mt-1">same link, no extender</p>
      </div>
    </div>
  );
}

// Graph 2 · MorpheOS — the self-healing ladder. Six rungs, cheapest first, drawn
// as an ascending staircase; a filled step is built, a half step has its
// mechanism but is unwired, an outlined step is not built yet.
function HealLadderChart() {
  const w = 64;
  const gap = 14;
  const baseY = 118;
  const total = HEAL_LADDER.length * (w + gap) - gap;
  return (
    <svg viewBox={`0 0 ${total} 134`} className="w-full h-auto" role="img" aria-label="MorpheOS heal ladder: H0 to H5, cheapest rung first; H3 is built, H4 has its mechanism, the rest are targets">
      <line x1="0" y1={baseY} x2={total} y2={baseY} stroke="hsl(var(--border))" />
      {HEAL_LADDER.map((s, i) => {
        const x = i * (w + gap);
        const h = 20 + i * 14;
        const y = baseY - h;
        return (
          <g key={s.rung}>
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              fill={s.fill === 1 ? 'hsl(var(--chart-1))' : 'none'}
              stroke="hsl(var(--primary))"
              strokeOpacity={s.fill === 0 ? 0.35 : 1}
            />
            {s.fill === 0.5 && (
              <rect x={x} y={y + h / 2} width={w} height={h / 2} fill="hsl(var(--chart-1))" />
            )}
            <text x={x + w / 2} y={baseY + 13} textAnchor="middle" fontSize="10" fill="hsl(var(--text-ink-max))" fontFamily="var(--font-mono)">{s.rung}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ── the page ────────────────────────────────────────────────────────────────

export default function Projects() {
  const targetCount = MORPHEUS_BUILD_TARGETS.length;
  return (
    <div className="min-h-screen bg-background text-ink">
      {/* Header — the brand mark and a way back, nothing more. */}
      <header className="border-b border-primary/20">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <Link to="/" className="inline-flex items-center gap-1.5 text-xs text-primary/70 hover:text-primary font-display tracking-wider transition-colors">
            <ArrowLeft size={12} /> MORPHEUS
          </Link>
          <span className="inline-flex items-center gap-2">
            <img src="/morpheus-icon.svg" alt="" className="w-4 h-4" />
            <span className="text-[10px] text-ink-max font-mono tracking-[0.2em]">OUR WORK</span>
          </span>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6">
        {/* Hero */}
        <section className="pt-16 pb-12 md:pt-24 md:pb-16 border-b border-primary/10">
          <p className="text-[11px] text-primary font-display tracking-[0.3em] uppercase mb-6">OUR WORK</p>
          <h1 className="text-3xl md:text-5xl font-display text-primary tracking-tight leading-tight">
            Three things that shouldn&rsquo;t exist yet.
          </h1>
          <p className="mt-6 text-base text-ink leading-relaxed max-w-2xl">
            One team. Three things that shouldn&rsquo;t exist yet — an AI that ships real software, an
            operating system that can&rsquo;t break, and broadcast-grade audio over the Wi-Fi you already own.
          </p>
        </section>

        {/* 01 · Morpheus */}
        <section className="py-14 md:py-20 border-b border-primary/10">
          <div className="grid md:grid-cols-2 gap-10">
            <div>
              <p className="text-[11px] text-primary font-display tracking-[0.25em] uppercase">01 · Morpheus — the builder</p>
              <h2 className="mt-4 text-2xl md:text-3xl font-display text-primary tracking-tight">
                It doesn&rsquo;t generate code. It ships working software.
              </h2>
              <div className="mt-5 space-y-4 text-sm text-ink leading-relaxed">
                <p>
                  Morpheus builds real, installable artifacts for <strong className="text-primary font-normal">thirteen targets</strong> —
                  native apps for Android, iOS, macOS, Windows and Linux, Raspberry Pi images, Python packages,
                  web apps, Arduino firmware, and audio plugins for all three desktop platforms.
                </p>
                <p>
                  And it builds <strong className="text-primary font-normal">itself</strong>: a planner proposes, a coder writes, an
                  independent reviewer is the safety net, and a merge gate enforced by GitHub keeps broken changes
                  out. It runs where you want — including fully portable and offline.
                </p>
              </div>
            </div>
            <div>
              <div className="flex items-baseline gap-3 mb-4">
                <span className="text-5xl font-display text-primary tracking-wider">{targetCount}</span>
                <span className="text-xs text-ink-strong font-mono tracking-wider">compile targets, one AI</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {MORPHEUS_BUILD_TARGETS.map((t) => (
                  <span key={t} className="text-[10px] text-ink-max font-mono border border-primary/25 px-2 py-1 rounded-sm">{t}</span>
                ))}
              </div>
              <p className="text-[10px] text-ink-max font-mono mt-3 leading-relaxed">
                The list is asserted against <code className="text-[10px]">server/src/lib/compile-targets/</code> at build
                time, so it cannot drift from what actually ships.
              </p>
            </div>
          </div>
        </section>

        {/* 02 · MorpheOS */}
        <section className="py-14 md:py-20 border-b border-primary/10">
          <p className="text-[11px] text-primary font-display tracking-[0.25em] uppercase">02 · MorpheOS — the operating system</p>
          <h2 className="mt-4 text-2xl md:text-3xl font-display text-primary tracking-tight">
            Delete the system folder live on stage. It comes back.
          </h2>
          <div className="mt-6 grid md:grid-cols-2 gap-10">
            <div className="space-y-4 text-sm text-ink leading-relaxed">
              <p>
                An OS built around one idea: <strong className="text-primary font-normal">it never breaks, and when it does, it fixes
                itself.</strong> Updates are a one-shot trial — try the new version, commit it only if it&rsquo;s healthy,
                fall back automatically the instant it isn&rsquo;t.
              </p>
              <p>
                A broken slot is rebuilt in <strong className="text-primary font-normal">~7 seconds, measured</strong> — not estimated.
                A transaction engine takes a change back the moment the machine says no.
              </p>
              <p>
                On top sits a real Wayland compositor written in Rust — not a skin over GNOME. Open core,
                Apache-2.0, on the Linux kernel.
              </p>
            </div>
            <div>
              <div className="grid grid-cols-3 gap-4 mb-6">
                <div>
                  <div className="text-2xl font-display text-primary tracking-wider">~7 s</div>
                  <div className="text-[10px] text-ink-max font-mono mt-1 leading-snug">heal repair, measured</div>
                </div>
                <div>
                  <div className="text-2xl font-display text-primary tracking-wider">~5.9 s</div>
                  <div className="text-[10px] text-ink-max font-mono mt-1 leading-snug">update install, measured</div>
                </div>
                <div>
                  <div className="text-2xl font-display text-primary tracking-wider">~3×</div>
                  <div className="text-[10px] text-ink-max font-mono mt-1 leading-snug">faster updates from a slimmer payload</div>
                </div>
              </div>
              <HealLadderChart />
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
                <span className="inline-flex items-center gap-1.5 text-[10px] text-ink-max font-mono"><span className="w-2 h-2 inline-block rounded-sm" style={{ backgroundColor: 'hsl(var(--chart-1))' }} /> built</span>
                <span className="inline-flex items-center gap-1.5 text-[10px] text-ink-max font-mono"><span className="w-2 h-2 inline-block rounded-sm border border-primary/50" /> not built</span>
                <span className="inline-flex items-center gap-1.5 text-[10px] text-ink-max font-mono"><span className="w-2 h-2 inline-block rounded-sm" style={{ background: 'linear-gradient(to top, hsl(var(--chart-1)) 50%, transparent 50%)', border: '1px solid hsl(var(--primary))' }} /> mechanism exists</span>
              </div>
              <ul className="mt-4 space-y-1 border-t border-primary/10 pt-3">
                {HEAL_LADDER.map((s) => (
                  <li key={s.rung} className="flex items-baseline justify-between gap-4 text-[11px] font-mono">
                    <span className="text-ink-max shrink-0">{s.rung}</span>
                    <span className="text-ink-max flex-1 leading-snug">{s.name}</span>
                    <span className="text-ink-max shrink-0 opacity-80">{s.state}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* 03 · AirMatrix */}
        <section className="py-14 md:py-20 border-b border-primary/10">
          <p className="text-[11px] text-primary font-display tracking-[0.25em] uppercase">03 · AirMatrix — the audio</p>
          <h2 className="mt-4 text-2xl md:text-3xl font-display text-primary tracking-tight">
            Broadcast-grade wireless audio, on the Wi-Fi you already own. Bought once.
          </h2>
          <div className="mt-6 grid md:grid-cols-2 gap-10">
            <div className="space-y-4 text-sm text-ink leading-relaxed">
              <p>
                Today, wireless audio on a stage means Shure/Audinate-class systems at thousands per channel,
                locked to one vendor. AirMatrix makes the same broadcast-grade quality — tight sync, low latency,
                loss concealment, a full desk mixed from a browser — work on ordinary consumer Wi-Fi.
              </p>
              <p>
                <strong className="text-primary font-normal">132 dB</strong> through the loopback; amp models run real-time on a
                Pi-class ARM chip (WaveNet <strong className="text-primary font-normal">1.96×</strong>, NAM{' '}
                <strong className="text-primary font-normal">6.42×</strong>).
              </p>
              <p>
                And the field work is the tell: when the link under-performed, we <strong className="text-primary font-normal">measured</strong> it
                and found the real culprit — a same-channel extender — instead of guessing.
              </p>
            </div>
            <div>
              <ConcealmentChart />
              <p className="text-[10px] text-ink-max font-mono mt-4 leading-relaxed">
                Measured 2026-10-12 (E22-R1), 5 GHz, same room. WaveNet / NAM throughput on an ARM runner,
                64-frame blocks, bit-identical to the reference.
              </p>
            </div>
          </div>
        </section>

        {/* Credibility strip */}
        <section className="py-14 md:py-16">
          <p className="text-[11px] text-primary font-display tracking-[0.25em] uppercase mb-6">The work is verified</p>
          <div className="grid md:grid-cols-3 gap-6">
            <div className="border border-primary/15 rounded-sm p-5">
              <div className="text-2xl font-display text-primary tracking-wider">456</div>
              <p className="text-xs text-ink-strong leading-relaxed mt-2">
                guards, each mutation-tested to fail before it ships — every check we claim is proven to catch
                the thing it claims to catch.
              </p>
            </div>
            <div className="border border-primary/15 rounded-sm p-5">
              <div className="text-2xl font-display text-primary tracking-wider">GitHub</div>
              <p className="text-xs text-ink-strong leading-relaxed mt-2">
                a merge gate enforced by GitHub — broken changes physically cannot land.
              </p>
            </div>
            <div className="border border-primary/15 rounded-sm p-5">
              <div className="text-2xl font-display text-primary tracking-wider">3 OS</div>
              <p className="text-xs text-ink-strong leading-relaxed mt-2">
                built and tested across macOS, Windows and Linux — we build the things we tell you we build.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-primary/10">
        <div className="max-w-4xl mx-auto px-6 py-6 flex items-center justify-between gap-4">
          <span className="text-[10px] text-ink-max font-mono">MORPHEUS · MORPHEOS · AIRMATRIX</span>
          <Link to="/" className="text-xs text-primary/70 hover:text-primary font-display tracking-wider transition-colors">HOME</Link>
        </div>
      </footer>
    </div>
  );
}
