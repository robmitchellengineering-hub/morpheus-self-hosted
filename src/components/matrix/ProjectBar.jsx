import { Download, Plus, ArrowLeft, Terminal, Share2, History, FlaskConical, BarChart3, Store, DollarSign, Settings as SettingsIcon, Hammer, RefreshCw, FileText, Server, Boxes, Zap, Sparkles, BookOpen } from 'lucide-react';
import { Link } from 'react-router-dom';
import { generateManual } from '@/lib/generateManual';
import BuildStamp from './BuildStamp';
import HelpToggle from './HelpToggle';
import HelpHint from './HelpHint';
import SheetSelect from './SheetSelect';

const btnBase = "flex items-center gap-1 text-xs text-primary/70 hover:text-primary px-3 md:px-2.5 h-[44px] md:h-[34px] whitespace-nowrap shrink-0 border border-primary/30 hover:border-primary/60 hover:bg-primary/5 transition-colors";

export default function ProjectBar({ project, onExport, onNew, onBack, onUpdateTarget, onShare, onHistory, onTests, onUsage, onMarket, onSeller, onCompile, onSyncDeps, onRebuild, onBackend, onPipeline, onTogglePolish }) {
  return (
    <div className="flex flex-col border-b border-primary/20 bg-background shrink-0">
      {/* Row 1: project identity + primary action */}
      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={onBack} className="text-primary/60 hover:text-primary shrink-0 flex items-center justify-center p-2 md:p-0 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0">
            <ArrowLeft size={18} />
          </button>
          <Terminal size={18} className="text-primary shrink-0" />
          <span className="text-primary font-display tracking-wider truncate neon-glow">{project.name}</span>
          <span className="text-xs text-primary/75 uppercase border border-primary/30 px-2 py-0.5 shrink-0">{project.status}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <SheetSelect
            value={project.compile_target || 'source'}
            onChange={(v) => onUpdateTarget && onUpdateTarget(v)}
            label="COMPILE TARGET"
            triggerClassName="text-xs px-2 py-1 min-h-[44px] md:min-h-0"
            options={[
              { value: 'source', label: 'source' },
              { value: 'windows-exe', label: 'win .exe' },
              { value: 'mac-app', label: 'mac .app' },
              { value: 'linux-binary', label: 'linux bin' },
              { value: 'android-apk', label: 'android apk' },
              { value: 'ios-app', label: 'ios app' },
              { value: 'python-package', label: 'py pkg' },
              { value: 'web-app', label: 'web app' },
              { value: 'rpi-distro', label: 'rpi distro' },
              { value: 'linux-distro', label: 'linux distro' },
              { value: 'arduino-firmware', label: 'arduino' },
            ]}
          />
          {project.compile_target && project.compile_target !== 'source' && (
            <HelpHint id="github-compile-prominent" title="Compile Binary" body={`Build a real downloadable ${project.compile_target} binary via GitHub Actions. Morpheus pushes your code to a repo, triggers the build, and publishes the artifact as a GitHub Release.`}>
              <button onClick={onCompile} className="flex items-center gap-1 text-xs text-black bg-primary hover:bg-[#39ff14] px-3 py-2.5 md:py-1.5 min-h-[44px] md:min-h-0 transition-colors font-bold neon-border animate-pulse">
                <Hammer size={14} /> COMPILE
              </button>
            </HelpHint>
          )}
          <HelpHint id="zip-export" title="Download ZIP" body="Download your entire project as a ZIP — all source files, package.json, and README. Ready to run locally with zero platform dependency.">
            <button onClick={onExport} className="flex items-center gap-1 text-xs text-black bg-primary hover:bg-[#39ff14] px-3 py-2.5 md:py-1.5 min-h-[44px] md:min-h-0 transition-colors font-bold neon-border">
              <Download size={14} /> ZIP
            </button>
          </HelpHint>
        </div>
      </div>
      {/* Row 2: action buttons */}
      <div className="flex items-center gap-1.5 px-4 py-2 border-t border-primary/10 overflow-x-auto scrollbar-matrix overscroll-none">
        <HelpHint id="new-construct" title="New Construct" body="Create a brand new project. You'll choose a name, description, and compile target — then start building from scratch.">
          <button onClick={onNew} className={btnBase}>
            <Plus size={14} /> NEW
          </button>
        </HelpHint>
        <HelpHint id="history" title="History" body="Browse snapshots of your project from earlier build steps. Restore any past version to roll back changes or recover lost work.">
          <button onClick={onHistory} className={btnBase}>
            <History size={14} /> HISTORY
          </button>
        </HelpHint>
        <HelpHint id="settings" title="Settings" body="Configure your AI provider (platform or custom endpoint), manage deployment connections (Cloudflare, Supabase, Vercel, etc.), and manage your account.">
          <Link to="/settings" className={btnBase}>
            <SettingsIcon size={14} /> SETTINGS
          </Link>
        </HelpHint>
        <HelpHint id="tests" title="Tests" body="Generate and run AI-written test suites for your project. Morpheus analyzes your code and creates test cases to catch bugs before deployment.">
          <button onClick={onTests} className={btnBase}>
            <FlaskConical size={14} /> TESTS
          </button>
        </HelpHint>
        <HelpHint id="usage" title="Usage Meter" body="View your AI compute costs, credit consumption, and activity history. See exactly how much each action costs in USD and credits.">
          <button onClick={onUsage} className={btnBase}>
            <BarChart3 size={14} /> USAGE
          </button>
        </HelpHint>
        <HelpHint id="market" title="Market" body="Browse the public marketplace of community-built templates and projects. Install free or paid templates to kickstart your own build.">
          <button onClick={onMarket} className={btnBase}>
            <Store size={14} /> MARKET
          </button>
        </HelpHint>
        <HelpHint id="earn" title="Earn" body="Publish your project to the marketplace as a paid or free template. Track sales, revenue, and customer downloads.">
          <button onClick={onSeller} className={btnBase}>
            <DollarSign size={14} /> EARN
          </button>
        </HelpHint>
        <HelpToggle />
        <BuildStamp />
        <HelpHint id="sync-deps" title="Sync Dependencies" body="Scans your project files for imports and updates package.json with the correct dependencies. Keeps your project ready to compile and run.">
          <button onClick={onSyncDeps} className={btnBase}>
            <RefreshCw size={14} /> SYNC DEPS
          </button>
        </HelpHint>
        <HelpHint id="polish-ui" title="UI Polish Mode" body="When ON, every chat build runs an extra pass that refines ONLY styling files — spacing, shadows, transitions, responsive breakpoints, empty/loading/error states. It never touches logic. Turn it on when the GUI matters; leave it off for fast simple builds.">
          <button onClick={onTogglePolish} className={`${btnBase} ${project.polish_ui ? 'bg-primary/15 text-primary border-primary/60' : ''}`}>
            <Sparkles size={14} /> POLISH {project.polish_ui ? 'ON' : 'OFF'}
          </button>
        </HelpHint>
        <HelpHint id="github-compile" title="GitHub Compile" body="Compiles your project into a real downloadable binary (APK, .exe, etc.) using GitHub Actions. Morpheus pushes your code to a repo, triggers a build, and publishes the artifact as a GitHub Release you can download. Requires your GitHub account connected.">
          <button onClick={onCompile} className={btnBase}>
            <Hammer size={14} /> GITHUB COMPILE
          </button>
        </HelpHint>
        {project.compile_target && project.compile_target !== 'source' && (
          <HelpHint id="pipeline" title="Auto Pipeline" body="Automated loop: compiles your project, and if the build fails, AI diagnoses and fixes the code, then asks Morpheus in chat to fix remaining issues. Repeats until the build succeeds or you stop it. Shows a timer so you can track how long it runs.">
            <button onClick={onPipeline} className={btnBase}>
              <Zap size={14} /> PIPELINE
            </button>
          </HelpHint>
        )}
        <HelpHint id="backend-dev" title="Backend Development" body="Opens the backend development tool. Morpheus auto-analyzes your frontend and plans the backend — database, API routes, auth. Then generates code and deploys to Cloudflare Workers, Supabase, or packages as a self-hosted Docker / standalone ZIP.">
          <button onClick={onBackend} className={btnBase}>
            <Server size={14} /> BUILD BACKEND
          </button>
        </HelpHint>
        <HelpHint id="share" title="Share / Export" body="Export your project — push to a new GitHub repo, or email the files as a ZIP. Requires your GitHub account connected for the GitHub option.">
          <button onClick={onShare} className={btnBase}>
            <Share2 size={14} /> SHARE
          </button>
        </HelpHint>
        <HelpHint id="architect" title="Architect" body="Open the backend architecture planner. Morpheus designs your database schema, API routes, and infrastructure before writing any code.">
          <Link to="/architect" className={btnBase}>
            <Boxes size={14} /> ARCHITECT
          </Link>
        </HelpHint>
        <HelpHint id="manual" title="User Manual" body="Download the full Morpheus user manual as a searchable PDF. It's generated fresh from the live capability list, so it always covers the latest features.">
          <button onClick={generateManual} className={btnBase}>
            <BookOpen size={14} /> MANUAL
          </button>
        </HelpHint>
      </div>
    </div>
  );
}