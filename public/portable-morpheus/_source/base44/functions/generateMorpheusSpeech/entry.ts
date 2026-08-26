import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { text } = body;
    if (!text || typeof text !== 'string') return Response.json({ error: 'text required' }, { status: 400 });

    const truncated = text.slice(0, 5000);

    const result = await base44.asServiceRole.integrations.Core.GenerateSpeech({
      text: truncated,
      voice: 'storm',
    });

    return Response.json({ audioUrl: result.url });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}