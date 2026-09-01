import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2, Eye, EyeOff, Save, Check, Cpu, Brain, Zap, ShieldCheck, Stethoscope, Volume2, Palette } from 'lucide-react';
import DangerZone from '@/components/matrix/DangerZone';
import { base44 } from '@/api/base44Client';
import MatrixRain from '@/components/matrix/MatrixRain';
import ConnectionsSection from '@/components/matrix/ConnectionsSection';
import CapabilityStatus from '@/components/matrix/CapabilityStatus';
import SheetSelect from '@/components/matrix/SheetSelect';
import { useTheme } from '@/contexts/ThemeContext';

const MODEL_OPTIONS = [
  { value: '', label: 'Automatic (platform default — lowest credit cost)' },
  { value: 'gpt_5_mini', label: 'GPT 5 Mini — fast lightweight (lowest cost)', tier: 'fast' },
  { value: 'gemini_3_flash', label: 'Gemini 3 Flash — fast lightweight (lowest cost)', tier: 'fast' },
  { value: 'gpt_5_4', label: 'GPT 5.4 — balanced (medium cost)', tier: 'balanced' },
  { value: 'gpt_5_6_sol', label: 'GPT 5.6 Sol — balanced (medium cost)', tier: 'balanced' },
  { value: 'gpt_5_6_luna', label: 'GPT 5.6 Luna — balanced (medium cost)', tier: 'balanced' },
  { value: 'claude_sonnet_4_6', label: 'Claude Sonnet 4.6 — high think (high cost)', tier: 'high' },
  { value: 'claude-sonnet-5', label: 'Claude Sonnet 5 — high think (high cost)', tier: 'high' },
  { value: 'gemini_3_1_pro', label: 'Gemini 3.1 Pro — high think (high cost)', tier: 'high' },
  { value: 'claude_opus_4_6', label: 'Claude Opus 4.6 — highest think (highest cost)', tier: 'high' },
  { value: 'claude_opus_4_7', label: 'Claude Opus 4.7 — highest think (highest cost)', tier: 'high' },
  { value: 'claude_opus_4_8', label: 'Claude Opus 4.8 — highest think (highest cost)', tier: 'high' },
  { value: 'kimi-k3', label: 'Kimi K3 (Moonshot) — 1M context, agentic coding (high cost)', tier: 'high' },
];

