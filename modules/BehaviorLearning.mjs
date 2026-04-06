/**
 * BehaviorLearning.mjs
 * Tracks user command history, detects daily usage patterns (peak hours,
 * most-used commands), and proactively notifies the user via WhatsApp
 * when a predicted active window matches the current hour.
 *
 * Data is persisted to modules/patterns.json and updated daily.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATTERNS_FILE = path.join(__dirname, 'patterns.json');
const MIN_DAYS_FOR_PREDICTION = 3; // Need at least 3 days of data before predicting

/** Notify function injected from core (jid-bound sendMessage) */
let notifyFn = null;

/** In-memory cache of loaded patterns */
let patternsCache = null;

// ─── Persistence helpers ──────────────────────────────────────────────────────

/** Load patterns from disk (or return empty structure) */
function loadPatterns() {
    if (patternsCache) return patternsCache;
    try {
        patternsCache = JSON.parse(fs.readFileSync(PATTERNS_FILE, 'utf-8'));
    } catch {
        patternsCache = {
            commands: [],        // [{ cmd, ts }]
            dailySummaries: {},  // { "YYYY-MM-DD": { hourCounts: {}, cmdCounts: {} } }
            lastPredictionHour: -1
        };
    }
    return patternsCache;
}

/** Persist current in-memory patterns to disk */
function savePatterns() {
    fs.writeFileSync(PATTERNS_FILE, JSON.stringify(patternsCache, null, 2));
}

/** Get today's date key YYYY-MM-DD */
function todayKey() {
    return new Date().toISOString().slice(0, 10);
}

// ─── Daily summary builder ────────────────────────────────────────────────────

/**
 * Rebuild today's hourCounts and cmdCounts from raw command log.
 * Called after each logCommand to keep summaries fresh.
 */
function rebuildTodaySummary() {
    const data = loadPatterns();
    const today = todayKey();
    const todayStart = new Date(today).getTime();
    const todayEnd = todayStart + 86400000;

    const todayCmds = data.commands.filter(e => e.ts >= todayStart && e.ts < todayEnd);

    const hourCounts = {};
    const cmdCounts = {};

    for (const entry of todayCmds) {
        const hour = new Date(entry.ts).getHours();
        hourCounts[hour] = (hourCounts[hour] || 0) + 1;
        cmdCounts[entry.cmd] = (cmdCounts[entry.cmd] || 0) + 1;
    }

    data.dailySummaries[today] = { hourCounts, cmdCounts };

    // Prune raw log older than 30 days to save RAM
    const cutoff = Date.now() - 30 * 86400000;
    data.commands = data.commands.filter(e => e.ts > cutoff);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Log a user command with the current timestamp.
 * @param {string} cmd - The command or message text from the user.
 */
export function logCommand(cmd) {
    const data = loadPatterns();
    data.commands.push({ cmd: String(cmd).slice(0, 200), ts: Date.now() });
    rebuildTodaySummary();
    savePatterns();
}

/**
 * Return the full patterns object (summaries + raw commands).
 */
export function getPatterns() {
    return loadPatterns();
}

/**
 * For a given hour (0–23), return a prediction score based on past data.
 * Returns { predicted: boolean, topCmd: string|null, avgCount: number }
 */
export function getPrediction(currentHour) {
    const data = loadPatterns();
    const summaries = Object.values(data.dailySummaries);

    if (summaries.length < MIN_DAYS_FOR_PREDICTION) {
        return { predicted: false, topCmd: null, avgCount: 0, daysRecorded: summaries.length };
    }

    // Average command count for this hour across all recorded days
    let total = 0;
    let cmdTally = {};

    for (const s of summaries) {
        total += s.hourCounts[currentHour] || 0;
        for (const [cmd, count] of Object.entries(s.cmdCounts || {})) {
            cmdTally[cmd] = (cmdTally[cmd] || 0) + count;
        }
    }

    const avgCount = total / summaries.length;
    const topCmd = Object.keys(cmdTally).sort((a, b) => cmdTally[b] - cmdTally[a])[0] || null;

    // Predict active if average use in this hour > 2 commands
    return { predicted: avgCount > 2, topCmd, avgCount: parseFloat(avgCount.toFixed(2)), daysRecorded: summaries.length };
}

/**
 * Inject the notification function from core.
 * @param {Function} fn - (text: string) => void, pre-bound to a JID
 */
export function setNotifyFn(fn) {
    notifyFn = fn;
}

// ─── Proactive prediction scheduler ──────────────────────────────────────────

/**
 * Runs every hour. If the current hour is predicted to be active and we
 * haven't already notified this hour, send a proactive WA message.
 */
function startHourlyChecker() {
    setInterval(() => {
        const hour = new Date().getHours();
        const data = loadPatterns();

        // Avoid spamming — only notify once per hour
        if (data.lastPredictionHour === hour) return;

        const pred = getPrediction(hour);
        if (pred.predicted && notifyFn) {
            const msg =
                `🤖 *OpenX Proactive Alert*\n\n` +
                `Berdasarkan kebiasaan lu, biasanya jam ${hour}:00 ini lu aktif pakai OpenX.\n` +
                `Command favorit: *${pred.topCmd || '-'}*\n\n` +
                `Ada yang bisa gue bantu? 😎`;
            notifyFn(msg);
            data.lastPredictionHour = hour;
            savePatterns();
        }
    }, 60 * 60 * 1000); // check every hour
}

startHourlyChecker();
