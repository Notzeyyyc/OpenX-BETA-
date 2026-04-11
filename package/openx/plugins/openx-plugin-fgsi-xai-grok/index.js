/**
 * Sample plugin: openx-plugin-fgsi-xai-grok
 *
 * Exposes a tool that calls:
 * https://fgsi.dpdns.org/api/ai/xai-grok
 *
 * Requires:
 * - permission: net.fetch
 * - env: FGSI_API_KEY
 */

export const tools = [
    {
        id: 'xai-grok',
        name: 'FGSI XAI Grok',
        description: 'Proxy to fgsi.dpdns.org xai-grok endpoint',
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                text: { type: 'string', minLength: 1 },
                url: { type: 'string' },
                conversationId: { type: 'string' },
                method: { type: 'string', enum: ['GET', 'POST'], default: 'GET' },
            },
            required: ['text'],
        },
    }
];

export async function runTool({ toolId, input, host }) {
    if (toolId !== 'xai-grok') {
        throw new Error(`Unknown toolId: ${toolId}`);
    }

    const apiKey = process.env.FGSI_API_KEY;
    if (!apiKey) {
        throw new Error('FGSI_API_KEY is not set');
    }

    const text = String(input?.text || '').trim();
    if (!text) throw new Error('text is required');

    const url = input?.url ? String(input.url) : '';
    const conversationId = input?.conversationId ? String(input.conversationId) : '';
    const method = String(input?.method || 'GET').toUpperCase();

    const endpoint = new URL('https://fgsi.dpdns.org/api/ai/xai-grok');
    endpoint.searchParams.set('apikey', apiKey);
    endpoint.searchParams.set('text', text);
    if (url) endpoint.searchParams.set('url', url);
    if (conversationId) endpoint.searchParams.set('conversationId', conversationId);

    // Support GET or POST; for POST we still keep params in query because that matches your example.
    const res = await host.net.fetch({
        url: endpoint.toString(),
        method: method === 'POST' ? 'POST' : 'GET',
        headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
        body: method === 'POST' ? JSON.stringify({}) : undefined,
        timeoutMs: 20_000,
        maxBytes: 512 * 1024,
    });

    // Try to parse JSON, fall back to text.
    let parsed = null;
    try { parsed = JSON.parse(res.text); } catch {}
    return { http: { status: res.status }, data: parsed ?? res.text };
}

// Optional: still compatible with WA plugin hook.
export async function onMessage() {
    return { handled: false };
}

