/**
 * NetworkIntel.mjs
 * Source of truth (device-confirmed):
 * - Interface monitoring: /proc/net/dev (ccmni1 mobile, wlan0 wifi)
 * - Per-app monitoring: dumpsys netstats with "uid=...,package=..."
 * - No xt_qtaguid / no eBPF dependency.
 */

import fs from 'fs';
import { execSync } from 'child_process';

const WATCH_INTERFACES = ['ccmni1', 'wlan0'];
const HOTSPOT_INTERFACES = ['ap0', 'swlan0', 'rndis0'];
const DEFAULT_INTERVAL_SEC = 30;
const DEFAULT_SPIKE_MB = 15;

let notifyFn = null;
let monitorTimer = null;
let reconnectCbs = [];
let prevIface = null; // { iface: {rx,tx,total} }
let prevHotspot = null;
const config = {
    intervalSec: DEFAULT_INTERVAL_SEC,
    spikeMb: DEFAULT_SPIKE_MB,
    hotspotMonitor: true
};

function readInterfaceTotals() {
    const out = {};
    try {
        const raw = fs.readFileSync('/proc/net/dev', 'utf-8');
        for (const line of raw.split('\n').slice(2)) {
            if (!line.includes(':')) continue;
            const [ifaceRaw, rest] = line.split(':');
            const iface = ifaceRaw.trim();
            if (!WATCH_INTERFACES.includes(iface)) continue;
            const parts = rest.trim().split(/\s+/);
            const rx = parseInt(parts[0] || '0', 10);
            const tx = parseInt(parts[8] || '0', 10);
            out[iface] = { rx, tx, total: rx + tx };
        }
    } catch {}
    return out;
}

function parseNetstatsPerApp() {
    const usage = {};
    try {
        const raw = execSync('su -c "dumpsys netstats"', { encoding: 'utf-8', timeout: 12000 });

        // Packetized parser: blocks start with uid=..,package=..
        // Then collect rxBytes/txBytes lines until next uid/package block.
        let currentUid = null;
        let currentPkg = null;

        for (const line of raw.split('\n')) {
            const header = line.match(/uid=(\d+)\s*,\s*package=([a-zA-Z0-9._$-]+)/);
            if (header) {
                currentUid = header[1];
                currentPkg = header[2];
                const key = `${currentUid}|${currentPkg}`;
                if (!usage[key]) usage[key] = { uid: currentUid, name: currentPkg, bytes: 0 };
                continue;
            }

            if (!currentUid || !currentPkg) continue;
            const rx = line.match(/rxBytes[=:](\d+)/);
            const tx = line.match(/txBytes[=:](\d+)/);
            if (rx || tx) {
                const key = `${currentUid}|${currentPkg}`;
                usage[key].bytes += (parseInt(rx?.[1] || '0', 10) + parseInt(tx?.[1] || '0', 10));
            }
        }
    } catch {}
    return usage;
}

function detectInterfaceSpikes(curr) {
    if (!notifyFn || !prevIface) return;

    for (const iface of WATCH_INTERFACES) {
        const c = curr[iface];
        const p = prevIface[iface];
        if (!c || !p) continue;
        const delta = c.total - p.total;
        if (delta > config.spikeMb * 1024 * 1024) {
            const mb = (delta / 1024 / 1024).toFixed(2);
            const label = iface === 'ccmni1' ? 'Mobile Data (ccmni1)' : 'WiFi (wlan0)';
            notifyFn(
                `📶 *NetworkIntel Spike*\n\n` +
                `${label} naik *${mb} MB* dalam ${config.intervalSec} detik.\n` +
                `Cek app yang lagi boros data.`
            );
        }
    }
}

