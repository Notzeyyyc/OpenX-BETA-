/**
 * modules/index.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * OpenX Module System Entry Point
 *
 * Loads all 7 modules, injects the WA notify function into each, and
 * exposes a single handleMessage(jid, text) function that routes incoming
 * WhatsApp messages to the appropriate module handler.
 *
 * Integration: call handleMessage(jid, text) from whatsapp.js on every
 * message received by the Baileys bot.
 */

import { waSock } from '../whatsapp.js';

import {
    initPluginManager,
    handlePluginsMessage,
} from '../package/openx/plugin_manager.mjs';

// ── Module imports ────────────────────────────────────────────────────────────
import * as BehaviorLearning from './BehaviorLearning.mjs';
import * as NetworkIntel     from './NetworkIntel.mjs';
import * as ChainCommand     from './ChainCommand.mjs';
import * as SessionLog       from './SessionLog.mjs';
import * as HealthReport     from './HealthReport.mjs';
import * as BatteryOptimizer from './BatteryOptimizer.mjs';
import * as SelfUpdate       from './SelfUpdate.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// Module bootstrap
// ─────────────────────────────────────────────────────────────────────────────

let _adminJid = null; // JID to send proactive notifications to

/**
 * Initialise all modules.
 * Call this once after WhatsApp connects, passing the admin JID
 * (e.g. "628xxx@s.whatsapp.net") and the Baileys sendMessage function.
 *
 * @param {string}   adminJid     - The user's WhatsApp JID
 * @param {Function} sendMessage  - waSock.sendMessage bound to the socket
 */
