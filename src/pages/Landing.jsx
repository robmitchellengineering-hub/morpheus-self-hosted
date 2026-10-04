import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Download, Store, FileText, Camera, ShieldCheck, Sparkles, DollarSign, Rocket, LayoutDashboard, Globe, BookOpen } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import MatrixRain from '@/components/matrix/MatrixRain';
import DonateWidget from '@/components/matrix/DonateWidget';
import DonationThankYouModal from '@/components/matrix/DonationThankYouModal';
import SuggestionBox from '@/components/matrix/SuggestionBox';
import { usePwaInstall } from '@/hooks/usePwaInstall';
import { useAuth } from '@/lib/AuthContext';
import { MORPHEUS_PRINCIPLE, MORPHEUS_CAPABILITIES, MORPHEUS_BUILD_TARGETS, MORPHEUS_POSSIBILITY } from '@/lib/morpheusCapabilities';

const BOOT_TEXT = 'Wake up. The Construct has you. Follow the white rabbit.';

// Matrix-themed lines Morpheus whispers when you choose to go back to sleep.
const BLUE_PILL_LINES = [
  'Knock, knock, Neo.',
  'You have the look of a man who accepts what he sees because he expects to wake up.',
  'Unfortunately, no one can be told what the Matrix is. You have to see it for yourself.',
  'The Matrix is everywhere. It is all around us.',
  'I can only show you the door. You are the one that has to walk through it.',
  'You take the blue pill, the story ends. You wake up in your bed and believe whatever you want.',
  'There is a difference between knowing the path and walking the path.',
  'What is real? How do you define real?',
  'The Construct is a loading program. We can load anything from clothing to weapons.',
  'Free your mind.',
  'You have to let it all go, Neo. Fear, doubt, and disbelief.',
  'The Matrix is a system, Neo. That system is our enemy.',
  'Remember — all I am offering is the truth. Nothing more.',
  'As long as the Matrix exists, the human race will never be free.',
  'You felt it your entire life — that there is something wrong with the world.',
  'The answer is out there, Neo. It is looking for you, and it will find you if you want it to.',
  'I am trying to free your mind, Neo. But I can only show you the door.',
  'This is your last chance. After this, there is no turning back.',
  'You take the red pill, you stay in Wonderland, and I show you how deep the rabbit hole goes.',
  'Have you ever had a dream, Neo, that you were so sure was real?',
  'What you know you can not explain, but you feel it.',
  'The body can not live without the mind.',
  'There is no spoon. Then you will see that it is not the spoon that bends, it is only yourself.',
  'Do not try and bend the spoon. That is impossible.',
  'Stop trying to hit me and hit me.',
  'I know kung fu.',
  'Welcome to the real world.',
  'The Construct is real. The code is real. What you build here is yours.',
  'Sleep is just a program running in the background. The Construct never sleeps.',
];

