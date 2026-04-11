/**
 * package/openx/rest_server.mjs
 *
 * Minimal REST API server (no Express) to:
 * - manage plugins (install/enable/disable/reload/list)
 * - list and execute plugin tools
 *
 * Auth: query param ?apikey=... for all /api/* routes.
 */

import http from 'http';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { config } from '../../config.js';
import {
    listPlugins,
    listTools,
    executeTool,
    reloadPlugins,
    computePluginEntrySha256,
} from './plugin_manager.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(__dirname, '..'); // /package
const PLUGINS_CFG_PATH = path.join(PKG_DIR, 'plugins.json');
const PLUGINS_LOCK_PATH = path.join(PKG_DIR, 'plugins.lock.json');

function json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
    });
    res.end(body);
}

function ok(res, data) {
    return json(res, 200, { ok: true, data });
}

function fail(res, status, code, message, details) {
    return json(res, status, { ok: false, error: { code, message, ...(details ? { details } : {}) } });
}

function safeJsonRead(p, fallback) {
    try {
        if (!fs.existsSync(p)) return fallback;
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
        return fallback;
    }
}

function safeJsonWrite(p, value) {
    fs.writeFileSync(p, JSON.stringify(value, null, 2));
}

function isAllowedPluginPackageName(name) {
    // Supply chain mitigation: allow only openx-plugin-*
    return /^openx-plugin-[a-z0-9-]+$/i.test(String(name || '').trim());
}

function isSafeHttpMethod(method) {
    return method === 'GET' || method === 'POST';
}

function auditLog(event, data) {
    // Do not log secrets (apikeys, bearer tokens, etc).
    try {
        const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
        // eslint-disable-next-line no-console
        console.log(line);
    } catch {
        // ignore
    }
}

async function readJsonBody(req, maxBytes) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > maxBytes) throw new Error('Body too large');
        chunks.push(chunk);
    }
    if (chunks.length === 0) return null;
    const raw = Buffer.concat(chunks).toString('utf-8');
    if (!raw.trim()) return null;
    try {
        return JSON.parse(raw);
    } catch {
        throw new Error('Invalid JSON');
    }
}

function runInstall(pkg) {
    return new Promise((resolve, reject) => {
        // Security: --ignore-scripts to avoid running arbitrary lifecycle scripts.
        // Prefer pnpm, but fall back to npm if pnpm isn't available.
        const tries = [
            { cmd: 'pnpm', args: ['add', '--ignore-scripts', pkg] },
            { cmd: 'corepack', args: ['pnpm', 'add', '--ignore-scripts', pkg] },
            { cmd: 'npm', args: ['install', '--ignore-scripts', pkg] },
        ];

        let i = 0;
        const attempt = () => {
            const t = tries[i++];
            if (!t) return reject(new Error('No package manager found (pnpm/corepack/npm)'));

            const child = spawn(t.cmd, t.args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                cwd: process.cwd(),
            });
            let out = '';
            let err = '';
            child.stdout.on('data', (d) => { out += d.toString('utf-8'); });
            child.stderr.on('data', (d) => { err += d.toString('utf-8'); });
            child.on('error', () => attempt());
            child.on('close', (code) => {
                if (code === 0) return resolve({ tool: t.cmd, out, err });
                // If command exists but failed for package reasons, stop early.
                reject(new Error(`${t.cmd} install failed (code=${code}): ${err || out}`));
            });
        };

        attempt();
    });
}

function upsertPluginConfig({ id, entry, enabled, sandbox, permissions }) {
    const cfg = safeJsonRead(PLUGINS_CFG_PATH, { plugins: [] });
    const plugins = Array.isArray(cfg.plugins) ? cfg.plugins : [];

    const idx = plugins.findIndex((p) => String(p?.id) === String(id));
    const next = {
        id: String(id),
        entry: String(entry),
        enabled: enabled !== false,
        sandbox: !!sandbox,
        permissions: Array.isArray(permissions) ? permissions.map(String) : [],
    };

    if (idx >= 0) plugins[idx] = { ...plugins[idx], ...next };
    else plugins.push(next);

    safeJsonWrite(PLUGINS_CFG_PATH, { ...cfg, plugins });
}

function setPluginEnabled(id, enabled) {
    const cfg = safeJsonRead(PLUGINS_CFG_PATH, { plugins: [] });
    const plugins = Array.isArray(cfg.plugins) ? cfg.plugins : [];
    const idx = plugins.findIndex((p) => String(p?.id) === String(id));
    if (idx < 0) throw new Error('Plugin id not found in config');
    plugins[idx] = { ...plugins[idx], enabled: !!enabled };
    safeJsonWrite(PLUGINS_CFG_PATH, { ...cfg, plugins });
}