export function initModules(adminJid, sendMessage) {
    _adminJid = adminJid;

    /** Factory: create a notify function pre-bound to adminJid */
    const makeNotify = (jid) => (text) => {
        try {
            sendMessage(jid, { text: String(text) });
        } catch (e) {
            console.error('[OpenX Modules] notify failed:', e.message);
        }
    };

    const notify = makeNotify(adminJid);

    // Inject notify function into every module
    BehaviorLearning.setNotifyFn(notify);
    NetworkIntel.setNotifyFn(notify);
    ChainCommand.setNotifyFn(notify);
    SessionLog.setNotifyFn(notify);
    HealthReport.setNotifyFn(notify);
    BatteryOptimizer.setNotifyFn(notify);
    SelfUpdate.setNotifyFn(notify);

    // Start background services
    NetworkIntel.startMonitoring();
    BatteryOptimizer.start();
    HealthReport.scheduleDaily(21);   // send report at 21:00

    // Start plugin system (optional)
    initPluginManager({ notify, sendMessageFn: sendMessage }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Message router
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main entry point. Route an incoming WA message to the correct module.
 * Call this from whatsapp.js inside the messages.upsert handler BEFORE
 * the .openx prefix check, so module commands work even without the prefix.
 *
 * @param {string} jid   - sender JID (remoteJid)
 * @param {string} text  - raw message text (already trimmed)
 * @returns {boolean}    - true if a module handled the message
 */
export async function handleMessage(jid, text) {
    if (!text || typeof text !== 'string') return false;

    const lower = text.trim().toLowerCase();

    // Log every command for behaviour learning
    BehaviorLearning.logCommand(text);
    HealthReport.incrementCommandCount();

    // ── SelfUpdate commands ────────────────────────────────────────────────
    if (lower === 'apply update') {
        await SelfUpdate.applyUpdate();
        return true;
    }
    if (lower === 'cancel update') {
        SelfUpdate.cancelUpdate();
        return true;
    }
    if (lower === 'preview update') {
        const p = SelfUpdate.getPendingSummary();
        if (!p) {
            if (waSock) waSock.sendMessage(jid, { text: '⚠️ Belum ada pending update.' }).catch(() => {});
            return true;
        }
        const diff = SelfUpdate.getPendingDiffPreview?.(80);
        const msg =
            `🧪 *Preview SelfUpdate*\n` +
            `Modul      : ${p.moduleName}.mjs\n` +
            `Instruksi  : ${p.instruction || '-'}\n` +
            `Baris lama : ${p.oldLineCount}\n` +
            `Baris baru : ${p.newLineCount}\n` +
            `Delta      : ${p.delta >= 0 ? '+' : ''}${p.delta}\n` +
            `Age        : ${p.ageSec} detik\n\n` +
            (diff ? `*Diff preview:*\n${diff}\n\n` : '') +
            `Ketik *apply update* kalau sudah oke.`;
        if (waSock) waSock.sendMessage(jid, { text: msg }).catch(() => {});
        return true;
    }

    // "update <ModuleName>, <instruction>"
    const updateMatch = text.match(/^update\s+(\w+)[,，]\s*(.+)$/i);
    if (updateMatch) {
        await SelfUpdate.requestUpdate(updateMatch[1], updateMatch[2]);
        return true;
    }
    // "rollback <ModuleName>"
    const rollbackMatch = text.match(/^rollback\s+(\w+)$/i);
    if (rollbackMatch) {
        await SelfUpdate.rollback(rollbackMatch[1]);
        return true;
    }

    // ── SessionLog commands ────────────────────────────────────────────────
    if (/^log tadi$|^session log$|^ringkasan aksi$/i.test(lower)) {
        SessionLog.getSummary();
        return true;
    }
    if (/^undo terakhir$|^undo$/i.test(lower)) {
        SessionLog.undo();
        return true;
    }

    // ── BatteryOptimizer commands ──────────────────────────────────────────
    if (/^charge full$/i.test(lower)) {
        BatteryOptimizer.override();
        return true;
    }
    if (/^(battery|baterai|info baterai|cek baterai)$/i.test(lower)) {
        const info = BatteryOptimizer.getBatteryInfo();
        const msg =
            `🔋 *Battery Info*\n` +
            `Kapasitas : ${info.capacity}%\n` +
            `Status    : ${info.status}\n` +
            `Suhu      : ${info.tempC}°C\n` +
            `Charging  : ${info.chargingLimitActive ? '✅ Aktif' : '🚫 Dihentikan'}\n` +
            `Override  : ${info.overrideMode ? '⚡ Charge Full Mode' : '-'}`;
        // Re-use notifyFn via SelfUpdate's already-set reference; simpler to call waSock directly
        if (waSock) waSock.sendMessage(jid, { text: msg }).catch(() => {});
        return true;
    }

    // ── HealthReport commands ──────────────────────────────────────────────
    if (/^(health|laporan|health report|cek kesehatan hp)$/i.test(lower)) {
        await HealthReport.generateReport();
        return true;
    }

    // ── NetworkIntel commands ──────────────────────────────────────────────
    if (/^(data usage|cek data|network|net stats)$/i.test(lower)) {
        const usage = NetworkIntel.getDataUsage();
        const lines = usage.slice(0, 10).map(u => `  ${u.name}: *${u.mb} MB*`).join('\n');
        if (waSock) waSock.sendMessage(jid, { text: `📶 *Top App Data Usage*:\n${lines || '(kosong)'}` }).catch(() => {});
        return true;
    }
    if (/^(network config|net config|config network)$/i.test(lower)) {
        const c = NetworkIntel.getConfig();
        const msg =
            `⚙️ *NetworkIntel Config*\n` +
            `Interval  : ${c.intervalSec}s\n` +
            `Spike     : ${c.spikeMb} MB / interval\n` +
            `Hotspot   : ${c.hotspotMonitor ? 'ON' : 'OFF'}\n\n` +
            `Contoh:\n` +
            `- net set interval 20\n` +
            `- net set spike 25\n` +
            `- net set hotspot on`;
        if (waSock) waSock.sendMessage(jid, { text: msg }).catch(() => {});
        return true;
    }
    const netSetInterval = lower.match(/^net(?:work)? set interval (\d{1,3})$/i);
    if (netSetInterval) {
        const v = parseInt(netSetInterval[1], 10);
        const c = NetworkIntel.updateConfig({ intervalSec: v });
        if (waSock) waSock.sendMessage(jid, { text: `✅ Interval monitor diubah ke ${c.intervalSec}s` }).catch(() => {});
        return true;
    }
    const netSetSpike = lower.match(/^net(?:work)? set spike (\d{1,3})$/i);
    if (netSetSpike) {
        const v = parseInt(netSetSpike[1], 10);
        const c = NetworkIntel.updateConfig({ spikeMb: v });
        if (waSock) waSock.sendMessage(jid, { text: `✅ Spike threshold diubah ke ${c.spikeMb} MB` }).catch(() => {});
        return true;
    }
    const netSetHotspot = lower.match(/^net(?:work)? set hotspot (on|off)$/i);
    if (netSetHotspot) {
        const on = netSetHotspot[1].toLowerCase() === 'on';
        const c = NetworkIntel.updateConfig({ hotspotMonitor: on });
        if (waSock) waSock.sendMessage(jid, { text: `✅ Hotspot monitor ${c.hotspotMonitor ? 'ON' : 'OFF'}` }).catch(() => {});
        return true;
    }
    if (/^(hotspot status|status hotspot)$/i.test(lower)) {
        const hs = NetworkIntel.getHotspotStatus();
        const lines = Object.entries(hs.interfaces || {})
            .map(([iface, v]) => `- ${iface}: ${((v.total || 0) / 1024 / 1024).toFixed(2)} MB total`)
            .join('\n');
        const msg =
            `🔥 *Hotspot Status*\n` +
            `Monitor : ${hs.monitorEnabled ? 'ON' : 'OFF'}\n` +
            `Aktif   : ${hs.active ? 'YA' : 'TIDAK'}\n` +
            `${lines || '- interface hotspot belum terdeteksi'}`;
        if (waSock) waSock.sendMessage(jid, { text: msg }).catch(() => {});
        return true;
    }

    // ── BehaviorLearning commands ──────────────────────────────────────────
    if (/^(pola|patterns|behavior|kebiasaan gw)$/i.test(lower)) {
        const patterns  = BehaviorLearning.getPatterns();
        const today     = Object.values(patterns.dailySummaries).slice(-1)[0];
        const topCmd    = today
            ? Object.entries(today.cmdCounts).sort((a, b) => b[1] - a[1])[0]
            : null;
        const daysStr   = Object.keys(patterns.dailySummaries).length;
        const msg =
            `📈 *Behavior Patterns*\n` +
            `Data terkumpul : ${daysStr} hari\n` +
            `Command favorit: ${topCmd ? `${topCmd[0]} (${topCmd[1]}x)` : '-'}`;
        if (waSock) waSock.sendMessage(jid, { text: msg }).catch(() => {});
        return true;
    }

    // ── ChainCommand — detect chained natural language ─────────────────────
    // Trigger keywords that suggest a chain command
    if (/kalau .+(?:terus|lalu|abis itu|kemudian|trus)/.test(lower)) {
        const chain = ChainCommand.parseChain(text);
        if (chain) {
            ChainCommand.registerChain(chain);
            const triggerDesc = describeTrigger(chain.trigger);
            const actCount    = chain.actions.length;
            if (waSock) waSock.sendMessage(jid, {
                text:
                    `🔗 *ChainCommand terdaftar!*\n` +
                    `Trigger : ${triggerDesc}\n` +
                    `Aksi    : ${actCount} langkah\n\n` +
                    `Gue bakal jalanin otomatis saat trigger terpenuhi.`
            }).catch(() => {});
            return true;
        }
    }

    // ── Snapshot command ───────────────────────────────────────────────────
    if (/^snapshot$|^snapshot hp$/i.test(lower)) {
        const snap = SessionLog.snapshot();
        const msg =
            `📸 *Device Snapshot*\n` +
            `RAM tersedia  : ${snap.ram?.availMB ?? '?'} MB / ${snap.ram?.totalMB ?? '?'} MB\n` +
            `Foreground    : ${snap.foreground ?? '(launcher)'}\n` +
            `Status charger: ${snap.charging ?? '?'}\n` +
            `Baterai       : ${snap.batteryPct ?? '?'}%`;
        if (waSock) waSock.sendMessage(jid, { text: msg }).catch(() => {});
        return true;
    }

    // ── Help ───────────────────────────────────────────────────────────────
    if (/^\.modules$|^modul apa aja$/i.test(lower)) {
        const help =
            `🧩 *OpenX Module Commands*\n\n` +
            `🔋 *Battery*\n` +
            `  • \`charge full\` — bypass stop, charge ke 100%\n` +
            `  • \`battery\` — cek info baterai\n\n` +
            `📊 *Health*\n` +
            `  • \`health report\` — generate laporan sekarang\n\n` +
            `📶 *Network*\n` +
            `  • \`data usage\` — lihat top app data usage\n` +
            `  • \`network config\` — lihat konfigurasi monitor\n` +
            `  • \`net set interval 20\`\n` +
            `  • \`net set spike 25\`\n` +
            `  • \`net set hotspot on/off\`\n` +
            `  • \`hotspot status\`\n\n` +
            `📋 *Session*\n` +
            `  • \`log tadi\` — ringkasan aksi sesi ini\n` +
            `  • \`undo terakhir\` — batalkan aksi terakhir\n` +
            `  • \`snapshot\` — cek status HP sekarang\n\n` +
            `🔗 *Chain Command*\n` +
            `  • \`kalau [app] udah ditutup, matiin WiFi terus ingetin tidur jam 11\`\n\n` +
            `🤖 *Self Update*\n` +
            `  • \`update BatteryOptimizer, [instruksi]\`\n` +
            `  • \`preview update\` | \`apply update\` | \`cancel update\`\n` +
            `  • \`rollback [modul]\`\n\n` +
            `📈 *Patterns*\n` +
            `  • \`pola\` — lihat kebiasaan penggunaan\n` +
            `  • \`.modules\` — tampilkan menu ini`;
        if (waSock) waSock.sendMessage(jid, { text: help }).catch(() => {});
        return true;
    }

    // ── Plugins (external) ─────────────────────────────────────────────────
    // Runs after core modules help so we keep existing UX intact.
    const pluginHandled = await handlePluginsMessage(jid, text);
    if (pluginHandled) return true;

    return false; // not handled by any module
}


// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Human-readable trigger description */
function describeTrigger(trigger) {
    switch (trigger.type) {
        case 'app_closed': return `App "${trigger.value}" ditutup`;
        case 'app_open':   return `App "${trigger.value}" dibuka`;
        case 'time':       return `Jam ${trigger.value}`;
        case 'battery':    return `Baterai ≤ ${trigger.value}%`;
        default:           return String(trigger.value);
    }
}

// Re-export everything for direct access if needed
export {
    BehaviorLearning,
    NetworkIntel,
    ChainCommand,
    SessionLog,
    HealthReport,
    BatteryOptimizer,
    SelfUpdate,
};