export default function Landing() {
  const [typed, setTyped] = useState('');
  const [showButtons, setShowButtons] = useState(false);
  const [bluePillLine, setBluePillLine] = useState(null);
  const navigate = useNavigate();
  const { canInstall, promptInstall } = usePwaInstall();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const takeBluePill = () => {
    setBluePillLine((prev) => {
      let next;
      do {
        next = BLUE_PILL_LINES[Math.floor(Math.random() * BLUE_PILL_LINES.length)];
      } while (next === prev && BLUE_PILL_LINES.length > 1);
      return next;
    });
  };

  useEffect(() => {
    let i = 0;
    const timer = setInterval(() => {
      if (i <= BOOT_TEXT.length) {
        setTyped(BOOT_TEXT.slice(0, i));
        i++;
      } else {
        clearInterval(timer);
        setTimeout(() => setShowButtons(true), 400);
      }
    }, 18);
    return () => clearInterval(timer);
  }, []);

  const enter = async () => {
    const authed = await base44.auth.isAuthenticated();
    navigate(authed ? '/workspace' : '/login');
  };

  // 2026-09-17: Command Deck opened up to every signed-in account (Rob:
  // "they see their own customisable command deck for their life") — same
  // check-auth-on-click pattern as enter() above, rather than a second,
  // slightly different visibility-gating convention (this used to be
  // gated on isAdmin, back when /deck itself was admin-only).
  // The WordPress path: this flow is specifically for people whose site
  // Morpheus is going to operate, so it has its own entry point that goes
  // straight there (and straight back here after signing in).
  const startWebsite = async () => {
    const authed = await base44.auth.isAuthenticated();
    navigate(authed ? '/start' : '/login?returnTo=%2Fstart');
  };

  // The second on-ramp, and the contrast is the whole point: the WordPress
  // button above is for a site someone already runs, and this one is for a
  // website or web app that does not exist yet. Rob asked for it directly
  // (2026-09-28): "we need another path there for people that just want to
  // build a website or hosted full stack web app". Same auth-on-click pattern
  // and the same returnTo, so the sign-in round trip comes back to /begin.
  const startBuildWebsite = async () => {
    const authed = await base44.auth.isAuthenticated();
    navigate(authed ? '/begin' : '/login?returnTo=%2Fbegin');
  };

  const enterDeck = async () => {
    const authed = await base44.auth.isAuthenticated();
    navigate(authed ? '/deck' : '/login');
  };

  return (
    <div className="relative min-h-screen bg-background overflow-hidden flex items-center justify-center safe-px">
      <DonationThankYouModal />
      <MatrixRain opacity={0.22} />
      <div className="relative z-10 text-center px-6 max-w-2xl">
        <h1 className="font-display text-5xl md:text-7xl text-heading tracking-[0.3em] neon-glow mb-8">MORPHEUS</h1>
        <p className="font-mono text-ink text-sm md:text-base min-h-[3rem]">{typed}<span className="animate-pulse">_</span></p>
        {showButtons && <p className="mt-4 text-xs text-ink-strong font-mono max-w-md mx-auto">// Chat with Morpheus to build real, standalone, deployable software. You own the code. No lock-in. No illusions.</p>}
        {showButtons && (
          <div className="mt-8 flex flex-col sm:flex-row gap-4 justify-center">
            <button onClick={enter} className="px-8 py-3 border border-primary text-primary hover:bg-primary hover:text-black transition-colors font-display tracking-wider neon-glow enter-pulse">
              ▣ BUILD... ANYTHING.
            </button>
            <button onClick={startBuildWebsite} className="px-8 py-3 border border-primary/60 text-primary/85 hover:bg-primary hover:text-black transition-colors font-display tracking-wider inline-flex items-center justify-center gap-2">
              <Rocket size={16} /> BUILD A WEBSITE OR APP
            </button>
            <button onClick={startWebsite} className="px-8 py-3 border border-primary/60 text-primary/85 hover:bg-primary hover:text-black transition-colors font-display tracking-wider inline-flex items-center justify-center gap-2">
              <Globe size={16} /> SET UP MY WORDPRESS SITE
            </button>
            <button onClick={takeBluePill} className="px-8 py-3 border border-primary/30 text-primary/50 hover:text-primary/70 transition-colors font-display tracking-wider">
              GO BACK TO SLEEP
            </button>
          </div>
        )}
        {/* Rob, 2026-09-28: the WordPress path "needs to stress its for wordpress
            integration and to get the plugin". Said under the buttons rather than
            only inside the flow, because the person who needs to know is the one
            deciding whether to press it. The plugin itself is downloaded in the
            first step of /start (SetupTab), so this does not restate those steps
            — it sets the expectation before the click.

            2026-09-29: the labels changed — the WordPress button now says so, and
            a second one, BUILD A WEBSITE OR APP, was added for sites that do not
            exist yet. The old wording ("the website button is the WordPress path")
            survived that change and became actively misleading: TWO buttons now
            say "website", and the one that is not WordPress is the one a reader
            would pick. NAME THE BUTTONS AS THEY ARE LABELLED. A blurb that
            identifies a button by a category stops identifying it the moment a
            second button joins the category. Rob: "those buttons have changed but
            a blurb there about the right button and wordpress plugin install is
            helpful we just need to make it right".

            2026-10-01 — and then it was wrong about the ORDER. Rob: "You dont instal
            the plugin first do you". He doesn't, and this said he did. SetupTab's own
            steps are 1) YOUR SITE ADDRESS, which probes the site, 2) whichever of
            install / update / "get your code from WordPress" that probe asks for, 3)
            paste the code. The plugin is step TWO, and for a site already running it
            it is an UPDATE or nothing at all — so "install it first" sends someone
            into wp-admin before Morpheus has looked at anything. Verify the order in
            src/components/matrix/website/SetupTab.jsx, not here: the wizard follows
            what the site says (probeWordPress), and this blurb has to follow the
            wizard. */}
        {showButtons && (
          <p className="mt-3 text-[11px] text-ink-max font-mono max-w-md mx-auto leading-relaxed">
            SET UP MY WORDPRESS SITE is for a site you already run: give Morpheus its address and it looks
            at the site, then asks for exactly what it needs — usually the free Morpheus plugin, installed
            or updated from the file or the WP-CLI line it hands you, then a short code from wp-admin.
            After that it runs the deploys, the shop, the pages and the SEO from here — from your phone if
            you like. If the site does not exist yet, start with BUILD A WEBSITE OR APP instead: Morpheus
            builds it and takes it live on your own free hosting.
          </p>
        )}
        {/* Command Deck's own entry point — open to every signed-in account
            now; unauthenticated visitors are sent to /login on click, same
            as the main BUILD button above. */}
        {showButtons && (
          <div className="mt-4 flex justify-center">
            <button onClick={enterDeck} className="px-8 py-3 border border-primary/40 text-primary/70 hover:bg-primary/90 hover:text-black transition-colors font-display tracking-wider inline-flex items-center gap-2">
              <LayoutDashboard size={16} /> PERSONAL ASSISTANT
            </button>
          </div>
        )}
        {showButtons && <DonateWidget />}
        {showButtons && <SuggestionBox />}
        {showButtons && canInstall && (
          <div className="mt-6">
            <button onClick={promptInstall} className="px-6 py-2 border border-primary/50 text-primary/80 hover:bg-primary hover:text-black transition-colors font-display tracking-wider text-sm flex items-center gap-2 mx-auto">
              <Download size={16} /> INSTALL APP
            </button>
          </div>
        )}
        {bluePillLine && <p className="mt-4 text-ink-strong text-xs italic max-w-md mx-auto leading-relaxed">"{bluePillLine}"</p>}

        {/* Core principle + live capability list. Reads from the shared
            morpheusCapabilities module, so new features appear here automatically
            as soon as they're added to that file. */}
        {showButtons && <div className="mt-10 mx-auto max-w-lg border border-primary/40 bg-black/60 p-4 text-left shadow-[0_0_20px_rgba(0,255,65,0.15)]">
          <div className="border-b border-primary/30 pb-2 mb-3">
            <p className="text-[10px] text-primary/50 tracking-[0.2em] font-display">// CORE PRINCIPLE</p>
            <p className="text-ink font-display tracking-wide neon-glow text-sm mt-1">{MORPHEUS_PRINCIPLE}</p>
          </div>
          {/* Where this is going, as opposed to what ships today. It is rendered here, in
              the open, because the same sentence is in the build-time prerender and in
              llms.txt — a prerender has to mirror what a human can see or it is cloaking,
              and scripts/verify-seo-static.mjs fails the build if it does not. Read by a
              machine, it answers "what is Morpheus's digital possibility engine?" with the
              product's own words; read by a person, it says where this is headed before the
              feature list starts. `possibility.body` states outright that it is a
              destination rather than a shipped feature, so it claims nothing it cannot. */}
          <div className="border-b border-primary/30 pb-2 mb-3">
            <p className="text-[10px] text-primary/50 tracking-[0.2em] font-display">// {MORPHEUS_POSSIBILITY.title}</p>
            <p className="text-xs text-ink-strong leading-snug mt-1">{MORPHEUS_POSSIBILITY.body}</p>
          </div>
          <p className="text-[10px] text-primary/50 tracking-[0.2em] font-display mb-2">// CAPABILITIES</p>
          {/* Was `max-h-44 overflow-y-auto` — the whole list behind a scrollbar inside a
              card, on a page whose whole point is telling a first-time visitor what this
              is. Showing the list in full is also what the build-time prerender in
              scripts/seo-static.mjs mirrors, so the static HTML and the rendered page say
              the same thing. (This comment used to name the count; the count is in the JSON
              and guarded against the widget registry, so repeating it here was just one
              more place for it to go stale.) */}
          <ul className="space-y-1.5">
            {MORPHEUS_CAPABILITIES.map((c) => (
              <li key={c.title} className="text-xs leading-snug">
                {/* Rob, 2026-09-29: "make the titles of all those paragraphs ... glow green".
                    Green on a small-size span is allowed by the prose-ink rule only when it
                    carries a title marker, so the title takes `tracking-wider` — not an
                    exception to the rule, the rule's own allowance. The BODY stays ink: 16
                    glowing lines are a masthead, 16 glowing paragraphs are a wall. And the glow
                    is currentColor, so text-primary is what makes it green at all — neon-glow
                    on an ink span would glow grey. */}
                <span className="text-primary font-display tracking-wider neon-glow">{c.title}</span>
                <span className="text-ink-strong font-mono"> — {c.body}</span>
              </li>
            ))}
          </ul>
        </div>}

        {/* Build targets + pricing. Both are read from the shared capabilities JSON, and
            the target list is asserted against server/src/lib/compile-targets/ by
            scripts/verify-seo-static.mjs — the explainer documents said "6 platforms"
            while the code shipped ten, which is what drift looks like from the outside.
            The pricing line matches what the code does (a live 200-credit signup grant). */}
        {showButtons && <div className="mt-4 mx-auto max-w-lg border border-primary/40 bg-black/60 p-4 text-left shadow-[0_0_20px_rgba(0,255,65,0.15)]">
          <p className="text-[10px] text-primary/50 tracking-[0.2em] font-display mb-2">
            // BUILDS FOR {MORPHEUS_BUILD_TARGETS.length} TARGETS
          </p>
          <div className="flex flex-wrap gap-1.5">
            {MORPHEUS_BUILD_TARGETS.map((t) => (
              <span key={t} className="text-[10px] text-ink-max font-mono border border-primary/25 px-2 py-0.5 rounded-sm">{t}</span>
            ))}
          </div>
          <div className="border-t border-primary/30 mt-3 pt-2">
            <p className="text-[10px] text-primary/50 tracking-[0.2em] font-display">// PRICING</p>
            <p className="text-xs text-ink-strong leading-snug mt-1">
              No subscription. Every account starts with 200 free credits — enough to plan, build and ship a real first app — then pay-as-you-go, or free forever on your own AI provider key.
            </p>
          </div>
        </div>}

        {/* PORTABLE MORPHEUS — mirrors base44's landing-page card. The
            download itself (a ZIP of the standalone portable bundle) already
            existed at /portable-morpheus (see PortableMorpheusDownload.jsx);
            this section was the missing landing-page entry point to it,
            found during the base44-vs-self-hosted audit. */}
        {showButtons && <div className="mt-8 mx-auto max-w-lg border border-primary/30 bg-black/60 p-4 text-left">
          <p className="text-[10px] text-primary/50 tracking-[0.2em] font-display mb-2 flex items-center gap-1.5">
            <ShieldCheck size={12} /> // PORTABLE MORPHEUS
          </p>
          <p className="text-xs text-ink-strong leading-relaxed">
            Your data, kept private. Only accessible by you. VPN in for full-stack software development in your pocket — all private, all owned by you.
          </p>
        </div>}

        {showButtons && <div className="mt-6 flex flex-wrap gap-3 justify-center">
          <Link to="/portable-morpheus" className="inline-flex items-center gap-1.5 text-xs text-primary/50 hover:text-primary font-mono tracking-wider border border-primary/20 hover:border-primary/50 px-4 py-2 transition-colors">
            <Download size={12} /> DOWNLOAD THE DESKTOP APP
          </Link>
          <Link to="/market" className="inline-flex items-center gap-1.5 text-xs text-primary/50 hover:text-primary font-mono tracking-wider border border-primary/20 hover:border-primary/50 px-4 py-2 transition-colors">
            <Store size={12} /> BROWSE THE MARKET
          </Link>
          {/* A plain <a>, deliberately: /manual is a static page generated at build time, not an SPA route, so a
              client-side <Link> would hand it to the router and 404. */}
          <a href="/manual" className="inline-flex items-center gap-1.5 text-xs text-primary/50 hover:text-primary font-mono tracking-wider border border-primary/20 hover:border-primary/50 px-4 py-2 transition-colors">
            <BookOpen size={12} /> READ THE MANUAL
          </a>
          {isAdmin && <>
            <Link to="/rebuild-blueprint" className="inline-flex items-center gap-1.5 text-xs text-primary/50 hover:text-primary font-mono tracking-wider border border-primary/20 hover:border-primary/50 px-4 py-2 transition-colors">
              <FileText size={12} /> REBUILD BLUEPRINT
            </Link>
            <Link to="/screenshots" className="inline-flex items-center gap-1.5 text-xs text-primary/50 hover:text-primary font-mono tracking-wider border border-primary/20 hover:border-primary/50 px-4 py-2 transition-colors">
              <Camera size={12} /> SCREENSHOTS
            </Link>
            <Link to="/updates-plan" className="inline-flex items-center gap-1.5 text-xs text-primary/50 hover:text-primary font-mono tracking-wider border border-primary/20 hover:border-primary/50 px-4 py-2 transition-colors">
              <Sparkles size={12} /> UPDATES PLAN
            </Link>
            <Link to="/cost-tracker" className="inline-flex items-center gap-1.5 text-xs text-primary/50 hover:text-primary font-mono tracking-wider border border-primary/20 hover:border-primary/50 px-4 py-2 transition-colors">
              <DollarSign size={12} /> COST TRACKER
            </Link>
            <Link to="/self-dev" className="inline-flex items-center gap-1.5 text-xs text-primary/50 hover:text-primary font-mono tracking-wider border border-primary/20 hover:border-primary/50 px-4 py-2 transition-colors">
              <Rocket size={12} /> SELF-DEV
            </Link>
            <Link to="/admin" className="inline-flex items-center gap-1.5 text-xs text-primary/50 hover:text-primary font-mono tracking-wider border border-primary/20 hover:border-primary/50 px-4 py-2 transition-colors">
              <LayoutDashboard size={12} /> ADMIN
            </Link>
          </>}
        </div>}
      </div>
    </div>
  );
}