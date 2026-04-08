/**
 * SelfUpdate.mjs
 * Allows users to request code edits on any module via WhatsApp.
 * Uses OpenRouter API (google/gemini-2.0-flash-001) to generate updated code.
 * Safety: confirms before applying, auto-rollbacks on import() failure.
 * Only accesses files within /modules/ directory.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import { config } from '../config.js';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const MODULES_DIR  = __dirname;          // /modules/
const MAX_FILE_BYTES = 100 * 1024;       // 100 KB
const API_TIMEOUT_MS = 30 * 1000;        // 30 seconds
const MODEL          = 'google/gemini-2.0-flash-001';

let notifyFn = null;

/** Pending update waiting for user confirmation */
let pendingUpdate = null;

// ─── Safety helpers ───────────────────────────────────────────────────────────

/**
 * Ensure the target file is inside /modules/ and is a .mjs file.
 * @param {string} moduleName - e.g. "BatteryOptimizer" or "BatteryOptimizer.mjs"
 * @returns {string} Absolute path
 * @throws if path escapes modules dir
 */
function resolveModulePath(moduleName) {
    const base     = moduleName.endsWith('.mjs') ? moduleName : `${moduleName}.mjs`;
    const resolved = path.resolve(MODULES_DIR, base);

    // Security: ensure we stay within /modules/
    if (!resolved.startsWith(MODULES_DIR + path.sep) && resolved !== path.join(MODULES_DIR, base)) {
        throw new Error('❌ Akses file di luar folder /modules/ tidak diizinkan.');
    }
    return resolved;
}

/**
 * Basic validation: check the generated code contains ESM keywords and
 * no obvious syntax errors via new Function() (catches non-ESM issues).
 * @param {string} code
 * @returns {boolean}
 */
function validateCode(code) {
    if (!code || typeof code !== 'string') return false;
    if (!code.includes('export')) return false;
    if (!code.includes('import') && !code.includes('export')) return false;

    // Strip ESM-specific syntax for basic Function() check
    const stripped = code
        .replace(/^import .+from .+;?/gm, '')
        .replace(/^export (default |const |let |var |function |class |async )/gm, '$1');

    try {
        // eslint-disable-next-line no-new-func
        new Function(stripped);
        return true;
    } catch {
        return false;
    }
}

// ─── OpenRouter API call ──────────────────────────────────────────────────────

/**
 * Call OpenRouter API with a prompt. Returns the raw text response.
 * Uses the first available API key from config.
 * @param {string} systemPrompt
 * @param {string} userContent
 * @returns {Promise<string>}
 */
function callOpenRouter(systemPrompt, userContent) {
    const apiKey = config.openrouter?.apiKeys?.[0] ?? '';
    const body   = JSON.stringify({
        model: MODEL,
        messages: [
            { role: 'system',  content: systemPrompt },
            { role: 'user',    content: userContent  }
        ]
    });

    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: 'openrouter.ai',
                path:     '/api/v1/chat/completions',
                method:   'POST',
                headers: {
                    'Content-Type':  'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Length': Buffer.byteLength(body)
                }
            },
            (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const text = json.choices?.[0]?.message?.content ?? '';
                        resolve(text.trim());
                    } catch {
                        reject(new Error(`Parse error: ${data.slice(0, 200)}`));
                    }
                });
            }
        );

        const timeout = setTimeout(() => {
            req.destroy();
            reject(new Error('API timeout (30s)'));
        }, API_TIMEOUT_MS);

        req.on('error', (e) => { clearTimeout(timeout); reject(e); });
        req.on('close', ()  => clearTimeout(timeout));
        req.write(body);
        req.end();
    });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Step 1: Read the module, send to AI, and store proposed update.
 * Does NOT apply the update yet — requires user confirmation.
 *
 * @param {string} moduleName   - e.g. "BatteryOptimizer"
 * @param {string} instruction  - What the user wants changed
 */
