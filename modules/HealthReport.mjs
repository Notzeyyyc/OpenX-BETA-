/**
 * HealthReport.mjs
 * Generates a daily health report and sends it via WhatsApp at a scheduled hour.
 * Includes: avg RAM usage, top foreground app, battery stats, storage, command count.
 * ColorOS-aware: filters com.oplus/com.coloros/com.heytap launcher packages.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const STATS_FILE    = path.join(__dirname, 'health_stats.json');
const LAUNCHER_PKGS = ['com.coloros', 'com.oplus', 'com.heytap', 'com.oppo', 'com.android.launcher'];

let notifyFn   = null;
let cronTimer  = null;

// ─── In-memory stats accumulator (reset each day) ────────────────────────────
let stats = loadStats();

function loadStats() {
    try {
        const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
        // Reset if it's from a previous day
        if (data.date !== todayKey()) return freshStats();
        return data;
    } catch {
        return freshStats();
    }
}

function freshStats() {
    return {
        date:         todayKey(),
        ramSamples:   [],    // available MB samples
        foregroundLog: {},   // { pkg: secondsCount }
        maxTempRaw:   0,     // highest battery temp raw value
        chargingMins: 0,     // minutes spent charging
        commandCount: 0,     // commands received by OpenX today
        lastChargeTs: null,  // timestamp when charging started
    };
}

function saveStats() {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

function todayKey() {
    return new Date().toISOString().slice(0, 10);
}

// ─── Sampling (call this from a setInterval on startup) ──────────────────────

/**
 * Sample current device state into today's stats.
 * Should be called every ~60 seconds externally or internally.
 */
function sampleNow() {
    // Ensure we're still on today's date
    if (stats.date !== todayKey()) stats = freshStats();

    // RAM sample
    try {
        const raw   = fs.readFileSync('/proc/meminfo', 'utf-8');
        const avail = parseInt(raw.match(/MemAvailable:\s+(\d+)/)?.[1] ?? '0') / 1024;
        stats.ramSamples.push(Math.round(avail));
        // Keep only last 1440 samples (1 per minute for 24h)
        if (stats.ramSamples.length > 1440) stats.ramSamples.shift();
    } catch {}

    // Foreground app
    try {
        const raw = execSync('su -c "dumpsys activity | grep mCurrentFocus"', { encoding: 'utf-8', timeout: 5000 });
        const match = raw.match(/\{[^}]+\s([\w.]+)\//);
        const pkg   = match?.[1] ?? null;
        // Skip launcher/system packages
        if (pkg && !LAUNCHER_PKGS.some(p => pkg.startsWith(p))) {
            stats.foregroundLog[pkg] = (stats.foregroundLog[pkg] || 0) + 1;
        }
    } catch {}

    // Battery temp
    try {
        const raw = parseInt(fs.readFileSync('/sys/class/power_supply/battery/temp', 'utf-8').trim());
        if (raw > stats.maxTempRaw) stats.maxTempRaw = raw;
    } catch {}

    // Charging duration
    try {
        const status = fs.readFileSync('/sys/class/power_supply/battery/status', 'utf-8').trim();
        if (status === 'Charging') {
            if (!stats.lastChargeTs) stats.lastChargeTs = Date.now();
        } else {
            if (stats.lastChargeTs) {
                stats.chargingMins += Math.round((Date.now() - stats.lastChargeTs) / 60000);
                stats.lastChargeTs = null;
            }
        }
    } catch {}

    saveStats();
}

// Start internal sampler every 60 seconds
setInterval(sampleNow, 60 * 1000);

// ─── Increment command counter (called by index.mjs) ─────────────────────────
export function incrementCommandCount() {
    if (stats.date !== todayKey()) stats = freshStats();
    stats.commandCount++;
    saveStats();
}

// ─── Report generator ─────────────────────────────────────────────────────────

/**
 * Generate and send the daily health report via WA.
 * @returns {string} The full report text
 */
export async function generateReport() {
    if (stats.date !== todayKey()) stats = freshStats();

    // Avg RAM
    const avgRam = stats.ramSamples.length
        ? Math.round(stats.ramSamples.reduce((a, b) => a + b, 0) / stats.ramSamples.length)
        : 0;

    // Top foreground app (filter launchers)
    const topApp = Object.entries(stats.foregroundLog)
        .sort((a, b) => b[1] - a[1])
        .filter(([pkg]) => !LAUNCHER_PKGS.some(p => pkg.startsWith(p)))[0];

    // Battery temp (raw/10 = °C)
    const maxTempC = (stats.maxTempRaw / 10).toFixed(1);

    // Storage
    let storageFree = '?';
    let storageTotal = '?';
    try {
        const df   = execSync('su -c "df /data"', { encoding: 'utf-8', timeout: 5000 });
        const line = df.split('\n')[1]?.trim().split(/\s+/);
        if (line) {
            storageTotal = `${Math.round(parseInt(line[1]) / 1024)} MB`;
            storageFree  = `${Math.round(parseInt(line[3]) / 1024)} MB`;
        }
    } catch {}

    // Charging time
    let chargingTotal = stats.chargingMins;
    if (stats.lastChargeTs) {
        chargingTotal += Math.round((Date.now() - stats.lastChargeTs) / 60000);
    }

    const report =
        `📊 *OpenX Daily Health Report — ${stats.date}*\n\n` +
        `💾 *Rata-rata RAM tersedia:* ${avgRam} MB\n` +
        `📱 *App paling lama di foreground:* ${topApp ? topApp[0] : 'Tidak terdeteksi'}\n` +
        `🔋 *Suhu baterai tertinggi:* ${maxTempC}°C\n` +
        `⚡ *Total waktu charging:* ${chargingTotal} menit\n` +
        `💿 *Storage /data:* Bebas ${storageFree} / ${storageTotal}\n` +
        `🗣️ *Perintah ke OpenX hari ini:* ${stats.commandCount}\n\n` +
        `_Laporan dibuat otomatis oleh OpenX Health Monitor_ 🤖`;

    if (notifyFn) notifyFn(report);
    return report;
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

/**
 * Schedule the daily report at the given hour (0–23).
 * @param {number} hour - Default 21 = 9 PM
 */
export function scheduleDaily(hour = 21) {
    if (cronTimer) clearInterval(cronTimer);

    // Check every minute if it's time
    cronTimer = setInterval(() => {
        const now = new Date();
        if (now.getHours() === hour && now.getMinutes() === 0) {
            generateReport();
        }
    }, 60 * 1000);
}

/**
 * Set WA notification function.
 * @param {Function} fn
 */
export function setNotifyFn(fn) {
    notifyFn = fn;
}
