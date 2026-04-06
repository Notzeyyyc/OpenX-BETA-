/**
 * NetworkIntel.mjs
 * Monitors per-app data usage via /proc/net/xt_qtaguid/stats (root).
 * Fallback: dumpsys netstats (ColorOS-aware parsing).
 * Detects data spikes > 50 MB in 5 minutes and notifies via WA.
 * Watches /proc/net/route for network reconnect events (every 30 s).
 */

import fs from 'fs';
import { execSync } from 'child_process';

const SPIKE_THRESHOLD_BYTES = 50 * 1024 * 1024; // 50 MB
const MONITOR_INTERVAL_MS   = 5 * 60 * 1000;    // 5 minutes for spike check
const ROUTE_CHECK_INTERVAL  = 30 * 1000;         // 30 seconds for reconnect

let notifyFn       = null;
let monitorTimer   = null;
let routeTimer     = null;
let reconnectCbs   = [];

/** Snapshot of prev usage: { uid -> totalBytes } */
let prevUsage = {};
/** Whether we currently have a default route (network up) */
let prevHasRoute = false;

// ─── UID → App name map ───────────────────────────────────────────────────────

/**
 * Build uid→packageName map using `pm list packages -U` (root).
 * Falls back to UID string if parsing fails.
 */
function buildUidMap() {
    const map = {};
    try {
        const raw = execSync('su -c "pm list packages -U"', { encoding: 'utf-8', timeout: 8000 });
        // Each line: "package:com.example uid:10123"
        for (const line of raw.split('\n')) {
            const pkgMatch  = line.match(/package:(\S+)/);
            const uidMatch  = line.match(/uid:(\d+)/);
            if (pkgMatch && uidMatch) {
                map[uidMatch[1]] = pkgMatch[1];
            }
        }
    } catch { /* ignore — map stays empty */ }
    return map;
}

// ─── Data usage readers ───────────────────────────────────────────────────────

/**
 * Read per-UID bytes from /proc/net/xt_qtaguid/stats (requires root).
 * Returns { uid -> totalBytes }
 */
function readQtaguid() {
    const usage = {};
    try {
        const raw = execSync(
            'su -c "cat /proc/net/xt_qtaguid/stats"',
            { encoding: 'utf-8', timeout: 5000 }
        );
        // Columns: idx iface acct_tag_hex uid_tag_int cnt_set rx_bytes rx_pkts tx_bytes tx_pkts ...
        for (const line of raw.split('\n').slice(1)) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 9) continue;
            const uid      = parts[3];
            const rxBytes  = parseInt(parts[5]) || 0;
            const txBytes  = parseInt(parts[7]) || 0;
            usage[uid] = (usage[uid] || 0) + rxBytes + txBytes;
        }
    } catch {
        return null; // signal fallback needed
    }
    return usage;
}

/**
 * Fallback: parse `dumpsys netstats` for total bytes per UID.
 * ColorOS may use slightly different line formats — we handle both.
 * Returns { uid -> totalBytes }
 */
function readNetstatsFallback() {
    const usage = {};
    try {
        const raw = execSync(
            'su -c "dumpsys netstats"',
            { encoding: 'utf-8', timeout: 10000 }
        );
        // Match lines like: "UID=10123 ..." or "uid=10123"
        // and byte lines: "  rxBytes=... txBytes=..."
        let currentUid = null;
        for (const line of raw.split('\n')) {
            const uidMatch = line.match(/uid[Ee]?=(\d+)/);
            if (uidMatch) { currentUid = uidMatch[1]; continue; }

            if (currentUid) {
                const rxMatch = line.match(/rxBytes[=:](\d+)/);
                const txMatch = line.match(/txBytes[=:](\d+)/);
                if (rxMatch || txMatch) {
                    const rx = parseInt(rxMatch?.[1]) || 0;
                    const tx = parseInt(txMatch?.[1]) || 0;
                    usage[currentUid] = (usage[currentUid] || 0) + rx + tx;
                }
            }
        }
    } catch { /* return empty */ }
    return usage;
}

