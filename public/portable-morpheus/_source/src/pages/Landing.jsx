import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Download, Store } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import MatrixRain from '@/components/matrix/MatrixRain';
import { usePwaInstall } from '@/hooks/usePwaInstall';

const BOOT_TEXT = 'Wake up. The Construct has you. Follow the white rabbit.';

export default function Landing() {
  const [typed, setTyped] = useState('');
  const [showButtons, setShowButtons] = useState(false);
  const [bluePill, setBluePill] = useState(false);
  const navigate = useNavigate();
  const { canInstall, promptInstall } = usePwaInstall();

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
    }, 45);
    return () => clearInterval(timer);
  }, []);

  const enter = async () => {
    const authed = await base44.auth.isAuthenticated();
    navigate(authed ? '/workspace' : '/login');
  };

  return (
    <div className="relative min-h-screen bg-black overflow-hidden flex items-center justify-center safe-px">
      <MatrixRain opacity={0.12} />
      <div className="relative z-10 text-center px-6 max-w-2xl">
        <h1 className="font-display text-5xl md:text-7xl text-[#00ff41] tracking-[0.3em] neon-glow mb-8">MORPHEUS</h1>
        <p className="font-mono text-[#00ff41]/70 text-sm md:text-base min-h-[3rem]">{typed}<span className="animate-pulse">_</span></p>
        {showButtons && (
          <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
            <button onClick={enter} className="px-8 py-3 border border-[#00ff41] text-[#00ff41] hover:bg-[#00ff41] hover:text-black transition-colors font-display tracking-wider neon-glow">
              ▣ ENTER THE MATRIX
            </button>
            <button onClick={() => { setBluePill(true); setTimeout(() => setBluePill(false), 2500); }} className="px-8 py-3 border border-[#00ff41]/30 text-[#00ff41]/50 hover:text-[#00ff41]/70 transition-colors font-display tracking-wider">
              GO BACK TO SLEEP
            </button>
          </div>
        )}
        {showButtons && canInstall && (
          <div className="mt-6">
            <button onClick={promptInstall} className="px-6 py-2 border border-[#00ff41]/50 text-[#00ff41]/80 hover:bg-[#00ff41] hover:text-black transition-colors font-display tracking-wider text-sm flex items-center gap-2 mx-auto">
              <Download size={16} /> INSTALL APP
            </button>
          </div>
        )}
        {bluePill && <p className="mt-4 text-[#00ff41]/75 text-xs italic">Knock, knock, Neo.</p>}
        <p className="mt-12 text-xs text-[#00ff41]/65 font-mono max-w-md mx-auto">// Chat with Morpheus to build real, standalone, deployable software. You own the code. No lock-in. No illusions.</p>
        <Link to="/market" className="mt-6 inline-flex items-center gap-1.5 text-xs text-[#00ff41]/50 hover:text-[#00ff41] font-mono tracking-wider border border-[#00ff41]/20 hover:border-[#00ff41]/50 px-4 py-2 transition-colors">
          <Store size={12} /> BROWSE THE MARKET
        </Link>
      </div>
    </div>
  );
}