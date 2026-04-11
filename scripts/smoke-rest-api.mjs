/**
 * Smoke test (manual): REST API endpoints.
 *
 * Usage:
 *   OPENX_REST_ENABLED=true OPENX_REST_API_KEY=openx-local-dev node scripts/smoke-rest-api.mjs
 *
 * Note: This script assumes the OpenX process is already running with REST enabled.
 */

const host = process.env.OPENX_REST_HOST || '127.0.0.1';
const port = process.env.OPENX_REST_PORT || '8787';
const apikey = process.env.OPENX_REST_API_KEY || 'openx-local-dev';

const base = `http://${host}:${port}`;

async function getJson(path) {
    const res = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(apikey)}`);
    return { status: res.status, json: await res.json() };
}

async function postJson(path, body) {
    const res = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(apikey)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, json: await res.json() };
}

function print(label, result) {
    // eslint-disable-next-line no-console
    console.log(`\n## ${label} (${result.status})\n${JSON.stringify(result.json, null, 2)}`);
}

print('GET /api/health', await getJson('/api/health'));
print('GET /api/plugins', await getJson('/api/plugins'));
print('GET /api/tools', await getJson('/api/tools'));

// Example execute (will fail unless plugin enabled)
print(
    'POST /api/tools/execute (example fgsi tool, expected to fail unless enabled + FGSI_API_KEY set)',
    await postJson('/api/tools/execute', { toolId: 'openx-plugin-fgsi-xai-grok/xai-grok', input: { text: 'ping', method: 'GET' } })
);

