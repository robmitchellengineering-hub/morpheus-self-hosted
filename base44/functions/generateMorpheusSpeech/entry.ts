import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// "storm" is the deepest, most authoritative voice in the built-in
// GenerateSpeech engine — the default Morpheus voice.
const DEFAULT_VOICE = 'storm';

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { text } = body;
    if (!text || typeof text !== 'string') return Response.json({ error: 'text required' }, { status: 400 });

    const truncated = text.slice(0, 5000);

    // Load the user's TTS settings (if any).
    let ttsMode = 'default';
    let ttsEngine = 'elevenlabs';
    let ttsApiKey = '';
    let ttsVoiceId = '';
    let ttsEndpoint = '';
    try {
      const rows = await base44.entities.UserSettings.filter({}, '-updated_date', 1);
      const s = rows[0];
      if (s) {
        ttsMode = s.tts_mode || 'default';
        ttsEngine = s.tts_engine || 'elevenlabs';
        ttsApiKey = s.tts_api_key || '';
        ttsVoiceId = s.tts_voice_id || '';
        ttsEndpoint = s.tts_endpoint || '';
      }
    } catch (e) {
      console.log('TTS settings load failed, using default voice:', e?.message || e);
    }

    // Default path: deepest built-in voice.
    if (ttsMode !== 'custom' || !ttsApiKey) {
      const result = await base44.asServiceRole.integrations.Core.GenerateSpeech({
        text: truncated,
        voice: DEFAULT_VOICE,
      });
      return Response.json({ audioUrl: result.url });
    }

    let audioUrl: string | null = null;

    if (ttsEngine === 'elevenlabs') {
      const voiceId = ttsVoiceId || 'onJ4XMQ5sm1S2pQW5bK2';
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': ttsApiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text: truncated,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        return Response.json({ error: `ElevenLabs error: ${err.slice(0, 300)}` }, { status: 502 });
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      audioUrl = `data:audio/mpeg;base64,${bytesToBase64(bytes)}`;
    } else if (ttsEngine === 'openai') {
      const voice = ttsVoiceId || 'onyx'; // onyx = deepest OpenAI voice
      const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ttsApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'tts-1',
          input: truncated,
          voice: voice,
          response_format: 'mp3',
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        return Response.json({ error: `OpenAI TTS error: ${err.slice(0, 300)}` }, { status: 502 });
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      audioUrl = `data:audio/mpeg;base64,${bytesToBase64(bytes)}`;
    } else {
      // Custom HTTP endpoint: POST { text, voice } → audio bytes or { audioUrl }.
      if (!ttsEndpoint) {
        return Response.json({ error: 'Custom TTS endpoint not configured' }, { status: 400 });
      }
      const res = await fetch(ttsEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ttsApiKey ? { 'Authorization': `Bearer ${ttsApiKey}` } : {}),
        },
        body: JSON.stringify({ text: truncated, voice: ttsVoiceId || 'morpheus' }),
      });
      if (!res.ok) {
        const err = await res.text();
        return Response.json({ error: `Custom TTS error: ${err.slice(0, 300)}` }, { status: 502 });
      }
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const data = await res.json();
        audioUrl = data.audioUrl || data.url || data.audio_url;
        if (!audioUrl) return Response.json({ error: 'Custom TTS returned no audioUrl' }, { status: 502 });
      } else {
        const bytes = new Uint8Array(await res.arrayBuffer());
        audioUrl = `data:${ct || 'audio/mpeg'};base64,${bytesToBase64(bytes)}`;
      }
    }

    return Response.json({ audioUrl });
  } catch (error) {
    console.error('generateMorpheusSpeech error:', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}