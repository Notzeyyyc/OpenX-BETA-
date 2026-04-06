/**
 * BatteryOptimizer.mjs
 * Monitors battery every 60 seconds using confirmed device sysfs paths
 * for Infinix Hot 50 Pro+ (MTK X6880).
 *
 * Sysfs paths:
 *   /sys/class/power_supply/battery/capacity     → % level
 *   /sys/class/power_supply/battery/status       → "Charging" | "Discharging"
 *   /sys/class/power_supply/battery/temp         → raw (÷10 = °C)
 *   /sys/class/power_supply/mtk-master-charger/input_current_limit
 *       → 2100000 = charging active | 0 = charging stopped
 *
 * Logic:
 *   ≥ 80% + Charging  → stop charging (write 0)
 *   ≤ 75%             → resume charging (write 2100000)
 *   Override "charge full" → charge until 100% then revert
 *   Temp > 450 raw (45°C) → alert via WA
 */

import fs from 'fs';
import { execSync } from 'child_process';

const PATH_CAPACITY   = '/sys/class/power_supply/battery/capacity';
const PATH_STATUS     = '/sys/class/power_supply/battery/status';
const PATH_TEMP       = '/sys/class/power_supply/battery/temp';
const PATH_ILIMIT     = '/sys/class/power_supply/mtk-master-charger/input_current_limit';

const STOP_THRESHOLD    = 80;
const RESUME_THRESHOLD  = 75;
const OVERHEAT_RAW      = 450;    // 45.0 °C
const CURRENT_LIMIT     = 2100000; // normal charging current
const INTERVAL_MS       = 60 * 1000;

let notifyFn        = null;
let timer           = null;
let overrideMode    = false;   // "charge full" bypass
let lastState       = null;    // 'stopped' | 'resumed' | 'overheat' | 'override'

// ─── sysfs helpers ────────────────────────────────────────────────────────────

/** Read a sysfs node safely */
function readSys(filePath) {
    try { return fs.readFileSync(filePath, 'utf-8').trim(); } catch { return null; }
}

/**
 * Write a value to a sysfs node via root (permission: rw-r--r-- root).
 * @param {string} filePath
 * @param {string|number} value
 */
function writeSys(filePath, value) {
    execSync(`su -c "echo ${value} > ${filePath}"`, { timeout: 5000 });
}

// ─── Core check ───────────────────────────────────────────────────────────────

/**
 * Main battery logic — called every INTERVAL_MS.
 */
function check() {
    const capacity = parseInt(readSys(PATH_CAPACITY) ?? '-1');
    const status   = readSys(PATH_STATUS) ?? '';
    const tempRaw  = parseInt(readSys(PATH_TEMP) ?? '0');

    if (capacity === -1) return; // sysfs unavailable

    // ── Overheat alert ──
    if (tempRaw > OVERHEAT_RAW && lastState !== 'overheat') {
        lastState = 'overheat';
        if (notifyFn) notifyFn(
            `🌡️ *BatteryOptimizer ALERT*\n\nSuhu baterai terlalu panas: *${(tempRaw / 10).toFixed(1)}°C*!\n` +
            `Lepas charger dan biarkan HP dingin.`
        );
    }

    // ── Override mode: charge until 100% ──
    if (overrideMode) {
        if (capacity >= 100) {
            overrideMode = false;
            // Restore normal stop logic next tick
            if (notifyFn) notifyFn(`✅ *BatteryOptimizer*: Baterai udah 100%! Kembali ke mode normal.`);
        }
        return; // don't interfere while in override
    }

    // ── Normal stop/resume logic ──
    if (capacity >= STOP_THRESHOLD && status === 'Charging') {
        try {
            writeSys(PATH_ILIMIT, 0);
            if (lastState !== 'stopped') {
                lastState = 'stopped';
                if (notifyFn) notifyFn(
                    `🔋 *BatteryOptimizer*: Baterai ${capacity}% — charging *dihentikan* untuk jaga kesehatan baterai.`
                );
            }
        } catch (e) {
            if (notifyFn) notifyFn(`⚠️ BatteryOptimizer: Gagal stop charging — ${e.message}`);
        }
        return;
    }

    if (capacity <= RESUME_THRESHOLD && status !== 'Charging') {
        try {
            writeSys(PATH_ILIMIT, CURRENT_LIMIT);
            if (lastState !== 'resumed') {
                lastState = 'resumed';
                if (notifyFn) notifyFn(
                    `⚡ *BatteryOptimizer*: Baterai ${capacity}% — charging *dilanjutkan*.`
                );
            }
        } catch (e) {
            if (notifyFn) notifyFn(`⚠️ BatteryOptimizer: Gagal resume charging — ${e.message}`);
        }
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Start battery monitoring. */
export function start() {
    if (timer) return;
    timer = setInterval(check, INTERVAL_MS);
    check(); // immediate first run
}

/** Stop battery monitoring. */
export function stop() {
    if (timer) { clearInterval(timer); timer = null; }
}

/**
 * Override: bypass stop logic and charge until 100%.
 * Triggered by user message "charge full".
 */
export function override() {
    overrideMode = true;
    lastState     = 'override';
    // Ensure charger is running
    try {
        writeSys(PATH_ILIMIT, CURRENT_LIMIT);
    } catch {}
    if (notifyFn) notifyFn(
        `⚡ *BatteryOptimizer*: Mode *charge full* aktif — akan charge sampai 100% tanpa berhenti.`
    );
}

/**
 * Return current battery info snapshot.
 * @returns {{ capacity: number, status: string, tempC: number, chargingLimitActive: boolean }}
 */
export function getBatteryInfo() {
    const capacity   = parseInt(readSys(PATH_CAPACITY) ?? '0');
    const status     = readSys(PATH_STATUS) ?? 'Unknown';
    const tempRaw    = parseInt(readSys(PATH_TEMP) ?? '0');
    const limitRaw   = parseInt(readSys(PATH_ILIMIT) ?? '-1');

    return {
        capacity,
        status,
        tempC:               parseFloat((tempRaw / 10).toFixed(1)),
        chargingLimitActive: limitRaw > 0,
        overrideMode,
    };
}

/**
 * Set WA notification function.
 * @param {Function} fn
 */
export function setNotifyFn(fn) {
    notifyFn = fn;
}
