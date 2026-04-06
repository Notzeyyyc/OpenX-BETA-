/**
 * ChainCommand.mjs
 * Parses natural-language chained command strings from WhatsApp messages.
 * Supports triggers: app opened/closed, battery %, specific time.
 * Supports actions: toggle WiFi/BT, send WA, kill app, set alarm.
 * Executes steps sequentially; aborts and notifies on any failure.
 * ColorOS note: sysfs + `su -c cmd` used for WiFi/BT toggle.
 */

import { execSync } from 'child_process';
import fs from 'fs';

let notifyFn = null;

/** In-memory list of registered chains */
const chains = [];

/** Poll interval handle */
let pollTimer = null;

// ─── Trigger evaluators ───────────────────────────────────────────────────────

/**
 * Check if a given trigger condition is currently satisfied.
 * @param {{ type, value }} trigger
 * @returns {boolean}
 */
function isTriggerMet(trigger) {
    try {
        switch (trigger.type) {
            case 'time': {
                // value: "HH:MM"
                const [hh, mm] = trigger.value.split(':').map(Number);
                const now = new Date();
                return now.getHours() === hh && now.getMinutes() === mm;
            }
            case 'battery': {
                // value: number (percentage)
                const raw = fs.readFileSync('/sys/class/power_supply/battery/capacity', 'utf-8').trim();
                return parseInt(raw) <= parseInt(trigger.value);
            }
            case 'app_closed': {
                // value: package name
                const fg = execSync('su -c "dumpsys activity | grep mCurrentFocus"', { encoding: 'utf-8', timeout: 5000 });
                return !fg.includes(trigger.value);
            }
            case 'app_open': {
                // value: package name
                const fg = execSync('su -c "dumpsys activity | grep mCurrentFocus"', { encoding: 'utf-8', timeout: 5000 });
                return fg.includes(trigger.value);
            }
            default:
                return false;
        }
    } catch {
        return false;
    }
}

// ─── Action executors ─────────────────────────────────────────────────────────

/**
 * Execute a single action step.
 * @param {{ type, value }} action
 * @returns {{ ok: boolean, msg: string }}
 */
function executeAction(action) {
    try {
        switch (action.type) {
            case 'wifi_off':
                // ColorOS: sysfs toggle preferred; cmd fallback
                try {
                    execSync('su -c "svc wifi disable"', { timeout: 5000 });
                } catch {
                    execSync('su -c "cmd wifi set-wifi-enabled disabled"', { timeout: 5000 });
                }
                return { ok: true, msg: '📵 WiFi dimatiin' };

            case 'wifi_on':
                try {
                    execSync('su -c "svc wifi enable"', { timeout: 5000 });
                } catch {
                    execSync('su -c "cmd wifi set-wifi-enabled enabled"', { timeout: 5000 });
                }
                return { ok: true, msg: '📶 WiFi dihidupkan' };

            case 'bt_off':
                try {
                    execSync('su -c "svc bluetooth disable"', { timeout: 5000 });
                } catch {
                    execSync('su -c "cmd bluetooth_manager disable"', { timeout: 5000 });
                }
                return { ok: true, msg: '🔵 Bluetooth dimatiin' };

            case 'bt_on':
                try {
                    execSync('su -c "svc bluetooth enable"', { timeout: 5000 });
                } catch {
                    execSync('su -c "cmd bluetooth_manager enable"', { timeout: 5000 });
                }
                return { ok: true, msg: '🔵 Bluetooth dihidupkan' };

            case 'kill_app':
                // value: package name
                execSync(`su -c "am force-stop ${action.value}"`, { timeout: 5000 });
                return { ok: true, msg: `💀 App ${action.value} di-kill` };

            case 'notify':
                // value: message text to send via WA
                if (notifyFn) notifyFn(action.value);
                return { ok: true, msg: `📨 Notif dikirim: ${action.value}` };

            case 'alarm': {
                // value: "HH:MM"
                const [ah, am] = action.value.split(':').map(Number);
                const ms = ah * 3600000 + am * 60000;
                // Set alarm via Android intent (requires root or ADB shell)
                execSync(
                    `su -c "am start -a android.intent.action.SET_ALARM --ei android.intent.extra.alarm.HOUR ${ah} --ei android.intent.extra.alarm.MINUTES ${am} --ez android.intent.extra.alarm.SKIP_UI true"`,
                    { timeout: 5000 }
                );
                return { ok: true, msg: `⏰ Alarm diset jam ${action.value}` };
            }

            default:
                return { ok: false, msg: `❓ Aksi tidak dikenal: ${action.type}` };
        }
    } catch (e) {
        return { ok: false, msg: `❌ Gagal: ${action.type} — ${e.message}` };
    }
}

// ─── NLP chain parser ─────────────────────────────────────────────────────────

/**
 * Parse natural language command strings into a structured chain object.
 * Handles Indonesian/casual language patterns.
 *
 * @param {string} text - Raw WhatsApp message text
 * @returns {{ trigger: object, actions: object[], raw: string } | null}
 */