function readHotspotTotals() {
    const out = {};
    try {
        const raw = fs.readFileSync('/proc/net/dev', 'utf-8');
        for (const line of raw.split('\n').slice(2)) {
            if (!line.includes(':')) continue;
            const [ifaceRaw, rest] = line.split(':');
            const iface = ifaceRaw.trim();
            if (!HOTSPOT_INTERFACES.includes(iface)) continue;
            const parts = rest.trim().split(/\s+/);
            const rx = parseInt(parts[0] || '0', 10);
            const tx = parseInt(parts[8] || '0', 10);
            out[iface] = { rx, tx, total: rx + tx };
        }
    } catch {}
    return out;
}

function detectHotspotSpike(curr) {
    if (!config.hotspotMonitor || !notifyFn || !prevHotspot) return;
    for (const iface of HOTSPOT_INTERFACES) {
        const c = curr[iface];
        const p = prevHotspot[iface];
        if (!c || !p) continue;
        const delta = c.total - p.total;
        if (delta > config.spikeMb * 1024 * 1024) {
            const mb = (delta / 1024 / 1024).toFixed(2);
            notifyFn(
                `🔥 *Hotspot Spike*\n\n` +
                `Interface ${iface} naik *${mb} MB* dalam ${config.intervalSec} detik.\n` +
                `Kemungkinan ada klien hotspot yang boros data.`
            );
        }
    }
}

function isHotspotLikelyOn(curr) {
    return Object.keys(curr).length > 0;
}

function detectReconnect(curr) {
    const hadAny = prevIface && Object.keys(prevIface).length > 0;
    const hasAny = Object.keys(curr).length > 0;
    if (hadAny === false && hasAny === true) {
        for (const cb of reconnectCbs) {
            try { cb(); } catch {}
        }
        if (notifyFn) notifyFn('🌐 *NetworkIntel*: Interface network aktif kembali.');
    }
}

export function startMonitoring() {
    if (monitorTimer) return;
    prevIface = readInterfaceTotals();
    prevHotspot = readHotspotTotals();

    monitorTimer = setInterval(() => {
        const curr = readInterfaceTotals();
        const hotspotCurr = readHotspotTotals();
        detectReconnect(curr);
        detectInterfaceSpikes(curr);
        detectHotspotSpike(hotspotCurr);
        prevIface = curr;
        prevHotspot = hotspotCurr;
    }, config.intervalSec * 1000);
}

export function stopMonitoring() {
    if (monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
    }
}

/**
 * Return current per-app usage snapshot from dumpsys netstats.
 * @returns {Array<{uid, name, mb}>}
 */
export function getDataUsage() {
    const map = parseNetstatsPerApp();
    return Object.values(map)
        .map(row => ({
            uid: row.uid,
            name: row.name,
            mb: parseFloat((row.bytes / 1024 / 1024).toFixed(2))
        }))
        .sort((a, b) => b.mb - a.mb)
        .slice(0, 20);
}

export function onReconnect(cb) {
    reconnectCbs.push(cb);
}

export function setNotifyFn(fn) {
    notifyFn = fn;
}

export function getConfig() {
    return { ...config };
}

export function updateConfig(partial = {}) {
    if (typeof partial.intervalSec === 'number' && Number.isFinite(partial.intervalSec)) {
        config.intervalSec = Math.min(Math.max(Math.round(partial.intervalSec), 10), 300);
    }
    if (typeof partial.spikeMb === 'number' && Number.isFinite(partial.spikeMb)) {
        config.spikeMb = Math.min(Math.max(partial.spikeMb, 1), 500);
    }
    if (typeof partial.hotspotMonitor === 'boolean') {
        config.hotspotMonitor = partial.hotspotMonitor;
    }

    // Apply live by restarting monitor loop safely
    const wasRunning = !!monitorTimer;
    if (wasRunning) {
        stopMonitoring();
        startMonitoring();
    }
    return getConfig();
}

export function getHotspotStatus() {
    const curr = readHotspotTotals();
    return {
        monitorEnabled: config.hotspotMonitor,
        active: isHotspotLikelyOn(curr),
        interfaces: curr
    };
}
