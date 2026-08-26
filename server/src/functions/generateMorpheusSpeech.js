// Ported from base44/functions/generateMorpheusSpeech/entry.ts.
//
// Base44's "default path" used a platform-hosted GenerateSpeech service
// (the "storm" voice) that has no self-hosted equivalent. Per
// MORPHEUS-PRIMER.md this was already documented as legacy — "browser
// speechSynthesis as automatic fallback when unconfigured" — so here the
// default path simply tells the client to use its own speechSynthesis
// (useMorpheusVoice.js already does this, zero server cost) instead of
// erroring. The three real TTS engine integrations (ElevenLabs, OpenAI,
// custom) are ported verbatim for when a user configures one.
import { prisma } from '../db.js';
import { decrypt } from '../crypto.js';
import { logUsage } from '../lib/projectUtils.js';

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return Buffer.from(bin, 'binary').toString('base64');
}

export default async function handler({ user, body }) {
  const { text } = body;
  if (!text || typeof text !== 'string') throw Object.assign(new Error('text required'), { status: 400 });

  const truncated = text.slice(0, 5000);

  const settings = await prisma.userSettings.findUnique({ where: { created_by_id: user.id } });
  const ttsMode = settings?.tts_mode || 'default';
  const ttsEngine = settings?.tts_engine || 'elevenlabs';
  const ttsApiKey = settings?.tts_api_key ? decrypt(settings.tts_api_key) : '';
  const ttsVoiceId = settings?.tts_voice_id || '';
  const ttsEndpoint = settings?.tts_endpoint || '';

  if (ttsMode !== 'custom' || !ttsApiKey) {
    // No server-side TTS configured — tell the client to fall back to
    // window.speechSynthesis (useMorpheusVoice.js already does this).
    return { audioUrl: null, useBrowserFallback: true };
  }

  let audioUrl = null;

  if (ttsEngine === 'elevenlabs') {
    const voiceId = ttsVoiceId || 'onJ4XMQ5sm1S2pQW5bK2';
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': ttsApiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: truncated,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw Object.assign(new Error(`ElevenLabs error: ${err.slice(0, 300)}`), { status: 502 });
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    audioUrl = `data:audio/mpeg;base64,${bytesToBase64(bytes)}`;
  } else if (ttsEngine === 'openai') {
    const voice = ttsVoiceId || 'onyx';
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ttsApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', input: truncated, voice, response_format: 'mp3' }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw Object.assign(new Error(`OpenAI TTS error: ${err.slice(0, 300)}`), { status: 502 });
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    audioUrl = `data:audio/mpeg;base64,${bytesToBase64(bytes)}`;
  } else {
    if (!ttsEndpoint) throw Object.assign(new Error('Custom TTS endpoint not configured'), { status: 400 });
    const res = await fetch(ttsEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(ttsApiKey ? { Authorization: `Bearer ${ttsApiKey}` } : {}) },
      body: JSON.stringify({ text: truncated, voice: ttsVoiceId || 'morpheus' }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw Object.assign(new Error(`Custom TTS error: ${err.slice(0, 300)}`), { status: 502 });
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = await res.json();
      audioUrl = data.audioUrl || data.url || data.audio_url;
      if (!audioUrl) throw Object.assign(new Error('Custom TTS returned no audioUrl'), { status: 502 });
    } else {
      const bytes = new Uint8Array(await res.arrayBuffer());
      audioUrl = `data:${ct || 'audio/mpeg'};base64,${bytesToBase64(bytes)}`;
    }
  }

  await logUsage(user.id, 'voice_generation', '', '', { engine: ttsEngine });
  return { audioUrl };
}