export function parseChain(text) {
    const lower = text.toLowerCase();

    // ── Trigger detection ──
    let trigger = null;

    // "kalau <app> udah ditutup/close"
    const appClosedMatch = lower.match(/kalau (.+?) (?:udah|sudah) (?:ditutup|di-?close|close|keluar)/);
    if (appClosedMatch) {
        // Map common app names to packages
        const pkg = resolvePackage(appClosedMatch[1].trim());
        trigger = { type: 'app_closed', value: pkg };
    }

    // "kalau <app> udah dibuka/open"
    if (!trigger) {
        const appOpenMatch = lower.match(/kalau (.+?) (?:udah|sudah) (?:dibuka|di-?open|open|buka)/);
        if (appOpenMatch) {
            trigger = { type: 'app_open', value: resolvePackage(appOpenMatch[1].trim()) };
        }
    }

    // "jam HH:MM" or "jam H"
    if (!trigger) {
        const timeMatch = lower.match(/jam (\d{1,2})(?::(\d{2}))?/);
        if (timeMatch) {
            const hh = timeMatch[1].padStart(2, '0');
            const mm = (timeMatch[2] || '00').padStart(2, '0');
            trigger = { type: 'time', value: `${hh}:${mm}` };
        }
    }

    // "kalau baterai <=|kurang dari X%"
    if (!trigger) {
        const batMatch = lower.match(/(?:kalau |)baterai (?:kurang dari|<=?|di bawah) ?(\d+)%?/);
        if (batMatch) {
            trigger = { type: 'battery', value: parseInt(batMatch[1]) };
        }
    }

    if (!trigger) return null;

    // ── Action detection ──
    const actions = [];

    if (/matiin wifi|nonaktifin wifi|wifi off/.test(lower))  actions.push({ type: 'wifi_off' });
    if (/nyalain wifi|aktifin wifi|wifi on/.test(lower))      actions.push({ type: 'wifi_on' });
    if (/matiin bluetooth|bluetooth off/.test(lower))         actions.push({ type: 'bt_off' });
    if (/nyalain bluetooth|bluetooth on/.test(lower))         actions.push({ type: 'bt_on' });

    // "ingetin gw tidur jam 11" → alarm
    const alarmMatch = lower.match(/(?:ingetin|alarm|set alarm|ingatin).+jam (\d{1,2})(?::(\d{2}))?/);
    if (alarmMatch) {
        const hh = alarmMatch[1].padStart(2, '0');
        const mm = (alarmMatch[2] || '00').padStart(2, '0');
        actions.push({ type: 'alarm', value: `${hh}:${mm}` });
        actions.push({ type: 'notify', value: `⏰ Oke! Alarm jam ${hh}:${mm} udah gue set.` });
    }

    // "kill <app>" or "tutup <app>"
    const killMatch = lower.match(/(?:kill|tutup|close|matiin app) ([a-z0-9_.]+)/);
    if (killMatch) {
        actions.push({ type: 'kill_app', value: resolvePackage(killMatch[1]) });
    }

    if (actions.length === 0) return null;

    return { trigger, actions, raw: text };
}

/**
 * Map common Indonesian app nicknames to Android package names.
 * Includes ColorOS/OPPO package prefixes as fallback.
 */
function resolvePackage(name) {
    const known = {
        'ml':            'com.mobile.legends',
        'mobile legend': 'com.mobile.legends',
        'mobile legends':'com.mobile.legends',
        'ig':            'com.instagram.android',
        'instagram':     'com.instagram.android',
        'tiktok':        'com.zhiliaoapp.musically',
        'wa':            'com.whatsapp',
        'whatsapp':      'com.whatsapp',
        'yt':            'com.google.android.youtube',
        'youtube':       'com.google.android.youtube',
        'maps':          'com.google.android.apps.maps',
        'chrome':        'com.android.chrome',
        'spotify':       'com.spotify.music',
    };
    return known[name.toLowerCase()] ?? name;
}

// ─── Chain registry + poller ──────────────────────────────────────────────────

/**
 * Register a parsed chain for polling.
 * @param {{ trigger, actions, raw }} chain
 */
export function registerChain(chain) {
    chains.push({ ...chain, fired: false, id: Date.now() });

    // Start poller on first registration
    if (!pollTimer) {
        pollTimer = setInterval(pollChains, 60 * 1000); // check every minute
    }
}

/**
 * Clear all registered chains and stop the poller.
 */
export function clearChains() {
    chains.length = 0;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/**
 * Poll all registered chains and execute ready ones.
 */
async function pollChains() {
    for (const chain of chains) {
        if (chain.fired) continue;
        if (!isTriggerMet(chain.trigger)) continue;

        chain.fired = true;
        if (notifyFn) notifyFn(`🔗 *ChainCommand*: Trigger terpenuhi! Mulai eksekusi...`);

        for (const action of chain.actions) {
            const result = executeAction(action);
            if (notifyFn) notifyFn(`${result.msg}`);
            if (!result.ok) {
                if (notifyFn) notifyFn(`🛑 Chain dihentikan karena langkah gagal.`);
                break;
            }
            // Small delay between steps
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    // Clean up fired chains
    const idx = chains.findIndex(c => c.fired);
    if (idx !== -1) chains.splice(idx, 1);
}

/**
 * Set WA notification function.
 * @param {Function} fn
 */
export function setNotifyFn(fn) {
    notifyFn = fn;
}