export default function Settings() {
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const [settings, setSettings] = useState(null);
  const [aiMode, setAiMode] = useState('default');
  const [aiBaseUrl, setAiBaseUrl] = useState('');
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [plannerModel, setPlannerModel] = useState('');
  const [coderModel, setCoderModel] = useState('');
  const [reviewerModel, setReviewerModel] = useState('');
  const [diagnosisModel, setDiagnosisModel] = useState('');
  const [ttsMode, setTtsMode] = useState('default');
  const [ttsEngine, setTtsEngine] = useState('elevenlabs');
  const [ttsApiKey, setTtsApiKey] = useState('');
  const [ttsVoiceId, setTtsVoiceId] = useState('');
  const [ttsEndpoint, setTtsEndpoint] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [connections, setConnections] = useState({});

  useEffect(() => {
    base44.entities.UserSettings.filter({}, '-updated_date', 1)
      .then(rows => {
        if (rows[0]) {
          setSettings(rows[0]);
          setAiMode(rows[0].ai_mode || 'default');
          setAiBaseUrl(rows[0].ai_base_url || '');
          setAiApiKey(rows[0].ai_api_key || '');
          setAiModel(rows[0].ai_model || '');
          setPlannerModel(rows[0].planner_model || '');
          setCoderModel(rows[0].coder_model || '');
          setReviewerModel(rows[0].reviewer_model || '');
          setDiagnosisModel(rows[0].diagnosis_model || '');
          setTtsMode(rows[0].tts_mode || 'default');
          setTtsEngine(rows[0].tts_engine || 'elevenlabs');
          setTtsApiKey(rows[0].tts_api_key || '');
          setTtsVoiceId(rows[0].tts_voice_id || '');
          setTtsEndpoint(rows[0].tts_endpoint || '');
          if (rows[0].connections) {
            try { setConnections(JSON.parse(rows[0].connections)); } catch {}
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const payload = {
        ai_mode: aiMode,
        ai_base_url: aiBaseUrl.trim(),
        ai_api_key: aiApiKey.trim(),
        ai_model: aiModel.trim(),
        planner_model: plannerModel,
        coder_model: coderModel,
        reviewer_model: reviewerModel,
        diagnosis_model: diagnosisModel,
        tts_mode: ttsMode,
        tts_engine: ttsEngine,
        tts_api_key: ttsApiKey.trim(),
        tts_voice_id: ttsVoiceId.trim(),
        tts_endpoint: ttsEndpoint.trim(),
        connections: JSON.stringify(connections)
      };
      if (settings?.id) {
        await base44.entities.UserSettings.update(settings.id, payload);
      } else {
        const created = await base44.entities.UserSettings.create(payload);
        setSettings(created);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative min-h-screen bg-background text-primary font-mono">
      <MatrixRain opacity={0.05} />
      <div className="relative z-10 max-w-2xl mx-auto px-6 py-10 safe-top">
        <div className="flex items-center gap-3 mb-8">
          <button onClick={() => navigate('/workspace')} className="text-primary/60 hover:text-primary">
            <ArrowLeft size={18} />
          </button>
          <Cpu size={20} className="text-primary" />
          <h1 className="text-2xl font-display tracking-widest neon-glow text-heading">SETTINGS</h1>
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 size={24} className="animate-spin text-primary/60" />
          </div>
        ) : (
          <>
            <section className="mb-8 border border-primary/30 p-5">
              <h2 className="text-sm font-display tracking-wider mb-1 text-primary flex items-center gap-2">
                <Palette size={14} /> APPEARANCE
              </h2>
              <p className="text-xs text-primary/50 mb-4">
                // Clear is the default look — brighter text and visible panel borders so small print reads easily, plus color-coded status dots. Classic Matrix is the original all-green terminal look. Boring is a plain light/corporate look for anyone the Matrix look isn't for.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <button
                  onClick={() => setTheme('clear')}
                  className={`text-left border p-3 transition-colors ${theme === 'clear' ? 'border-primary bg-primary/10' : 'border-primary/20 hover:border-primary/40'}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-display tracking-wider text-primary">CLEAR (RECOMMENDED)</span>
                    {theme === 'clear' && <Check size={14} className="text-primary" />}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: 'hsl(142 90% 58%)' }} />
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: 'hsl(199 89% 60%)' }} />
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: 'hsl(38 92% 58%)' }} />
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: 'hsl(0 78% 58%)' }} />
                    <span className="text-[10px] text-primary/50 ml-1">higher contrast + color-coded status</span>
                  </div>
                </button>
                <button
                  onClick={() => setTheme('classic')}
                  className={`text-left border p-3 transition-colors ${theme === 'classic' ? 'border-primary bg-primary/10' : 'border-primary/20 hover:border-primary/40'}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-display tracking-wider text-primary">CLASSIC MATRIX</span>
                    {theme === 'classic' && <Check size={14} className="text-primary" />}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#00ff41' }} />
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#00ff41' }} />
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#00ff41' }} />
                    <span className="text-[10px] text-primary/50 ml-1">original all-green terminal look</span>
                  </div>
                </button>
                <button
                  onClick={() => setTheme('boring')}
                  className={`text-left border p-3 transition-colors ${theme === 'boring' ? 'border-primary bg-primary/10' : 'border-primary/20 hover:border-primary/40'}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-display tracking-wider text-primary">BORING</span>
                    {theme === 'boring' && <Check size={14} className="text-primary" />}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#ffffff', border: '1px solid #d0d5dd' }} />
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: 'hsl(217 91% 45%)' }} />
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: 'hsl(220 15% 15%)' }} />
                    <span className="text-[10px] text-primary/50 ml-1">plain light look, rounded corners</span>
                  </div>
                </button>
              </div>
            </section>

            <section className="mb-8 border border-primary/30 p-5">
              <h2 className="text-sm font-display tracking-wider mb-1 text-primary">AI PROVIDER</h2>
              <p className="text-xs text-primary/50 mb-4">
                // Point Morpheus at any OpenAI-compatible endpoint. Default uses the platform brain — no config needed.
              </p>

              <label className="block text-xs text-primary/60 uppercase tracking-wider mb-1">Mode</label>
              <SheetSelect
                value={aiMode}
                onChange={setAiMode}
                label="MODE"
                options={[{ value: 'default', label: 'Default (platform)' }, { value: 'custom', label: 'Custom OpenAI-compatible endpoint' }]}
                triggerClassName="w-full mb-4"
              />

              {aiMode === 'custom' ? (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs text-primary/60 uppercase tracking-wider mb-1">Base URL</label>
                    <input
                      value={aiBaseUrl}
                      onChange={e => setAiBaseUrl(e.target.value)}
                      placeholder="https://api.openai.com/v1"
                      className="w-full bg-background text-primary border border-primary/30 px-3 py-2 text-sm outline-none placeholder:text-primary/20"
                    />
                    <p className="text-xs text-primary/65 mt-1">
                      // e.g. https://api.openai.com/v1 · http://localhost:11434/v1 (Ollama) · https://openrouter.ai/api/v1 · https://api.moonshot.ai/v1 (Kimi K3)
                    </p>
                    <div className="mt-2 border border-primary/20 bg-primary/5 p-2.5 text-xs text-primary/50 space-y-1">
                      <p className="text-primary/70 font-bold uppercase tracking-wider text-[10px]">Free-tier providers:</p>
                      <p>// Google AI Studio — free Gemini Flash, generous limits</p>
                      <p>// Groq — free fast inference (Llama, Mixtral)</p>
                      <p>// OpenRouter — some free models available</p>
                      <p>// Ollama — local, no API key, zero cost (needs GPU)</p>
                      <p className="pt-0.5">// Moonshot AI (Kimi K3) — 1M context, strong at agentic coding. Not free — $1 min top-up required, then pay-as-you-go.</p>
                      <p className="text-yellow-500/60 pt-0.5">// Free tiers have rate limits — heavy autonomous builds may hit them. Use platform default for reliability.</p>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-primary/60 uppercase tracking-wider mb-1">API Key</label>
                    <div className="flex gap-2">
                      <input
                        type={showKey ? 'text' : 'password'}
                        value={aiApiKey}
                        onChange={e => setAiApiKey(e.target.value)}
                        placeholder="sk-..."
                        className="flex-1 bg-background text-primary border border-primary/30 px-3 py-2 text-sm outline-none placeholder:text-primary/20"
                      />
                      <button
                        onClick={() => setShowKey(!showKey)}
                        className="px-3 border border-primary/30 text-primary/60 hover:text-primary"
                        title={showKey ? 'Hide key' : 'Show key'}
                      >
                        {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-primary/60 uppercase tracking-wider mb-1">Model</label>
                    <input
                      value={aiModel}
                      onChange={e => setAiModel(e.target.value)}
                      placeholder="gpt-4o"
                      className="w-full bg-background text-primary border border-primary/30 px-3 py-2 text-sm outline-none placeholder:text-primary/20"
                    />
                  </div>
                </div>
              ) : (
                <p className="text-xs text-primary/75">// Using the platform default. No configuration required.</p>
              )}
            </section>

            <section className="mb-8 border border-primary/30 p-5">
              <h2 className="text-sm font-display tracking-wider mb-1 text-primary flex items-center gap-2">
                <Brain size={14} /> AGENT MODELS
              </h2>
              <p className="text-xs text-primary/50 mb-4">
                // Every agent in the pipeline is individually addressable. All default to automatic — override only when you want a specific model for a specific role. Max think power is enabled (no output token cap).
              </p>
              <div className="mb-4 border border-primary/20 bg-primary/5 p-2.5 text-xs text-primary/50 space-y-1">
                <p className="text-primary/70 font-bold uppercase tracking-wider text-[10px]">Free-tier optimisation:</p>
                <p>// Best free-tier setup: leave all on Automatic (lowest credit cost)</p>
                <p>// Or set Planner → Gemini 3 Flash, Coder → GPT 5 Mini (lowest cost overrides)</p>
                <p>// Reviewer &amp; Diagnosis can stay Automatic — they run less frequently</p>
                <p className="text-yellow-500/60">// Higher-think models (Opus, Sonnet) cost significantly more credits per step</p>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs text-primary/60 uppercase tracking-wider mb-1 flex items-center gap-1.5">
                    <Brain size={12} /> Planner / Reasoning Model
                  </label>
                  <SheetSelect
                    value={plannerModel}
                    onChange={setPlannerModel}
                    label="PLANNER MODEL"
                    options={MODEL_OPTIONS}
                    triggerClassName="w-full"
                  />
                  <p className="text-xs text-primary/65 mt-1">
                    // Used for design reasoning, architecture, aesthetics, and planning. Higher think power = better reliability and UX decisions.
                  </p>
                </div>

                <div>
                  <label className="block text-xs text-primary/60 uppercase tracking-wider mb-1 flex items-center gap-1.5">
                    <Zap size={12} /> Coder / Implementation Model
                  </label>
                  <SheetSelect
                    value={coderModel}
                    onChange={setCoderModel}
                    label="CODER MODEL"
                    options={MODEL_OPTIONS}
                    triggerClassName="w-full"
                  />
                  <p className="text-xs text-primary/65 mt-1">
                    // Used for writing clean, efficient code from the planner's blueprint. Fast lightweight models minimise errors and speed up mobile builds.
                  </p>
                </div>

                <div>
                  <label className="block text-xs text-primary/60 uppercase tracking-wider mb-1 flex items-center gap-1.5">
                    <ShieldCheck size={12} /> Reviewer Model
                  </label>
                  <SheetSelect
                    value={reviewerModel}
                    onChange={setReviewerModel}
                    label="REVIEWER MODEL"
                    options={MODEL_OPTIONS}
                    triggerClassName="w-full"
                  />
                  <p className="text-xs text-primary/65 mt-1">
                    // Reviews code before commit — checks correctness, security, and performance. Defaults to automatic.
                  </p>
                </div>

                <div>
                  <label className="block text-xs text-primary/60 uppercase tracking-wider mb-1 flex items-center gap-1.5">
                    <Stethoscope size={12} /> Diagnosis Model
                  </label>
                  <SheetSelect
                    value={diagnosisModel}
                    onChange={setDiagnosisModel}
                    label="DIAGNOSIS MODEL"
                    options={MODEL_OPTIONS}
                    triggerClassName="w-full"
                  />
                  <p className="text-xs text-primary/65 mt-1">
                    // Diagnoses build, compile, and deploy errors — analyzes failures and regenerates broken files. Defaults to automatic.
                  </p>
                </div>
              </div>
            </section>

            <section className="mb-8 border border-primary/30 p-5">
              <h2 className="text-sm font-display tracking-wider mb-1 text-primary flex items-center gap-2">
                <Volume2 size={14} /> MORPHEUS VOICE
              </h2>
              <p className="text-xs text-primary/50 mb-4">
                // Default uses the deepest built-in voice ("storm"). Point it at a custom TTS engine to make him actually sound like Morpheus.
              </p>

              <label className="block text-xs text-primary/60 uppercase tracking-wider mb-1">Mode</label>
              <SheetSelect
                value={ttsMode}
                onChange={setTtsMode}
                label="VOICE MODE"
                options={[{ value: 'default', label: 'Default (deepest built-in voice)' }, { value: 'custom', label: 'Custom TTS engine' }]}
                triggerClassName="w-full mb-4"
              />

              {ttsMode === 'custom' ? (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs text-primary/60 uppercase tracking-wider mb-1">Engine</label>
                    <SheetSelect
                      value={ttsEngine}
                      onChange={setTtsEngine}
                      label="TTS ENGINE"
                      options={[
                        { value: 'elevenlabs', label: 'ElevenLabs (voice cloning — best for a real Morpheus voice)' },
                        { value: 'openai', label: 'OpenAI TTS (reliable preset voices)' },
                        { value: 'custom', label: 'Custom HTTP endpoint' },
                      ]}
                      triggerClassName="w-full"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-primary/60 uppercase tracking-wider mb-1">API Key</label>
                    <input
                      value={ttsApiKey}
                      onChange={e => setTtsApiKey(e.target.value)}
                      type="password"
                      placeholder={ttsEngine === 'elevenlabs' ? 'xi-...' : 'sk-...'}
                      className="w-full bg-background text-primary border border-primary/30 px-3 py-2 text-sm outline-none placeholder:text-primary/20"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-primary/60 uppercase tracking-wider mb-1">{ttsEngine === 'custom' ? 'Voice label' : 'Voice ID / name'}</label>
                    <input
                      value={ttsVoiceId}
                      onChange={e => setTtsVoiceId(e.target.value)}
                      placeholder={ttsEngine === 'elevenlabs' ? 'Cloned Morpheus voice ID' : ttsEngine === 'openai' ? 'onyx (deepest)' : 'morpheus'}
                      className="w-full bg-background text-primary border border-primary/30 px-3 py-2 text-sm outline-none placeholder:text-primary/20"
                    />
                    <p className="text-xs text-primary/65 mt-1">
                      {ttsEngine === 'elevenlabs' ? '// Create a cloned voice in ElevenLabs, paste its voice ID here.' : ttsEngine === 'openai' ? '// OpenAI voices: onyx (deepest), nova, shimmer, alloy, echo, fable.' : '// Passed as the "voice" field to your custom endpoint.'}
                    </p>
                  </div>
                  {ttsEngine === 'custom' && (
                    <div>
                      <label className="block text-xs text-primary/60 uppercase tracking-wider mb-1">Endpoint URL</label>
                      <input
                        value={ttsEndpoint}
                        onChange={e => setTtsEndpoint(e.target.value)}
                        placeholder="https://your-tts.example.com/synthesize"
                        className="w-full bg-background text-primary border border-primary/30 px-3 py-2 text-sm outline-none placeholder:text-primary/20"
                      />
                      <p className="text-xs text-primary/65 mt-1">// POST {`{ text, voice }`} → audio bytes or {`{ audioUrl }`}. Bearer API key sent if provided.</p>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-primary/75">// Using "storm" — the deepest, most authoritative built-in voice. No configuration required.</p>
              )}
            </section>

            <ConnectionsSection connections={connections} onChange={setConnections} />

            <CapabilityStatus connections={connections} />

            {error && <p className="text-red-500 text-sm mb-4">// ERROR: {error}</p>}

            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-6 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] border border-primary text-primary hover:bg-primary hover:text-black transition-colors disabled:opacity-30"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : saved ? <Check size={16} /> : <Save size={16} />}
              {saving ? 'SAVING' : saved ? 'SAVED' : 'SAVE SETTINGS'}
            </button>

            <DangerZone />
          </>
        )}
      </div>
    </div>
  );
}