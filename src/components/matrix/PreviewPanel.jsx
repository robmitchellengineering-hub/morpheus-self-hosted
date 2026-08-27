import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { Eye, X, RefreshCw, ExternalLink, Loader2, AlertTriangle, Monitor, Smartphone, Tablet, Cpu, Maximize } from 'lucide-react';
import { buildPreviewHtml } from '@/lib/buildPreviewHtml';
import { base44 } from '@/api/base44Client';
import CacheRefreshStamp from './CacheRefreshStamp';
import HelpHint from './HelpHint';
import SheetSelect from './SheetSelect';

const NATIVE_TARGETS = ['android-apk', 'ios-app', 'windows-exe', 'mac-app', 'linux-binary', 'python-package', 'rpi-distro', 'arduino-firmware'];

// Target screen presets. `auto` fills the container (legacy behaviour);
// the rest render at a fixed resolution and scale down to fit.
const DEVICES = [
  { id: 'auto', label: 'AUTO FIT', w: null, h: null, icon: Maximize },
  { id: 'desktop', label: 'DESKTOP · 1920×1080', w: 1920, h: 1080, icon: Monitor },
  { id: 'laptop', label: 'LAPTOP · 1366×768', w: 1366, h: 768, icon: Monitor },
  { id: 'tablet', label: 'TABLET · 768×1024', w: 768, h: 1024, icon: Tablet },
  { id: 'mobile', label: 'MOBILE · 375×667', w: 375, h: 667, icon: Smartphone },
  { id: 'rpi7', label: 'RPI 7" · 1024×600', w: 1024, h: 600, icon: Cpu },
  { id: 'rpi5', label: 'RPI 5" · 800×480', w: 800, h: 480, icon: Cpu },
  { id: 'custom', label: 'CUSTOM', w: null, h: null, icon: Monitor },
];