export async function requestUpdate(moduleName, instruction) {
    try {
        const filePath = resolveModulePath(moduleName);

        if (!fs.existsSync(filePath)) {
            if (notifyFn) notifyFn(`❌ Modul *${moduleName}* tidak ditemukan di /modules/.`);
            return;
        }

        const stat = fs.statSync(filePath);
        if (stat.size > MAX_FILE_BYTES) {
            if (notifyFn) notifyFn(`❌ File terlalu besar (>100KB). Update ditolak.`);
            return;
        }

        const originalCode = fs.readFileSync(filePath, 'utf-8');

        if (notifyFn) notifyFn(`🔄 *SelfUpdate*: Mengirim *${moduleName}.mjs* ke AI untuk diedit...\n_Tunggu sebentar..._`);

        const systemPrompt =
            'Kamu adalah code editor. Edit kode Node.js ESM berikut sesuai instruksi. ' +
            'Balas HANYA dengan kode JavaScript lengkap tanpa markdown backtick.';
        const userContent  = `File: ${moduleName}.mjs\n\n${originalCode}\n\n--- INSTRUKSI ---\n${instruction}`;

        const newCode = await callOpenRouter(systemPrompt, userContent);

        // Strip markdown backticks if model accidentally included them
        const cleanCode = newCode
            .replace(/^```(?:javascript|js)?\n?/i, '')
            .replace(/\n?```\s*$/, '')
            .trim();

        if (!validateCode(cleanCode)) {
            if (notifyFn) notifyFn(`❌ *SelfUpdate*: Kode yang dihasilkan AI gagal validasi. Update dibatalkan.`);
            return;
        }

        // Store pending update (not yet committed to disk)
        pendingUpdate = {
            moduleName,
            filePath,
            originalCode,
            newCode: cleanCode,
            instruction: String(instruction || '').trim(),
            createdAt: Date.now()
        };

        if (notifyFn) notifyFn(
            `✅ *SelfUpdate*: Update *${moduleName}.mjs* siap!\n\n` +
            `Ketik *"preview update"* buat lihat ringkasan dulu.\n` +
            `Balas dengan ketik *"apply update"* untuk terapkan,\n` +
            `atau *"cancel update"* untuk batalkan.`
        );

    } catch (e) {
        if (notifyFn) notifyFn(`❌ *SelfUpdate*: Error — ${e.message}`);
    }
}

/**
 * Step 2: Apply the pending update after user confirmation.
 * Backs up original → writes new file.
 * Attempts dynamic import() to verify; rollbacks on failure.
 */
export async function applyUpdate() {
    if (!pendingUpdate) {
        if (notifyFn) notifyFn('⚠️ Tidak ada update yang menunggu konfirmasi.');
        return;
    }

    const { moduleName, filePath, newCode } = pendingUpdate;
    pendingUpdate = null;

    const backupPath = filePath.replace('.mjs', `.backup.${Date.now()}.mjs`);

    try {
        // Backup original
        fs.copyFileSync(filePath, backupPath);
        if (notifyFn) notifyFn(`💾 Backup disimpan: ${path.basename(backupPath)}`);

        // Write new code
        fs.writeFileSync(filePath, newCode, 'utf-8');

        // Verify via dynamic import (cache-busted with timestamp)
        const importUrl = `file://${filePath}?t=${Date.now()}`;
        try {
            await import(importUrl);
            if (notifyFn) notifyFn(
                `🎉 *SelfUpdate*: *${moduleName}.mjs* berhasil diupdate dan dimuat ulang!`
            );
        } catch (importErr) {
            // Rollback
            fs.copyFileSync(backupPath, filePath);
            if (notifyFn) notifyFn(
                `❌ *SelfUpdate*: Import gagal setelah update — *rollback otomatis* ke versi sebelumnya.\n` +
                `Error: ${importErr.message}`
            );
        }

    } catch (e) {
        if (notifyFn) notifyFn(`❌ *SelfUpdate*: Gagal apply update — ${e.message}`);
    }
}

/**
 * Manually rollback a module to its .backup.mjs if available.
 * @param {string} moduleName
 */
export async function rollback(moduleName) {
    try {
        const filePath   = resolveModulePath(moduleName);
        const backupPath = filePath.replace('.mjs', '.backup.mjs');

        if (!fs.existsSync(backupPath)) {
            if (notifyFn) notifyFn(`⚠️ Tidak ada backup untuk *${moduleName}.mjs*.`);
            return;
        }

        fs.copyFileSync(backupPath, filePath);
        if (notifyFn) notifyFn(`↩️ *SelfUpdate*: *${moduleName}.mjs* berhasil di-rollback ke versi backup.`);
    } catch (e) {
        if (notifyFn) notifyFn(`❌ *SelfUpdate*: Rollback gagal — ${e.message}`);
    }
}

/**
 * Cancel the pending update without applying it.
 */
export function cancelUpdate() {
    pendingUpdate = null;
    if (notifyFn) notifyFn('🚫 *SelfUpdate*: Update dibatalkan.');
}

/** Returns true if there is a pending update waiting for confirmation. */
export function hasPendingUpdate() {
    return pendingUpdate !== null;
}

/**
 * Return short, human-readable summary for pending update.
 */
export function getPendingSummary() {
    if (!pendingUpdate) return null;
    const oldLines = pendingUpdate.originalCode.split('\n');
    const newLines = pendingUpdate.newCode.split('\n');
    return {
        moduleName: pendingUpdate.moduleName,
        instruction: pendingUpdate.instruction,
        oldLineCount: oldLines.length,
        newLineCount: newLines.length,
        delta: newLines.length - oldLines.length,
        ageSec: Math.floor((Date.now() - pendingUpdate.createdAt) / 1000)
    };
}

/**
 * Set WA notification function.
 * @param {Function} fn
 */
export function setNotifyFn(fn) {
    notifyFn = fn;
}