/**
 * Get current data usage, trying qtaguid first then netstats.
 */
function getCurrentUsage() {
    const qtaguid = readQtaguid();
    return qtaguid ?? readNetstatsFallback();
}

// ─── Spike detector ───────────────────────────────────────────────────────────

/**
 * Compare current usage snapshot to previous. Alert if any UID increased
 * by more than SPIKE_THRESHOLD_BYTES since last check.
 */
function checkForSpikes(current, uidMap) {
    if (!notifyFn) return;
    for (const [uid, bytes] of Object.entries(current)) {
        const prev    = prevUsage[uid] || 0;
        const delta   = bytes - prev;
        if (delta > SPIKE_THRESHOLD_BYTES) {
            const name = uidMap[uid] || `UID:${uid}`;
            const mb   = (delta / 1024 / 1024).toFixed(1);
            notifyFn(
                `📶 *NetworkIntel Alert*\n\n` +
                `App *${name}* pakai data *${mb} MB* dalam 5 menit terakhir di background!\n` +
                `Mau gue matiin datanya?`
            );
        }
    }
}

// ─── Route watcher (reconnect) ────────────────────────────────────────────────

/**
 * Check /proc/net/route for any non-loopback default gateway.
 * Emits reconnect events when network comes back after being down.
 */
function checkRoute() {
    let hasRoute = false;
    try {
        const raw = fs.readFileSync('/proc/net/route', 'utf-8');
        for (const line of raw.split('\n').slice(1)) {
            const parts = line.trim().split(/\s+/);
            // Destination = 00000000 means default route
            if (parts[1] === '00000000' && parts[0] !== 'lo') {
                hasRoute = true;
                break;
            }
        }
    } catch { /* /proc unavailable (dev/test) */ }

    if (hasRoute && !prevHasRoute) {
        // Network just came back up
        for (const cb of reconnectCbs) {
            try { cb(); } catch { /* ignore */ }
        }
        if (notifyFn) notifyFn('🌐 *NetworkIntel*: Koneksi internet tersambung kembali!');
    }
    prevHasRoute = hasRoute;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start all network monitoring (spike + reconnect).
 */
export function startMonitoring() {
    if (monitorTimer) return; // already running

    // Build UID map once (refresh occasionally inside closure)
    let uidMap = buildUidMap();

    monitorTimer = setInterval(() => {
        const current = getCurrentUsage();
        uidMap = buildUidMap(); // refresh app list
        checkForSpikes(current, uidMap);
        prevUsage = current;
    }, MONITOR_INTERVAL_MS);

    // Initialise prevUsage baseline immediately
    prevUsage = getCurrentUsage();

    // Start route watcher
    prevHasRoute = false;
    routeTimer = setInterval(checkRoute, ROUTE_CHECK_INTERVAL);
}

/**
 * Stop all network monitoring timers.
 */
export function stopMonitoring() {
    if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
    if (routeTimer)   { clearInterval(routeTimer);   routeTimer   = null; }
}

/**
 * Return current per-app data usage snapshot (human-readable).
 * @returns {Array<{uid, name, mb}>}
 */
export function getDataUsage() {
    const uidMap  = buildUidMap();
    const current = getCurrentUsage();
    return Object.entries(current)
        .map(([uid, bytes]) => ({
            uid,
            name: uidMap[uid] || `UID:${uid}`,
            mb: parseFloat((bytes / 1024 / 1024).toFixed(2))
        }))
        .sort((a, b) => b.mb - a.mb)
        .slice(0, 20); // top 20 apps
}

/**
 * Register a callback to fire when the device reconnects to the internet.
 * @param {Function} cb
 */
export function onReconnect(cb) {
    reconnectCbs.push(cb);
}

/**
 * Set the WA notification function.
 * @param {Function} fn - (text: string) => void
 */
export function setNotifyFn(fn) {
    notifyFn = fn;
}
