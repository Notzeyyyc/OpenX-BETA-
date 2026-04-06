/**
 * SessionLog.mjs
 * Logs every AI action (shell commands, sysfs writes, process kills) to
 * modules/session.log in newline-delimited JSON format.
 * Snapshots device state before major actions.
 * Supports "undo" (reverse last reversible action) and "log tadi" (WA summary).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE  = path.join(__dirname, 'session.log');

let notifyFn = null;

/** In-memory log for the current session */
const sessionEntries = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Append a JSON line to session.log */
function appendLog(entry) {
    const line = JSON.stringify(entry);
    fs.appendFileSync(LOG_FILE, line + '\n');
}

/** Read a sysfs file safely (returns null on error) */
function readSysfs(filePath) {
    try { return fs.readFileSync(filePath, 'utf-8').trim(); } catch { return null; }
}

// ─── State snapshot ───────────────────────────────────────────────────────────

/**
 * Capture a snapshot of current device state:
 *   - RAM (MemAvailable from /proc/meminfo)
 *   - Foreground app (dumpsys activity, ColorOS-aware)
 *   - Charging status
 * @returns {object}
 */
export function snapshot() {
    const state = { ts: Date.now() };

    // RAM
    try {
        const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8');
        const avail = meminfo.match(/MemAvailable:\s+(\d+)/)?.[1];
        const total = meminfo.match(/MemTotal:\s+(\d+)/)?.[1];
        state.ram = {
            availMB: avail ? Math.round(parseInt(avail) / 1024) : null,
            totalMB: total ? Math.round(parseInt(total) / 1024) : null
        };
    } catch { state.ram = null; }

    // Foreground app — filter out ColorOS launcher packages
    try {
        const raw = execSync('su -c "dumpsys activity | grep mCurrentFocus"', { encoding: 'utf-8', timeout: 5000 });
        const match = raw.match(/\{[^}]+\s([\w.]+)\//);
        const pkg = match?.[1] ?? null;
        const launcherPrefixes = ['com.coloros', 'com.oplus', 'com.heytap', 'com.oppo'];
        state.foreground = pkg && !launcherPrefixes.some(p => pkg.startsWith(p)) ? pkg : null;
    } catch { state.foreground = null; }

    // Charging
    state.charging = readSysfs('/sys/class/power_supply/battery/status');
    state.batteryPct = readSysfs('/sys/class/power_supply/battery/capacity');

    return state;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Log an action and its result.
 * @param {{ type: string, description: string, target?: string, value?: string, reversible?: boolean, undoFn?: Function }} action
 * @param {{ success: boolean, output?: string, error?: string }} result
 */
export function logAction(action, result) {
    const entry = {
        ts: Date.now(),
        isoTime: new Date().toISOString(),
        action: {
            type:        action.type        ?? 'unknown',
            description: action.description ?? '',
            target:      action.target      ?? null,
            value:       action.value       ?? null,
            reversible:  action.reversible  ?? false,
        },
        result: {
            success: result.success ?? false,
            output:  result.output  ?? null,
            error:   result.error   ?? null,
        }
    };

    // Store undo handler separately in-memory (not persisted to disk)
    if (action.undoFn) entry._undoFn = action.undoFn;

    sessionEntries.push(entry);
    appendLog({ ...entry, _undoFn: undefined }); // strip function before serialising
}

/**
 * Attempt to undo the last reversible action.
 * Notifies via WA with result.
 */
export function undo() {
    // Find the last entry that has an undoFn or is reversible
    for (let i = sessionEntries.length - 1; i >= 0; i--) {
        const entry = sessionEntries[i];
        if (entry._undoFn) {
            try {
                entry._undoFn();
                const msg = `↩️ *Undo berhasil!*\nAksi dibatalkan: _${entry.action.description}_`;
                if (notifyFn) notifyFn(msg);
                sessionEntries.splice(i, 1);
            } catch (e) {
                if (notifyFn) notifyFn(`❌ Undo gagal: ${e.message}`);
            }
            return;
        }
        if (entry.action.reversible) {
            if (notifyFn) notifyFn(`⚠️ Aksi _${entry.action.description}_ ditandai reversible tapi tidak ada handler undo.`);
            return;
        }
    }
    if (notifyFn) notifyFn('🤷 Tidak ada aksi yang bisa di-undo di sesi ini.');
}

/**
 * Generate a human-readable summary of all actions this session.
 * Sends it via WA and returns the string.
 */
export function getSummary() {
    if (sessionEntries.length === 0) {
        const msg = '📋 *Session Log*: Belum ada aksi di sesi ini.';
        if (notifyFn) notifyFn(msg);
        return msg;
    }

    const lines = sessionEntries.map((e, idx) => {
        const time   = new Date(e.ts).toLocaleTimeString('id-ID');
        const status = e.result.success ? '✅' : '❌';
        return `${idx + 1}. [${time}] ${status} ${e.action.description}`;
    });

    const msg =
        `📋 *Session Log (${sessionEntries.length} aksi)*\n\n` +
        lines.join('\n') +
        `\n\nKetik "undo terakhir" untuk batalkan aksi terakhir yang bisa di-reverse.`;

    if (notifyFn) notifyFn(msg);
    return msg;
}

/**
 * Set WA notification function.
 * @param {Function} fn - (text: string) => void
 */
export function setNotifyFn(fn) {
    notifyFn = fn;
}
