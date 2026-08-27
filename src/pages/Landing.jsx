import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Download, Store, FileText, Camera, Network, Cpu, ShieldCheck, Sparkles } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import MatrixRain from '@/components/matrix/MatrixRain';
import DonateWidget from '@/components/matrix/DonateWidget';
import SuggestionBox from '@/components/matrix/SuggestionBox';
import { usePwaInstall } from '@/hooks/usePwaInstall';
import { useAuth } from '@/lib/AuthContext';
import { MORPHEUS_PRINCIPLE, MORPHEUS_CAPABILITIES } from '@/lib/morpheusCapabilities';

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

  return (
    <div className="relative min-h-screen bg-black overflow-hidden flex items-center justify-center safe-px">
      <MatrixRain opacity={0.22} />
      <div className="relative z-10 text-center px-6 max-w-2xl">
        <h1 className="font-display text-5xl md:text-7xl text-[#00ff41] tracking-[0.3em] neon-glow mb-8">MORPHEUS</h1>
        <p className="font-mono text-[#00ff41]/70 text-sm md:text-base min-h-[3rem]">{typed}<span className="animate-pulse">_</span></p>
        {showButtons && (
          <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
            <button onClick={enter} className="px-8 py-3 border border-[#00ff41] text-[#00ff41] hover:bg-[#00ff41] hover:text-black transition-colors font-display tracking-wider neon-glow enter-pulse">
              ▣ ENTER THE MATRIX
            </button>
            <button onClick={takeBluePill} className="px-8 py-3 border border-[#00ff41]/30 text-[#00ff41]/50 hover:text-[#00ff41]/70 transition-colors font-display tracking-wider">
              GO BACK TO SLEEP
            </button>
          </div>
        )}
        {showButtons && <DonateWidget />}
        {showButtons && <SuggestionBox />}
        {showButtons && canInstall && (
          <div className="mt-6">
            <button onClick={promptInstall} className="px-6 py-2 border border-[#00ff41]/50 text-[#00ff41]/80 hover:bg-[#00ff41] hover:text-black transition-colors font-display tracking-wider text-sm flex items-center gap-2 mx-auto">
              <Download size={16} /> INSTALL APP
            </button>
          </div>
        )}
        {bluePillLine && <p className="mt-4 text-[#00ff41]/75 text-xs italic max-w-md mx-auto leading-relaxed">"{bluePillLine}"</p>}

        {/* Core principle + live capability list. Reads from the shared
            morpheusCapabilities module, so new features appear here automatically
            as soon as they're added to that file. */}
        {showButtons && <div className="mt-10 mx-auto max-w-lg border border-[#00ff41]/40 bg-black/60 p-4 text-left shadow-[0_0_20px_rgba(0,255,65,0.15)]">
          <div className="border-b border-[#00ff41]/30 pb-2 mb-3">
            <p className="text-[10px] text-[#00ff41]/50 tracking-[0.2em] font-display">// CORE PRINCIPLE</p>
            <p className="text-[#00ff41] font-display tracking-wide neon-glow text-sm mt-1">{MORPHEUS_PRINCIPLE}</p>
          </div>
          <p className="text-[10px] text-[#00ff41]/50 tracking-[0.2em] font-display mb-2">// CAPABILITIES</p>
          <ul className="space-y-1.5 max-h-44 overflow-y-auto scrollbar-matrix pr-1">
            {MORPHEUS_CAPABILITIES.map((c) => (
              <li key={c.title} className="text-xs leading-snug">
                <span className="text-[#00ff41] font-mono">{c.title}</span>
                <span className="text-[#00ff41]/55 font-mono"> — {c.body}</span>
              </li>
            ))}
          </ul>
        </div>}
        {showButtons && <p className="mt-6 text-xs text-[#00ff41]/65 font-mono max-w-md mx-auto">// Chat with Morpheus to build real, standalone, deployable software. You own the code. No lock-in. No illusions.</p>}

        {/* PORTABLE MORPHEUS — mirrors base44's landing-page card. The
            download itself (a ZIP of the standalone portable bundle) already
            existed at /portable-morpheus (see PortableMorpheusDownload.jsx);
            this section was the missing landing-page entry point to it,
            found during the base44-vs-self-hosted audit. */}
        {showButtons && <div className="mt-8 mx-auto max-w-lg border border-[#00ff41]/30 bg-black/60 p-4 text-left">
          <p className="text-[10px] text-[#00ff41]/50 tracking-[0.2em] font-display mb-2 flex items-center gap-1.5">
            <ShieldCheck size={12} /> // PORTABLE MORPHEUS
          </p>
          <p className="text-xs text-[#00ff41]/70 leading-relaxed">
            Your data, kept private. Only accessible by you. VPN in for full-stack software development in your pocket — all private, all owned by you.
          </p>
        </div>}

        {showButtons && <div className="mt-6 flex flex-wrap gap-3 justify-center">
          <Link to="/portable-morpheus" className="inline-flex items-center gap-1.5 text-xs text-[#00ff41]/50 hover:text-[#00ff41] font-mono tracking-wider border border-[#00ff41]/20 hover:border-[#00ff41]/50 px-4 py-2 transition-colors">
            <Download size={12} /> DOWNLOAD THE DESKTOP APP
          </Link>
          <Link to="/market" className="inline-flex items-center gap-1.5 text-xs text-[#00ff41]/50 hover:text-[#00ff41] font-mono tracking-wider border border-[#00ff41]/20 hover:border-[#00ff41]/50 px-4 py-2 transition-colors">
            <Store size={12} /> BROWSE THE MARKET
          </Link>
          {isAdmin && <>
            <Link to="/rebuild-blueprint" className="inline-flex items-center gap-1.5 text-xs text-[#00ff41]/50 hover:text-[#00ff41] font-mono tracking-wider border border-[#00ff41]/20 hover:border-[#00ff41]/50 px-4 py-2 transition-colors">
              <FileText size={12} /> REBUILD BLUEPRINT
            </Link>
            <Link to="/screenshots" className="inline-flex items-center gap-1.5 text-xs text-[#00ff41]/50 hover:text-[#00ff41] font-mono tracking-wider border border-[#00ff41]/20 hover:border-[#00ff41]/50 px-4 py-2 transition-colors">
              <Camera size={12} /> SCREENSHOTS
            </Link>
            <Link to="/flow-diagram" className="inline-flex items-center gap-1.5 text-xs text-[#00ff41]/50 hover:text-[#00ff41] font-mono tracking-wider border border-[#00ff41]/20 hover:border-[#00ff41]/50 px-4 py-2 transition-colors">
              <Network size={12} /> FLOW DIAGRAM
            </Link>
            <Link to="/ai-docs" className="inline-flex items-center gap-1.5 text-xs text-[#00ff41]/50 hover:text-[#00ff41] font-mono tracking-wider border border-[#00ff41]/20 hover:border-[#00ff41]/50 px-4 py-2 transition-colors">
              <Cpu size={12} /> AI DOCS
            </Link>
            <Link to="/updates-plan" className="inline-flex items-center gap-1.5 text-xs text-[#00ff41]/50 hover:text-[#00ff41] font-mono tracking-wider border border-[#00ff41]/20 hover:border-[#00ff41]/50 px-4 py-2 transition-colors">
              <Sparkles size={12} /> UPDATES PLAN
            </Link>
          </>}
        </div>}
      </div>
    </div>
  );
}