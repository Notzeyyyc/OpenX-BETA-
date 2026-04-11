/**
 * Runtime config.
 *
 * SECURITY:
 * - Do NOT hardcode secrets in this repository.
 * - Configure them via environment variables (see .env.example).
 *
 * DX:
 * - If a local .env file exists, we load it (best-effort) to populate process.env.
 */

import fs from 'fs';
import path from 'path';

function loadDotEnvIfPresent() {
    // Minimal dotenv parser (no dependency).
    // Only sets variables that are not already present in process.env.
    try {
        const filePath = path.resolve(process.cwd(), '.env');
        if (!fs.existsSync(filePath)) return;
        const raw = fs.readFileSync(filePath, 'utf-8');
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const idx = trimmed.indexOf('=');
            if (idx === -1) continue;
            const key = trimmed.slice(0, idx).trim();
            let val = trimmed.slice(idx + 1).trim();
            if (!key) continue;
            // strip simple surrounding quotes
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }
            if (process.env[key] === undefined) {
                process.env[key] = val;
            }
        }
    } catch {
        // ignore
    }
}

loadDotEnvIfPresent();

function splitCsv(value) {
    return String(value || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
}

export const config = {
    /** WhatsApp number or full JID (e.g. 628xxx or 628xxx@s.whatsapp.net) */
    devPhoneNumber: process.env.OPENX_DEV_PHONE_NUMBER || "",

    openrouter: {
        /** Comma-separated list of keys in OPENX_OPENROUTER_API_KEYS */
        apiKeys: splitCsv(process.env.OPENX_OPENROUTER_API_KEYS)
    },

    /** "auto" or a numeric port string */
    adbPort: process.env.OPENX_ADB_PORT || "auto",

    plugins: {
        /** Optional: comma-separated list of npm package names */
        npm: splitCsv(process.env.OPENX_PLUGINS_NPM),
        /** Optional: allow loading plugins without a sha256 pin (NOT recommended) */
        allowUnpinned: (process.env.OPENX_ALLOW_UNPINNED_PLUGINS || "").toLowerCase() === "true",
    },

    /** Optional REST API server (disabled by default). */
    rest: {
        enabled: (process.env.OPENX_REST_ENABLED || '').toLowerCase() === 'true',
        /** Bind address (use 127.0.0.1 by default for safety). */
        host: process.env.OPENX_REST_HOST || '127.0.0.1',
        /** Port to listen on. */
        port: Number(process.env.OPENX_REST_PORT || '8787'),
        /** API key required in query param: ?apikey=... */
        apiKey: process.env.OPENX_REST_API_KEY || 'openx-local-dev',
        /** Max JSON body size for POST endpoints (bytes). */
        maxBodyBytes: Number(process.env.OPENX_REST_MAX_BODY_BYTES || String(256 * 1024)),
    }
};