export default function PreviewPanel({ files, projectId, compileTarget, onClose }) {
  const [html, setHtml] = useState('');
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState(null);
  const [key, setKey] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);

  // Device framing state
  const [deviceId, setDeviceId] = useState('auto');
  const [customW, setCustomW] = useState(1280);
  const [customH, setCustomH] = useState(720);
  const stageRef = useRef(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });

  const isNative = NATIVE_TARGETS.includes(compileTarget);
  const fileSig = files.map(f => f.path + ':' + (f.content || '').length).join('|');

  // Measure the available stage area so we can scale a fixed-resolution
  // device frame down to fit it entirely.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStageSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const device = DEVICES.find(d => d.id === deviceId) || DEVICES[0];
  const dw = deviceId === 'custom' ? Math.max(1, parseInt(customW) || 1280) : device.w;
  const dh = deviceId === 'custom' ? Math.max(1, parseInt(customH) || 720) : device.h;
  const isFramed = deviceId !== 'auto' && dw && dh && stageSize.w > 0 && stageSize.h > 0;
  const scale = isFramed ? Math.min(stageSize.w / dw, stageSize.h / dh) : 1;

  // Web app / source: synchronous in-browser build
  useEffect(() => {
    if (isNative) return;
    setBuilding(true);
    setError(null);
    try {
      const h = buildPreviewHtml(files);
      setHtml(h);
      setKey(k => k + 1);
    } catch (e) {
      setError(e.message);
    } finally {
      setBuilding(false);
    }
  }, [fileSig, isNative]); // eslint-disable-line react-hooks/exhaustive-deps

  // Native: async LLM prototype generation (debounced — rapid edits settle
  // before triggering the expensive LLM call, and the previous prototype
  // stays visible during regeneration so the user can keep iterating)
  useEffect(() => {
    if (!isNative || !projectId) return;
    let cancelled = false;
    let timer;
    const generate = async () => {
      setBuilding(true);
      setError(null);
      try {
        const res = await base44.functions.invoke('generateNativePrototype', { projectId });
        if (!cancelled) {
          setHtml(res.data.html || '');
          setKey(k => k + 1);
        }
      } catch (e) {
        if (!cancelled) setError(e.message || 'Prototype generation failed');
      } finally {
        if (!cancelled) setBuilding(false);
      }
    };
    // 2-second debounce: lets the user make multiple quick edits before
    // triggering a regeneration. Manual refresh (refreshKey) bypasses it.
    const delay = refreshKey > 0 && html ? 2000 : 0;
    timer = setTimeout(generate, delay);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [fileSig, isNative, projectId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const rebuild = useCallback(() => {
    if (isNative) {
      setRefreshKey(k => k + 1);
    } else {
      setBuilding(true);
      setError(null);
      try {
        const h = buildPreviewHtml(files);
        setHtml(h);
        setKey(k => k + 1);
      } catch (e) {
        setError(e.message);
      } finally {
        setBuilding(false);
      }
    }
  }, [files, isNative]);

  const openInNewTab = () => {
    if (!html) return;
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };

  return (
    <div className="flex flex-col h-full bg-black">
      <div className="flex items-center justify-between border-b border-primary/20 px-3 py-2 shrink-0 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Eye size={14} className="text-primary shrink-0" />
          <span className="text-primary font-display tracking-wider text-sm neon-glow whitespace-nowrap">
            {isNative ? 'RAPID PROTOTYPE' : 'LIVE PREVIEW'}
          </span>
          {building && <Loader2 size={12} className="animate-spin text-primary/60 shrink-0" />}
          <CacheRefreshStamp />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <HelpHint id="preview-device" title="Preview Screen Sizes" body="Preview your web app at different screen sizes. Pick a device preset (desktop, mobile, tablet, Raspberry Pi) or set a custom resolution. The preview auto-scales to fit the panel. Use the refresh button to rebuild after code changes.">
            <SheetSelect
              value={deviceId}
              onChange={setDeviceId}
              label="TARGET SCREEN SIZE"
              options={DEVICES.map(d => ({ value: d.id, label: d.label }))}
              triggerClassName="text-xs px-1.5 py-1 max-w-[150px] sm:max-w-none border-primary/40"
            />
          </HelpHint>
          {deviceId === 'custom' && (
            <div className="flex items-center gap-1">
              <input
                type="number"
                value={customW}
                onChange={e => setCustomW(e.target.value)}
                className="w-14 text-xs bg-black text-primary border border-primary/40 px-1 py-1 outline-none"
                title="Width (px)"
              />
              <span className="text-primary/50 text-xs">×</span>
              <input
                type="number"
                value={customH}
                onChange={e => setCustomH(e.target.value)}
                className="w-14 text-xs bg-black text-primary border border-primary/40 px-1 py-1 outline-none"
                title="Height (px)"
              />
            </div>
          )}
          <button onClick={rebuild} className="text-primary/60 hover:text-primary p-1" title="Refresh preview">
            <RefreshCw size={14} />
          </button>
          <button onClick={openInNewTab} className="text-primary/60 hover:text-primary p-1" title="Open in new tab">
            <ExternalLink size={14} />
          </button>
          {onClose && (
            <button onClick={onClose} className="text-primary/60 hover:text-primary p-1 md:hidden" title="Close preview">
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      {isNative && html && !building && (
        <div className="flex items-center gap-2 border-b border-yellow-500/30 bg-yellow-500/10 px-3 py-1.5 shrink-0">
          <AlertTriangle size={12} className="text-yellow-500 shrink-0" />
          <span className="text-yellow-500/80 text-xs font-mono leading-tight">
            RAPID PROTOTYPE — Visual mockup only. Not the actual native app. Logic flow is simulated.
          </span>
        </div>
      )}
      <div ref={stageRef} className="flex-1 bg-[#0a0a0a] relative overflow-hidden">
        {building && !html ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black gap-2">
            <Loader2 size={24} className="animate-spin text-primary/60" />
            <span className="text-primary/60 text-xs font-mono">
              {isNative ? 'Generating rapid prototype...' : 'Building preview...'}
            </span>
          </div>
        ) : error ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black p-4">
            <div className="text-red-500 text-xs font-mono text-center">// {error}</div>
          </div>
        ) : html ? (
          <div className="relative w-full h-full">
            {isFramed ? (
              <div className="absolute inset-0 flex items-center justify-center overflow-hidden">
                <div
                  style={{
                    width: dw,
                    height: dh,
                    transform: `scale(${scale})`,
                    transformOrigin: 'center center',
                    boxShadow: '0 0 0 1px rgba(0,255,65,0.25), 0 0 24px rgba(0,255,65,0.08)',
                  }}
                  className="bg-white shrink-0"
                >
                  <iframe
                    key={key}
                    srcDoc={html}
                    style={{ width: dw, height: dh, border: 0, display: 'block' }}
                    sandbox="allow-scripts allow-forms allow-popups allow-modals"
                    title={isNative ? 'Rapid Prototype' : 'Live Preview'}
                  />
                </div>
              </div>
            ) : (
              <iframe
                key={key}
                srcDoc={html}
                className="w-full h-full border-0 bg-white"
                sandbox="allow-scripts allow-forms allow-popups allow-modals"
                title={isNative ? 'Rapid Prototype' : 'Live Preview'}
              />
            )}
            {building && (
              <div className="absolute top-2 right-2 flex items-center gap-1.5 bg-black/80 border border-primary/30 px-2 py-1">
                <Loader2 size={11} className="animate-spin text-primary/70" />
                <span className="text-primary/70 text-[10px] font-mono">REGENERATING</span>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-primary/75 text-sm font-mono">
            No files to preview
          </div>
        )}
        {isFramed && !building && html && (
          <div className="absolute bottom-1 left-1/2 -translate-x-1/2 text-primary/50 text-[10px] font-mono bg-black/70 px-2 py-0.5 border border-primary/20 pointer-events-none whitespace-nowrap">
            {dw}×{dh} · {Math.round(scale * 100)}%
          </div>
        )}
      </div>
    </div>
  );
}