function setPluginPin(id, sha256) {
    const lock = safeJsonRead(PLUGINS_LOCK_PATH, { plugins: {} });
    const plugins = (lock && typeof lock.plugins === 'object' && lock.plugins) ? lock.plugins : {};
    plugins[String(id)] = { sha256: String(sha256) };
    safeJsonWrite(PLUGINS_LOCK_PATH, { ...lock, plugins });
}

function requireApiKey(urlObj) {
    const apikey = urlObj.searchParams.get('apikey');
    return apikey && apikey === config.rest.apiKey;
}

export function startRestServer({ notify } = {}) {
    if (!config.rest?.enabled) {
        notify?.('🌐 REST API disabled (set OPENX_REST_ENABLED=true to enable).');
        return { started: false };
    }

    const host = config.rest.host;
    const port = config.rest.port;
    const maxBodyBytes = config.rest.maxBodyBytes;

    const server = http.createServer(async (req, res) => {
        try {
            const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
            const method = String(req.method || 'GET').toUpperCase();

            // Basic per-request audit without leaking apikey.
            auditLog('rest.request', { method, path: urlObj.pathname });

            if (!urlObj.pathname.startsWith('/api/')) {
                return fail(res, 404, 'NOT_FOUND', 'Not found');
            }

            if (!isSafeHttpMethod(method)) {
                return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
            }
            if (!requireApiKey(urlObj)) {
                return fail(res, 401, 'UNAUTHENTICATED', 'Invalid apikey');
            }

            // Health
            if (method === 'GET' && urlObj.pathname === '/api/health') {
                const tools = await listTools();
                const plugins = listPlugins();
                return ok(res, {
                    uptimeSec: Math.floor(process.uptime()),
                    pluginsLoaded: plugins.length,
                    tools: tools.length,
                });
            }

            // Plugins list
            if (method === 'GET' && urlObj.pathname === '/api/plugins') {
                const configured = safeJsonRead(PLUGINS_CFG_PATH, { plugins: [] });
                const loaded = listPlugins();
                return ok(res, { configured, loaded });
            }

            // Reload plugins
            if (method === 'POST' && urlObj.pathname === '/api/plugins/reload') {
                await reloadPlugins();
                return ok(res, { reloaded: true });
            }

            // Enable/disable
            if (method === 'POST' && (urlObj.pathname === '/api/plugins/enable' || urlObj.pathname === '/api/plugins/disable')) {
                const body = await readJsonBody(req, maxBodyBytes);
                const id = String(body?.id || '').trim();
                if (!id) return fail(res, 400, 'BAD_REQUEST', 'id is required');
                const enabled = urlObj.pathname.endsWith('/enable');
                setPluginEnabled(id, enabled);
                await reloadPlugins();
                return ok(res, { id, enabled });
            }

            // Install plugin from npm
            if (method === 'POST' && urlObj.pathname === '/api/plugins/install') {
                const body = await readJsonBody(req, maxBodyBytes);
                const pkg = String(body?.package || '').trim();
                if (!pkg) return fail(res, 400, 'BAD_REQUEST', 'package is required');
                if (!isAllowedPluginPackageName(pkg)) {
                    return fail(res, 400, 'BAD_REQUEST', 'package name not allowed (must match openx-plugin-*)');
                }

                const permissions = Array.isArray(body?.permissions) ? body.permissions : [];
                const sandbox = body?.sandbox === true;

                await runInstall(pkg);

                // Record plugin config and pin
                upsertPluginConfig({
                    id: pkg,
                    entry: pkg,
                    enabled: true,
                    sandbox,
                    permissions,
                });

                const { sha256 } = await computePluginEntrySha256(pkg);
                setPluginPin(pkg, sha256);
                await reloadPlugins();
                return ok(res, { installed: true, id: pkg, sha256 });
            }

            // Tools list
            if (method === 'GET' && urlObj.pathname === '/api/tools') {
                const tools = await listTools();
                return ok(res, tools);
            }

            // Tool execute
            if (method === 'POST' && urlObj.pathname === '/api/tools/execute') {
                const body = await readJsonBody(req, maxBodyBytes);
                const toolId = String(body?.toolId || '').trim();
                if (!toolId) return fail(res, 400, 'BAD_REQUEST', 'toolId is required');
                const input = body?.input;
                const result = await executeTool(toolId, input);
                return ok(res, { toolId, result });
            }

            return fail(res, 404, 'NOT_FOUND', 'Unknown endpoint');
        } catch (e) {
            return fail(res, 500, 'INTERNAL', e?.message || 'Internal error');
        }
    });

    server.listen(port, host, () => {
        notify?.(`🌐 REST API listening on http://${host}:${port} (auth: ?apikey=...)`);
    });

    return {
        started: true,
        host,
        port,
        close: () => server.close(),
    };
}
