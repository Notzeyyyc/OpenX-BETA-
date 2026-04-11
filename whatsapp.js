import { makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage, fetchLatestWaWebVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import path from 'path';
import fs from 'fs';
import { log, error as logError } from './logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';
const execPromise = promisify(exec);
import { chatCompletion } from './package/openx/openrouter.js';
import {
    getDeviceInfo,
    getAppList,
    takeScreenshot,
    sendNotification,
    getHealthStatus,
    launchApp,
    tapByText,
    tapByResourceId,
    scrollScreen,
    pressBack,
    pressHome,
    dumpUiHierarchy,
    runUiFlow
} from './package/adb_helper.js';
import { downloadMedia } from './package/downloader.js';
import { config } from './config.js';
import { initModules, handleMessage as moduleHandleMessage } from './modules/index.mjs';

let targetModel = "stepfun/step-3.5-flash:free";

// Grab the current default model from the config file
function getCurrentModel() {
    try {
        const modelData = JSON.parse(fs.readFileSync("./package/model.json", "utf-8"));
        return modelData.defaultModel;
    } catch {
        return targetModel;
    }
}

const STORAGE_CONTEXT_TTL_MS = 15000;
const STORAGE_MAX_FILES = 20;
const STORAGE_MAX_CHARS_PER_FILE = 1200;
const storageContextCache = { ts: 0, text: "" };

function buildStorageContext() {
    const now = Date.now();
    if (now - storageContextCache.ts < STORAGE_CONTEXT_TTL_MS) {
        return storageContextCache.text;
    }

    let storageContext = "";
    try {
        const storageDir = "./package/storage";
        if (fs.existsSync(storageDir)) {
            const files = fs.readdirSync(storageDir)
                .map(name => {
                    const full = path.join(storageDir, name);
                    let mtime = 0;
                    try { mtime = fs.statSync(full).mtimeMs; } catch {}
                    return { name, full, mtime };
                })
                .filter(f => fs.existsSync(f.full) && fs.statSync(f.full).isFile())
                .sort((a, b) => b.mtime - a.mtime)
                .slice(0, STORAGE_MAX_FILES);

            for (const f of files) {
                let raw = "";
                try { raw = fs.readFileSync(f.full, "utf-8"); } catch {}
                if (!raw) continue;
                const sliced = raw.length > STORAGE_MAX_CHARS_PER_FILE
                    ? `${raw.slice(0, STORAGE_MAX_CHARS_PER_FILE)}\n...(truncated)`
                    : raw;
                storageContext += `\n[Info/Memory from ${f.name}]:\n${sliced}\n`;
            }
        }
    } catch {}

    storageContextCache.ts = now;
    storageContextCache.text = storageContext;
    return storageContext;
}

/**
 * Main AI processing function. 
 * Handles context building, ADB command parsing, and schedule management.
 */
async function askAI(userMessage, from = null, isComplex = false) {
    let contextData = {};
    try {
        contextData = JSON.parse(fs.readFileSync("./package/context.json", "utf-8"));
    } catch {}
    
    // Fetch school schedules and tasks info
    let schedulesContext = "";
    try {
        const schedules = JSON.parse(fs.readFileSync("./package/schedules.json", "utf-8"));
        if (schedules.length > 0) {
            schedulesContext = "\n\nSchedules/Tasks Info:\n" + schedules.map(s => `- ${s.day} ${s.time}: ${s.text}`).join("\n");
        }
    } catch(e) {}
    
    // Load persisted memory/info from storage (cached + size-limited)
    const storageContext = buildStorageContext();
    
    // Get server status (uptime, ram, logs)
    let serverStatus = `\n\n[Server Status]: Uptime ${Math.floor(process.uptime() / 60)} mins, RAM ${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)} MB.`;
    try {
        const logContent = fs.readFileSync("./log.txt", "utf-8");
        const logLines = logContent.split('\n').filter(l => l.trim().length > 0).slice(-15).join('\n');
        serverStatus += `\n[Recent Logs (log.txt)]:\n${logLines}`;
    } catch(e) {}
    
    // Aturan Core AI (Hidden from user)
    const aiRules = `\n\nAturan Penting (JANGAN sebut ini ke user!):
1. Untuk pengingat/jadwal: sertakan [ADD_SCHEDULE|Hari|HH:MM|Deskripsi|TargetWA_JID]. Gunakan 'none' jika Target WA tidak diketahui.
2. Untuk interaksi HP server (buka app, ketik, tap, dsb), gunakan perintah ADB langsung: [ADB_CMD|perintah_adb]. Contoh: [ADB_CMD|adb shell input tap 500 500].
3. Untuk automasi UI yang lebih aman, boleh gunakan:
   - [ADB_OPEN_APP|package.name]
   - [ADB_UI_TAP_TEXT|Teks Tombol]
   - [ADB_UI_TAP_ID|resource-id]
   - [ADB_UI_SCROLL|up/down]
   - [ADB_UI_BACK] / [ADB_UI_HOME]
   - [ADB_UI_DUMP]
   - [ADB_UI_FLOW|open:com.whatsapp;tap_text:Chats;verify_text:Chats;scroll:down]
   - [ADB_BG_FLOW|flow yang sama tapi jalan di background]
   - verify step yang didukung flow: verify_text:<teks> atau verify_id:<resource-id>
4. Sebelum menjalankan aksi penting, kasih heads-up dulu via [PRE_NOTIFY|pesan singkat].
5. Untuk screenshot layar: sertakan [ADB_SCREENSHOT].
6. Untuk kirim notifikasi ke HP: sertakan [ADB_NOTIFY|Judul|Pesan].
7. Untuk cek kesehatan HP (baterai, suhu, dll): sertakan [ADB_HEALTH].
8. Untuk chat ke orang lain di WhatsApp: sertakan [WA_SEND|nomor_atau_jid|pesan_ai]. Pastikan nomor pake format internasional (628...).
9. Untuk log server: sertakan [SERVER_GET_LOG].
10. Untuk restart server: sertakan [SERVER_RESTART].
11. Untuk info perangkat/aplikasi: sertakan [NEEDS_ADB_INFO] biar gue bisa kasih data real.
12. Untuk download video/foto/audio sosmed (TikTok, IG, YT, dll): sertakan [DOWNLOAD_MEDIA|URL].

PENTING: Balas dengan gaya bahasa sesuai kepribadian lu yang sudah ditentukan di atas. Taro tag perintah di paling akhir balasan secara tersembunyi.`;

    // Load personality settings
    let personalities = { active: "default", profiles: {} };
    try {
        personalities = JSON.parse(fs.readFileSync("./package/personalities.json", "utf-8"));
    } catch (e) {}
    
    const activeProfile = personalities.profiles[personalities.active] || personalities.profiles["default"];
    const personalityPrompt = activeProfile ? activeProfile.prompt : "Lu adalah OPENX, asisten AI khusus buat pelajar.";

    const systemPrompt = personalityPrompt + schedulesContext + storageContext + serverStatus + aiRules;
    
    let messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
    ];
    
    let aiResult = await chatCompletion(messages, getCurrentModel(), isComplex) || "";
    
    // Handle dynamic ADB info request
    if (aiResult.includes("[NEEDS_ADB_INFO]")) {
        try {
            const di = await getDeviceInfo();
            const al = await getAppList();
            messages.push({ role: "assistant", content: aiResult });
            messages.push({ role: "user", content: `(System) Real device and app info:\n${di}\n${al}\nNow, fulfill the user request using this real data.` });
            aiResult = await chatCompletion(messages, getCurrentModel(), isComplex);
            if (!aiResult) aiResult = "";
        } catch(e) {}
        aiResult = aiResult.replace(/\[NEEDS_ADB_INFO\]/g, "");
    }

    // ADB command gate (sensitive action)
    const adbCmdRegex = /\[ADB_CMD\|(.*?)\]/g;
    let adbMatch;
    const commands = [];
    while ((adbMatch = adbCmdRegex.exec(aiResult)) !== null) {
        commands.push(adbMatch[1].trim());
    }
    if (commands.length > 0 && from) {
        const token = queueSensitiveAction(from, 'adb_cmd', { commands }, `ADB command x${commands.length}`);
        await sendSensitiveConfirmationPrompt(from, `Aksi sensitif terdeteksi: ADB command (${commands.length})`, token);
    }
    aiResult = aiResult.replace(adbCmdRegex, '');

    // Optional pre-notify message to user before actions
    const preNotifyRegex = /\[PRE_NOTIFY\|(.*?)\]/g;
    let pnMatch;
    while ((pnMatch = preNotifyRegex.exec(aiResult)) !== null) {
        if (from && waSock) {
            await waSock.sendMessage(from, { text: pnMatch[1].trim() }).catch(() => {});
        }
    }
    aiResult = aiResult.replace(preNotifyRegex, '');
    
    // Schedule Setup Parser
    const regex = /\[ADD_SCHEDULE\|(.*?)\|(.*?)\|(.*?)\|(.*?)\]/g;
    let match;
    while ((match = regex.exec(aiResult)) !== null) {
        try {
            let dayStr = match[1].trim().toLowerCase();
            const timeStr = match[2].trim();
            const desc = match[3].trim();
            const targetWa = match[4].trim() === "none" ? null : match[4].trim();
            
            // Relative day handling
            if (dayStr === 'besok') { const d = ['minggu','senin','selasa','rabu','kamis','jumat','sabtu']; dayStr = d[(new Date().getDay() + 1) % 7]; }
            if (dayStr === 'hari ini' || dayStr === 'nanti') { const d = ['minggu','senin','selasa','rabu','kamis','jumat','sabtu']; dayStr = d[new Date().getDay()]; }
            
            const dayMap = { "minggu": 0, "senin": 1, "selasa": 2, "rabu": 3, "kamis": 4, "jumat": 5, "sabtu": 6 };
            const dayIdx = dayMap[dayStr] !== undefined ? dayMap[dayStr] : '*';
            
            let [hh, mm] = timeStr.split(':');
            if (hh && mm) {
                let cronString = `${parseInt(mm)} ${parseInt(hh)} * * ${dayIdx}`;
                const schedulePath = "./package/schedules.json";
                let schedules = [];
                if (fs.existsSync(schedulePath)) schedules = JSON.parse(fs.readFileSync(schedulePath, "utf-8"));
                
                schedules.push({
                    id: Date.now().toString().slice(-6),
                    day: dayStr,
                    time: timeStr,
                    cronString: cronString,
                    text: desc,
                    targets: targetWa ? [targetWa] : []
                });
                fs.writeFileSync(schedulePath, JSON.stringify(schedules, null, 2));
            }
        } catch(e) {}
    }
    aiResult = aiResult.replace(regex, '');
    
    // ADB Screenshot Request
    const adbScRegex = /\[ADB_SCREENSHOT\]/g;
    if (adbScRegex.test(aiResult)) {
        if (from && waSock) {
            const tempPath = path.join(process.cwd(), "caches", `ss_${Date.now()}.png`);
            takeScreenshot(tempPath).then(success => {
                if (success) {
                    waSock.sendMessage(from, { image: fs.readFileSync(tempPath) }).catch(()=>{});
                    setTimeout(() => { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); }, 5000);
                }
            });
        }
        aiResult = aiResult.replace(adbScRegex, '');
    }
    
    // Server Logs Request
    const getLogRegex = /\[SERVER_GET_LOG\]/g;
    if (getLogRegex.test(aiResult)) {
        if (from && waSock) {
            try {
                const logPath = "./log.txt";
                if (fs.existsSync(logPath)) {
                    await waSock.sendMessage(from, { document: fs.readFileSync(logPath), fileName: "log.txt", mimetype: "text/plain" });
                }
            } catch(e) {}
        }
        aiResult = aiResult.replace(getLogRegex, '');
    }

    // Server Restart Request
    const restartRegex = /\[SERVER_RESTART\]/g;
    if (restartRegex.test(aiResult)) {
        if (from && waSock) {
            const token = queueSensitiveAction(from, 'server_restart', {}, 'Server restart');
            await sendSensitiveConfirmationPrompt(from, 'Aksi sensitif: restart server', token);
        }
        aiResult = aiResult.replace(restartRegex, '');
    }
    
    // ADB Notification Handler
    const adbNotifyRegex = /\[ADB_NOTIFY\|(.*?)\|(.*?)\]/g;
    let notifyMatch;
    while ((notifyMatch = adbNotifyRegex.exec(aiResult)) !== null) {
        sendNotification(notifyMatch[1], notifyMatch[2]).catch(() => {});
    }
    aiResult = aiResult.replace(adbNotifyRegex, '');

    // UIAutomator / navigation helpers
    const openAppRegex = /\[ADB_OPEN_APP\|(.*?)\]/g;
    let openMatch;
    while ((openMatch = openAppRegex.exec(aiResult)) !== null) {
        await launchApp(openMatch[1].trim());
    }
    aiResult = aiResult.replace(openAppRegex, '');

    const tapTextRegex = /\[ADB_UI_TAP_TEXT\|(.*?)\]/g;
    let tapTextMatch;
    while ((tapTextMatch = tapTextRegex.exec(aiResult)) !== null) {
        await tapByText(tapTextMatch[1].trim());
    }
    aiResult = aiResult.replace(tapTextRegex, '');

    const tapIdRegex = /\[ADB_UI_TAP_ID\|(.*?)\]/g;
    let tapIdMatch;
    while ((tapIdMatch = tapIdRegex.exec(aiResult)) !== null) {
        await tapByResourceId(tapIdMatch[1].trim());
    }
    aiResult = aiResult.replace(tapIdRegex, '');

    const scrollRegex = /\[ADB_UI_SCROLL\|(.*?)\]/g;
    let scrollMatch;
    while ((scrollMatch = scrollRegex.exec(aiResult)) !== null) {
        await scrollScreen(scrollMatch[1].trim());
    }
    aiResult = aiResult.replace(scrollRegex, '');

    if (/\[ADB_UI_BACK\]/.test(aiResult)) {
        await pressBack();
        aiResult = aiResult.replace(/\[ADB_UI_BACK\]/g, '');
    }
    if (/\[ADB_UI_HOME\]/.test(aiResult)) {
        await pressHome();
        aiResult = aiResult.replace(/\[ADB_UI_HOME\]/g, '');
    }
    if (/\[ADB_UI_DUMP\]/.test(aiResult)) {
        const dump = await dumpUiHierarchy();
        if (dump.ok) {
            messages.push({ role: "assistant", content: aiResult });
            messages.push({ role: "user", content: `(System) UI dump success. Node count: ${dump.nodeCount}. Suggest next navigation step in plain language.` });
            aiResult = await chatCompletion(messages, getCurrentModel(), isComplex) || aiResult;
        }
        aiResult = aiResult.replace(/\[ADB_UI_DUMP\]/g, '');
    }

    const uiFlowRegex = /\[ADB_UI_FLOW\|(.*?)\]/g;
    let flowMatch;
    while ((flowMatch = uiFlowRegex.exec(aiResult)) !== null) {
        const flow = flowMatch[1].trim();
        const result = await runUiFlow(flow, { retries: 2, verifyWaitMs: 700 });
        if (from && waSock) {
            const tail = result.logs.slice(-6).join('\n');
            const msg = result.ok
                ? `✅ UI flow selesai.\n${tail}`
                : `❌ UI flow gagal.\n${tail}`;
            await waSock.sendMessage(from, { text: msg }).catch(() => {});
        }
    }
    aiResult = aiResult.replace(uiFlowRegex, '');

    const bgFlowRegex = /\[ADB_BG_FLOW\|(.*?)\]/g;
    let bgFlowMatch;
    while ((bgFlowMatch = bgFlowRegex.exec(aiResult)) !== null) {
        const flow = bgFlowMatch[1].trim();
        const task = enqueueBgFlow(flow, from);
        if (from && waSock) {
            await waSock.sendMessage(from, { text: `📥 BG task masuk queue: ${task.id}` }).catch(() => {});
        }
        processAdbBgQueue();
    }
    aiResult = aiResult.replace(bgFlowRegex, '');

    // ADB Health Handler
    if (aiResult.includes("[ADB_HEALTH]")) {
        try {
            const healthReport = await getHealthStatus();
            messages.push({ role: "assistant", content: aiResult });
            messages.push({ role: "user", content: `(System) Real Health Info:\n${healthReport}\nTell the user about this health status naturally.` });
            aiResult = await chatCompletion(messages, getCurrentModel(), isComplex);
            if (!aiResult) aiResult = "";
        } catch(e) {}
        aiResult = aiResult.replace(/\[ADB_HEALTH\]/g, "");
    }

    // WA Send/Chat to someone else
    const waSendRegex = /\[WA_SEND\|(.*?)\|(.*?)\]/g;
    let waMatch;
    const waPending = [];
    while ((waMatch = waSendRegex.exec(aiResult)) !== null) {
        waPending.push({ target: waMatch[1].trim(), text: waMatch[2].trim() });
    }
    if (waPending.length > 0 && from && waSock) {
        const token = queueSensitiveAction(from, 'wa_send', { messages: waPending }, `WA send x${waPending.length}`);
        await sendSensitiveConfirmationPrompt(from, `Aksi sensitif: kirim pesan ke nomor lain (${waPending.length} target)`, token);
    }
    aiResult = aiResult.replace(waSendRegex, '');

    // DOWNLOAD_MEDIA Tag Handler
    const dlRegex = /\[DOWNLOAD_MEDIA\|(.*?)\]/g;
    let dlMatch;
    while ((dlMatch = dlRegex.exec(aiResult)) !== null) {
        const url = dlMatch[1].trim();
        downloadMedia(url).then(async (res) => {
            if (from && waSock) {
                if (res.type === "video") await waSock.sendMessage(from, { video: res.buffer, fileName: res.filename });
                else if (res.type === "audio") await waSock.sendMessage(from, { audio: res.buffer, fileName: res.filename });
                else await waSock.sendMessage(from, { document: res.buffer, fileName: res.filename, mimetype: "application/octet-stream" });
            }
        }).catch(err => logError(`Download failed for ${url}:`, err));
    }
    aiResult = aiResult.replace(dlRegex, '');
    
    return aiResult.trim();
}

// Clean up markdown before sending to WhatsApp
function stripMarkdown(text) {
    if (!text) return text;
    return text
        .replace(/\*\*/g, '')
        .replace(/\*\*/g, '')
        .replace(/__/g, '')
        .replace(/_/g, '')
        .replace(/`/g, '')
        .replace(/\[\]/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/#{1,6}\s/g, '')
        .replace(/\n\s*\n/g, '\n\n')
        .trim();
}

// Unique 5-digit file identifier
function generateFileId() {
    return Math.floor(10000 + Math.random() * 90000).toString();
}

// Ensure local directory for user files
function ensureUserDir(chatId) {
    const cleanId = String(chatId).split('@')[0];
    const dir = path.join("./caches/files", cleanId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// Persist media file and metadata
function saveLocalFile(chatId, buffer, filename) {
    const dir = ensureUserDir(chatId);
    const savePath = path.join(dir, filename);
    fs.writeFileSync(savePath, buffer);
    
    const metaPath = path.join(dir, "meta.json");
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); } catch {}
    
    let fileIdNum = generateFileId();
    while (meta[fileIdNum]) fileIdNum = generateFileId();
    
    meta[fileIdNum] = { localPath: savePath, filename, date: new Date().toISOString() };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    return fileIdNum;
}

// Retrieve file metadata by ID
function getLocalFileById(chatId, fileIdNum) {
    const dir = path.join("./caches/files", String(chatId).split('@')[0]);
    const metaPath = path.join(dir, "meta.json");
    try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        return meta[fileIdNum] || null;
    } catch {
        return null;
    }
}

function getLocalMeta(chatId) {
    const dir = path.join("./caches/files", String(chatId).split('@')[0]);
    const metaPath = path.join(dir, "meta.json");
    try {
        return JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    } catch {
        return {};
    }
}

function setLocalMeta(chatId, meta) {
    const dir = path.join("./caches/files", String(chatId).split('@')[0]);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const metaPath = path.join(dir, "meta.json");
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

function listLocalFiles(chatId, limit = 15) {
    const meta = getLocalMeta(chatId);
    const rows = Object.entries(meta)
        .map(([id, info]) => ({ id, ...info }))
        .sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime())
        .slice(0, limit);
    return rows;
}

function deleteLocalFileById(chatId, fileIdNum) {
    const meta = getLocalMeta(chatId);
    const item = meta[fileIdNum];
    if (!item) return { ok: false, reason: "not_found" };

    try {
        if (item.localPath && fs.existsSync(item.localPath)) {
            fs.unlinkSync(item.localPath);
        }
    } catch {}

    delete meta[fileIdNum];
    setLocalMeta(chatId, meta);
    return { ok: true, filename: item.filename || "unknown" };
}

function renameLocalFileById(chatId, fileIdNum, newName) {
    const safeName = String(newName || '').trim().replace(/[\\/:*?"<>|]/g, '_');
    if (!safeName) return { ok: false, reason: "invalid_name" };

    const meta = getLocalMeta(chatId);
    const item = meta[fileIdNum];
    if (!item) return { ok: false, reason: "not_found" };
    if (!item.localPath || !fs.existsSync(item.localPath)) return { ok: false, reason: "missing_file" };

    const dir = path.dirname(item.localPath);
    const targetPath = path.join(dir, safeName);
    try {
        fs.renameSync(item.localPath, targetPath);
        meta[fileIdNum] = {
            ...item,
            localPath: targetPath,
            filename: safeName,
            date: new Date().toISOString()
        };
        setLocalMeta(chatId, meta);
        return { ok: true, filename: safeName };
    } catch {
        return { ok: false, reason: "rename_failed" };
    }
}

export let waSock = null;

// AI Message Queue System
const aiQueue = [];
let isProcessingQueue = false;
const adbBgQueue = [];
let isProcessingAdbBgQueue = false;
let activeBgTask = null;
let bgTaskSeq = 1;
const bgTaskHistory = [];
const pendingSensitiveActions = new Map();
const SENSITIVE_TTL_MS = 2 * 60 * 1000;

function createSensitiveToken() {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function queueSensitiveAction(chatId, actionType, payload, summary) {
    const token = createSensitiveToken();
    pendingSensitiveActions.set(String(chatId), {
        token,
        actionType,
        payload,
        summary,
        createdAt: Date.now()
    });
    return token;
}

async function sendSensitiveConfirmationPrompt(jid, title, token) {
    const fallbackText =
        `⚠️ ${title}\n` +
        `Ketik *confirm ${token}* untuk lanjut, atau *cancel confirm* untuk batalkan.`;

    if (!waSock) return;

    try {
        await waSock.sendMessage(jid, {
            text: `⚠️ ${title}\nPilih aksi di bawah (atau pakai teks fallback).`,
            footer: `Fallback: confirm ${token}`,
            buttons: [
                { buttonId: `confirm:${token}`, buttonText: { displayText: '✅ Confirm' }, type: 1 },
                { buttonId: 'cancel_confirm', buttonText: { displayText: '❌ Cancel' }, type: 1 }
            ],
            headerType: 1
        });
    } catch {
        await waSock.sendMessage(jid, { text: fallbackText }).catch(() => {});
        return;
    }

    await waSock.sendMessage(jid, { text: fallbackText }).catch(() => {});
}

async function executeSensitiveAction(pending, from) {
    if (!pending) return { ok: false, text: "Aksi tidak ditemukan." };
    try {
        if (pending.actionType === 'adb_cmd') {
            const commands = pending.payload?.commands || [];
            let totalOutput = "";
            for (const cmd of commands) {
                try {
                    const { stdout, stderr } = await execPromise(cmd);
                    totalOutput += `[Command: ${cmd}]\n${stdout || "(no output)"}\n${stderr ? `ERR: ${stderr}\n` : ""}`;
                } catch (err) {
                    totalOutput += `[Command: ${cmd}] FAILED: ${err.message}\n`;
                }
            }
            return { ok: true, text: totalOutput.trim() || "Command selesai dijalankan." };
        }

        if (pending.actionType === 'server_restart') {
            if (from && waSock) {
                await waSock.sendMessage(from, { text: "♻️ Restart server dalam 2 detik..." }).catch(() => {});
            }
            setTimeout(() => process.exit(1), 2000);
            return { ok: true, text: "Restart dijadwalkan." };
        }

        if (pending.actionType === 'wa_send') {
            const list = pending.payload?.messages || [];
            let sent = 0;
            for (const item of list) {
                if (!waSock) break;
                let target = String(item.target || '').trim();
                if (!target) continue;
                if (!target.includes('@')) target = `${target}@s.whatsapp.net`;
                await waSock.sendMessage(target, { text: String(item.text || '') }).catch(() => {});
                sent++;
            }
            return { ok: true, text: `WA send selesai. Total terkirim: ${sent}` };
        }

        return { ok: false, text: "Tipe aksi tidak dikenali." };
    } catch (e) {
        return { ok: false, text: `Eksekusi gagal: ${e.message}` };
    }
}

function enqueueBgFlow(flow, from) {
    const task = {
        id: `BG${String(bgTaskSeq++).padStart(4, '0')}`,
        flow,
        from,
        status: 'queued',
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        cancelRequested: false,
        logs: []
    };
    adbBgQueue.push(task);
    return task;
}

function cancelBgTask(selector = 'last') {
    const key = String(selector || 'last').toLowerCase();
    if (key === 'all') {
        for (const t of adbBgQueue) t.cancelRequested = true;
        adbBgQueue.length = 0;
        if (activeBgTask) activeBgTask.cancelRequested = true;
        return { ok: true, msg: 'Semua queued task dibatalkan. Task aktif akan berhenti setelah step berjalan.' };
    }

    if (key === 'active' || key === 'running') {
        if (!activeBgTask) return { ok: false, msg: 'Tidak ada task aktif.' };
        activeBgTask.cancelRequested = true;
        return { ok: true, msg: `Task aktif ${activeBgTask.id} diminta berhenti.` };
    }

    if (key === 'last') {
        const last = adbBgQueue[adbBgQueue.length - 1];
        if (!last) return { ok: false, msg: 'Tidak ada task queued.' };
        last.cancelRequested = true;
        adbBgQueue.pop();
        return { ok: true, msg: `Task ${last.id} dibatalkan dari queue.` };
    }

    const idx = adbBgQueue.findIndex(t => t.id.toLowerCase() === key);
    if (idx !== -1) {
        adbBgQueue[idx].cancelRequested = true;
        const id = adbBgQueue[idx].id;
        adbBgQueue.splice(idx, 1);
        return { ok: true, msg: `Task ${id} dibatalkan dari queue.` };
    }
    if (activeBgTask && activeBgTask.id.toLowerCase() === key) {
        activeBgTask.cancelRequested = true;
        return { ok: true, msg: `Task aktif ${activeBgTask.id} diminta berhenti.` };
    }
    return { ok: false, msg: `Task ${selector} tidak ditemukan.` };
}

function getBgStatusText() {
    const queued = adbBgQueue.length;
    const active = activeBgTask
        ? `Aktif: ${activeBgTask.id} (${Math.round((Date.now() - activeBgTask.startedAt) / 1000)}s)`
        : 'Aktif: -';
    const next = adbBgQueue.slice(0, 5).map(t => `${t.id}`).join(', ') || '-';
    return `📦 *Background Queue Status*\n${active}\nQueued: ${queued}\nNext: ${next}`;
}

async function processAdbBgQueue() {
    if (isProcessingAdbBgQueue || adbBgQueue.length === 0) return;
    isProcessingAdbBgQueue = true;

    while (adbBgQueue.length > 0) {
        const task = adbBgQueue.shift();
        const { flow, from } = task;
        try {
            if (task.cancelRequested) {
                task.status = 'cancelled';
                task.finishedAt = Date.now();
                bgTaskHistory.push(task);
                continue;
            }
            activeBgTask = task;
            task.status = 'running';
            task.startedAt = Date.now();
            if (from && waSock) {
                await waSock.sendMessage(from, { text: `🛠️ Mulai UI flow background (${task.id})...` }).catch(() => {});
            }
            const result = await runUiFlow(flow, { retries: 2, verifyWaitMs: 700 });
            task.logs = result.logs || [];
            task.finishedAt = Date.now();
            task.status = result.ok ? 'done' : 'failed';
            if (from && waSock) {
                const tail = result.logs.slice(-6).join('\n');
                const msg = result.ok
                    ? `✅ UI flow background ${task.id} selesai.\n${tail}`
                    : `❌ UI flow background ${task.id} gagal.\n${tail}`;
                await waSock.sendMessage(from, { text: msg }).catch(() => {});
            }
        } catch (e) {
            task.finishedAt = Date.now();
            task.status = 'failed';
            task.logs = [...(task.logs || []), `ERROR ${e.message}`];
            if (from && waSock) {
                await waSock.sendMessage(from, { text: `❌ UI flow error: ${e.message}` }).catch(() => {});
            }
        } finally {
            activeBgTask = null;
            bgTaskHistory.push(task);
            if (bgTaskHistory.length > 50) bgTaskHistory.shift();
        }
    }

    isProcessingAdbBgQueue = false;
}

// Sequentially process messages in the queue to avoid rate limits
async function processQueue() {
    if (isProcessingQueue || aiQueue.length === 0) return;
    isProcessingQueue = true;
    
    while (aiQueue.length > 0) {
        const { msg, textMessage, from, isComplex } = aiQueue.shift();
        try {
            await waSock.readMessages([msg.key]);
            await waSock.presenceSubscribe(from);
            await waSock.sendPresenceUpdate('composing', from);
            
            const aiResponse = await askAI(textMessage, from, isComplex);
            const cleanResponse = stripMarkdown(aiResponse) || 'Sorry, something went wrong while processing your message.';
            
            await waSock.sendPresenceUpdate('paused', from);
            await waSock.sendMessage(from, { text: cleanResponse }, { quoted: msg });
            log(`Successfully replied to WA message from ${from}`);
        } catch (err) {
            logError(err);
            await waSock.sendMessage(from, { text: 'System error, please try again.' }, { quoted: msg });
        }
        
        // Anti-Rate Limit Delay (18 seconds) for OpenRouter
        await new Promise(resolve => setTimeout(resolve, 18000));
    }
    isProcessingQueue = false;
}

// WhatsApp Connection Logic
export async function connectToWhatsApp() {
    log('Attempting to connect to WhatsApp...');
    
    const { state, saveCreds } = await useMultiFileAuthState('caches/baileys_auth_info');
    
    const { version } = await fetchLatestWaWebVersion();
    
    waSock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }), // Suppress pino logs
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    waSock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            log('Please scan the WhatsApp QR Code below:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            logError(`WhatsApp connection closed, reason: ${lastDisconnect.error?.message}. Reconnect: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                log('WhatsApp logged out, please delete caches/baileys_auth_info folder to relogin.');
            }
        } else if (connection === 'open') {
            log('Successfully connected to WhatsApp!');

            // Initialise OpenX module system
            if (!config.devPhoneNumber) {
                logError('Missing OPENX_DEV_PHONE_NUMBER. Set it in environment/.env before running.');
            }
            const adminJid = (config.devPhoneNumber || '').includes('@')
                ? config.devPhoneNumber
                : `${config.devPhoneNumber}@s.whatsapp.net`;
            initModules(adminJid, (jid, msg) => waSock.sendMessage(jid, msg));
            
            // Interval Auto-Post ke Admin Channels (1 jam)
            setInterval(async () => {
                let waConfig = { adminChannels: [] };
                try { waConfig = JSON.parse(fs.readFileSync("./package/wa_config.json", "utf-8")); } catch(e) {}
                
                if (waConfig.adminChannels && waConfig.adminChannels.length > 0) {
                    for (const channelJid of waConfig.adminChannels) {
                        try {
                            const topicContext = "Buatkan satu post menarik, singkat, random (misal fakta unik, komedi, berita singkat, tips, atau sapaan) untuk disebarkan (broadcast) ke WhatsApp Channel kekinian. Gunakan bahasa gaul lu/gue yang asik tanpa basa-basi.";
                            const postContent = await askAI(topicContext);
                            await waSock.sendMessage(channelJid, { text: stripMarkdown(postContent) });
                            log(`[Cron] Successfully posted random content to WA Channel: ${channelJid}`);
                        } catch (err) {
                            logError(`[Cron] Failed posting to channel ${channelJid}: ${err.message}`);
                        }
                    }
                }
            }, 3600000);
        }
    });

    waSock.ev.on('creds.update', saveCreds);

    waSock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message) return;

            const from = msg.key.remoteJid;
            const participant = msg.key.participant || from;

            let waConfig = { statusTargets: [], adminChannels: [] };
            try { waConfig = JSON.parse(fs.readFileSync("./package/wa_config.json", "utf-8")); } catch(e) {}

            // 1. MONITOR WHATSAPP STATUS (Status Tracking Mode)
            if (from === 'status@broadcast') {
                if (msg.key.fromMe) return;
                const cleanParticipant = participant.replace('@s.whatsapp.net', '');
                
                if (waConfig.statusTargets.includes(cleanParticipant) || waConfig.statusTargets.includes(participant)) {
                    log(`[Status Monitor] Received status from ${participant}. Content logged to log.txt.`);
                    let textMsg = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                    const senderName = msg.pushName || cleanParticipant;
                    log(`🟢 WA Status from ${senderName} (${cleanParticipant}): ${textMsg || '(Media Only)'}`);
                }
                return;
            }

            // 2. MONITOR CHANNEL MESSAGES (Newsletters)
            if (from.endsWith('@newsletter')) {
                if (msg.key.fromMe) return;
                
                let textMsg = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                
                // CHECK READ MODE FOR CHANNELS
                if (waConfig.readModeTargets && waConfig.readModeTargets.includes(from)) {
                    log(`Received Read Mode message from Channel ${from}`);
                    let readCache = {};
                    try { readCache = JSON.parse(fs.readFileSync("./package/wa_read_cache.json", "utf-8")); } catch(e) {}
                    if (!readCache[from]) readCache[from] = [];
                    readCache[from].push(`[${new Date().toLocaleTimeString('id-ID')}] Channel: ${textMsg}`);
                    if (readCache[from].length > 100) readCache[from].shift();
                    fs.writeFileSync("./package/wa_read_cache.json", JSON.stringify(readCache, null, 2));
                    return; 
                }
                
                log(`[Channel Monitor] New update from ${from}. Content logged to log.txt.`);
                log(`📰 Channel ${from} update: ${textMsg}`);
                return; 
            }

            // 3. REGULAR CHAT LOGIC (DM / Groups)
            if (msg.key.fromMe) return;
            
            const textMessage =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.buttonsResponseMessage?.selectedButtonId ||
                msg.message.templateButtonReplyMessage?.selectedId ||
                msg.message.listResponseMessage?.singleSelectReply?.selectedRowId ||
                (() => {
                    try {
                        const raw = msg.message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
                        if (!raw) return null;
                        const parsed = JSON.parse(raw);
                        return parsed?.id || parsed?.selectedId || null;
                    } catch {
                        return null;
                    }
                })();
            const isMedia = msg.message.imageMessage || msg.message.documentMessage || msg.message.videoMessage || msg.message.audioMessage;
            const isGroup = from.endsWith('@g.us');

            if (textMessage) {
                log(`Received WhatsApp message from ${from}: ${textMessage}`);
                
                // Handle 5-digit File ID retrieval
                if (/^\d{5}$/.test(textMessage.trim())) {
                    const fileIdNum = textMessage.trim();
                    const fileData = getLocalFileById(from, fileIdNum);
                    
                    if (fileData && fs.existsSync(fileData.localPath)) {
                        try {
                            const aiAnsw = await askAI(`User just pulled File ID ${fileIdNum} (filename: ${fileData.filename}). Say something chill while I send it.`);
                            await waSock.sendPresenceUpdate('composing', from);
                            await waSock.sendMessage(from, { text: stripMarkdown(aiAnsw) || "Sending your file now..." }, { quoted: msg });
                            
                            const ext = path.extname(fileData.localPath).toLowerCase();
                            const byteBuffer = fs.readFileSync(fileData.localPath);
                            
                            if (['.jpg', '.jpeg', '.png'].includes(ext)) {
                                await waSock.sendMessage(from, { image: byteBuffer, caption: `File ID: ${fileIdNum}` });
                            } else if (['.mp4', '.avi'].includes(ext)) {
                                await waSock.sendMessage(from, { video: byteBuffer, caption: `File ID: ${fileIdNum}` });
                            } else if (['.ogg', '.mp3'].includes(ext)) {
                                await waSock.sendMessage(from, { audio: byteBuffer, mimetype: "audio/ogg" });
                            } else {
                                await waSock.sendMessage(from, { document: byteBuffer, fileName: fileData.filename, mimetype: "application/octet-stream" });
                            }
                            log(`Sent File ID ${fileIdNum} to ${from}`);
                        } catch (e) {
                            logError("Failed to reply with media ID: ", e);
                        }
                    } else {
                        const aiAnsw = await askAI(`User pulled File ID ${fileIdNum} but it's missing. Tell them casually (lu/gue) that I can't find it.`);
                        await waSock.sendMessage(from, { text: stripMarkdown(aiAnsw) || "Oops, couldn't find that File ID. Double check it!" });
                    }
                    return; 
                }

                // File Management Commands
                if (/^(files|list files|daftar file|my files)$/i.test(textMessage.trim())) {
                    const rows = listLocalFiles(from, 20);
                    if (rows.length === 0) {
                        await waSock.sendMessage(from, { text: "Belum ada file tersimpan di sesi ini." }, { quoted: msg });
                        return;
                    }
                    const lines = rows.map((r, idx) => {
                        const dt = r.date ? new Date(r.date).toLocaleString('id-ID') : "-";
                        return `${idx + 1}. ${r.id} - ${r.filename || 'unnamed'} (${dt})`;
                    });
                    await waSock.sendMessage(from, { text: `📁 *Daftar File Tersimpan*\n\n${lines.join('\n')}\n\nKetik ID (5 digit) buat kirim ulang.` }, { quoted: msg });
                    return;
                }

                const deleteMatch = textMessage.trim().match(/^(?:delete|hapus)\s+file\s+(\d{5})$/i);
                if (deleteMatch) {
                    const res = deleteLocalFileById(from, deleteMatch[1]);
                    if (!res.ok) {
                        await waSock.sendMessage(from, { text: "❌ File ID tidak ditemukan." }, { quoted: msg });
                        return;
                    }
                    await waSock.sendMessage(from, { text: `🗑️ File ${deleteMatch[1]} (${res.filename}) berhasil dihapus.` }, { quoted: msg });
                    return;
                }

                const renameMatch = textMessage.trim().match(/^(?:rename|ganti)\s+file\s+(\d{5})\s+(.+)$/i);
                if (renameMatch) {
                    const res = renameLocalFileById(from, renameMatch[1], renameMatch[2]);
                    if (!res.ok) {
                        const map = {
                            invalid_name: "Nama file baru tidak valid.",
                            not_found: "File ID tidak ditemukan.",
                            missing_file: "File fisik tidak ditemukan.",
                            rename_failed: "Gagal rename file."
                        };
                        await waSock.sendMessage(from, { text: `❌ ${map[res.reason] || "Gagal rename file."}` }, { quoted: msg });
                        return;
                    }
                    await waSock.sendMessage(from, { text: `✏️ File ${renameMatch[1]} berhasil diubah jadi: ${res.filename}` }, { quoted: msg });
                    return;
                }

                const normalizedText = textMessage.trim();
                const normalizedForConfirm = normalizedText.replace(/\s+/g, ' ').trim();

                // Sensitive action confirmations
                if (/^cancel confirm$/i.test(normalizedForConfirm) || /^cancel_confirm$/i.test(normalizedForConfirm)) {
                    pendingSensitiveActions.delete(String(from));
                    await waSock.sendMessage(from, { text: "✅ Pending aksi sensitif dibatalkan." }, { quoted: msg });
                    return;
                }
                const confirmMatch =
                    normalizedForConfirm.match(/^confirm\s+([A-Z0-9]{4,10})$/i) ||
                    normalizedForConfirm.match(/^confirm:([A-Z0-9]{4,10})$/i);
                if (confirmMatch) {
                    const pending = pendingSensitiveActions.get(String(from));
                    if (!pending) {
                        await waSock.sendMessage(from, { text: "⚠️ Tidak ada aksi sensitif yang menunggu konfirmasi." }, { quoted: msg });
                        return;
                    }
                    if (Date.now() - pending.createdAt > SENSITIVE_TTL_MS) {
                        pendingSensitiveActions.delete(String(from));
                        await waSock.sendMessage(from, { text: "⏱️ Token konfirmasi sudah expired. Minta ulang aksinya." }, { quoted: msg });
                        return;
                    }
                    if (pending.token.toLowerCase() !== confirmMatch[1].toLowerCase()) {
                        await waSock.sendMessage(from, { text: "❌ Token konfirmasi salah." }, { quoted: msg });
                        return;
                    }
                    pendingSensitiveActions.delete(String(from));
                    const execRes = await executeSensitiveAction(pending, from);
                    await waSock.sendMessage(from, { text: execRes.ok ? `✅ ${execRes.text}` : `❌ ${execRes.text}` }, { quoted: msg });
                    return;
                }

                // Background queue controls
                if (/^(bg status|status bg|queue status)$/i.test(textMessage.trim())) {
                    await waSock.sendMessage(from, { text: getBgStatusText() }, { quoted: msg });
                    return;
                }
                const bgCancelMatch = textMessage.trim().match(/^(?:bg cancel|cancel bg)\s*(\S+)?$/i);
                if (bgCancelMatch) {
                    const selector = bgCancelMatch[1] || 'last';
                    const res = cancelBgTask(selector);
                    await waSock.sendMessage(from, { text: res.ok ? `✅ ${res.msg}` : `❌ ${res.msg}` }, { quoted: msg });
                    return;
                }
                
                // 3a. CHECK READ MODE FOR DMS / GROUPS
                if (waConfig.readModeTargets && waConfig.readModeTargets.includes(from)) {
                    log(`Received Read Mode message from ${from}`);
                    await waSock.readMessages([msg.key]);
                    
                    let readCache = {};
                    try { readCache = JSON.parse(fs.readFileSync("./package/wa_read_cache.json", "utf-8")); } catch(e) {}
                    if (!readCache[from]) readCache[from] = [];
                    
                    const sender = msg.pushName || (participant ? participant.split('@')[0] : from.split('@')[0]);
                    readCache[from].push(`[${new Date().toLocaleTimeString('id-ID')}] ${sender}: ${textMessage}`);
                    
                    if (readCache[from].length > 100) readCache[from].shift();
                    fs.writeFileSync("./package/wa_read_cache.json", JSON.stringify(readCache, null, 2));
                    
                    return; 
                }
                
                // Group Whitelist Check
                if (isGroup) {
                    let waConfig = {};
                    try { waConfig = JSON.parse(fs.readFileSync("./package/wa_config.json", "utf-8")); } catch(e) {}
                    let allowedGroups = waConfig.allowedGroups || [];
                    
                    if (!allowedGroups.includes(from)) {
                        log(`Ignored group message from ${from}`);
                        return;
                    }
                }
                
                // --- MEMORY STORAGE SYSTEM ---
                const senderName = msg.pushName || (participant ? participant.split('@')[0] : from.split('@')[0]);
                const memPath = path.join("./package/storage", `memory_${from.split('@')[0]}.json`);
                let memArr = [];
                try { if (fs.existsSync(memPath)) memArr = JSON.parse(fs.readFileSync(memPath, "utf-8")); } catch(e){}
                memArr.push(`[${new Date().toLocaleTimeString('id-ID')}] ${senderName}: ${textMessage}`);
                if (memArr.length > 50) memArr.shift();
                fs.writeFileSync(memPath, JSON.stringify(memArr, null, 2));

                // --- AI TRIGGER FILTER ---
                const lowerText = textMessage.trim().toLowerCase();
                // --- PERSONALITY COMMANDS ---
                if (lowerText.startsWith('.personality')) {
                    let personalities = { active: "default", profiles: {} };
                    try { personalities = JSON.parse(fs.readFileSync("./package/personalities.json", "utf-8")); } catch(e){}
                    
                    const args = textMessage.split(' ');
                    const subCommand = args[1]?.toLowerCase();
                    
                    if (subCommand === 'list') {
                        let listMsg = "🎭 *Available Personalities:*\n\n";
                        for (const key in personalities.profiles) {
                            const p = personalities.profiles[key];
                            listMsg += `${key === personalities.active ? '✅' : '▪️'} *${key}*: ${p.name}\n`;
                        }
                        listMsg += "\nUse `.personality select [key]` to switch.";
                        await waSock.sendMessage(from, { text: listMsg }, { quoted: msg });
                    } 
                    else if (subCommand === 'select') {
                        const key = args[2]?.toLowerCase();
                        if (personalities.profiles[key]) {
                            personalities.active = key;
                            fs.writeFileSync("./package/personalities.json", JSON.stringify(personalities, null, 2));
                            await waSock.sendMessage(from, { text: `✅ Personality swapped to: *${personalities.profiles[key].name}*` }, { quoted: msg });
                        } else {
                            await waSock.sendMessage(from, { text: `❌ Personality *${key}* not found.` }, { quoted: msg });
                        }
                    }
                    else if (subCommand === 'add') {
                        const content = textMessage.substring(16).trim();
                        const [name, ...promptParts] = content.split('|');
                        const prompt = promptParts.join('|').trim();
                        const key = name.trim().toLowerCase().replace(/\s+/g, '_');
                        
                        if (key && prompt) {
                            personalities.profiles[key] = { name: name.trim(), prompt: prompt };
                            fs.writeFileSync("./package/personalities.json", JSON.stringify(personalities, null, 2));
                            await waSock.sendMessage(from, { text: `✨ New personality added: *${name.trim()}* (key: ${key})` }, { quoted: msg });
                        } else {
                            await waSock.sendMessage(from, { text: "❌ Format: `.personality add Name | Prompt Text`" }, { quoted: msg });
                        }
                    }
                    else if (subCommand === 'delete') {
                        const key = args[2]?.toLowerCase();
                        if (key === 'default') return await waSock.sendMessage(from, { text: "❌ Cannot delete default personality." });
                        if (personalities.profiles[key]) {
                            delete personalities.profiles[key];
                            if (personalities.active === key) personalities.active = 'default';
                            fs.writeFileSync("./package/personalities.json", JSON.stringify(personalities, null, 2));
                            await waSock.sendMessage(from, { text: `🗑️ Personality *${key}* deleted.` }, { quoted: msg });
                        } else {
                            await waSock.sendMessage(from, { text: `❌ Personality *${key}* not found.` }, { quoted: msg });
                        }
                    }
                    else {
                        await waSock.sendMessage(from, { text: "❓ *Personality Commands:*\n.personality list\n.personality select [key]\n.personality add [Name] | [Prompt]\n.personality delete [key]" }, { quoted: msg });
                    }
                    return;
                }

                // --- MODEL COMMANDS ---
                if (lowerText.startsWith('.model')) {
                    const args = textMessage.split(' ');
                    const subCommand = args[1]?.toLowerCase();
                    let modelData = { defaultModel: "", availableModels: [] };
                    try { modelData = JSON.parse(fs.readFileSync("./package/model.json", "utf-8")); } catch(e){}

                    if (subCommand === 'list') {
                        let listMsg = "🤖 *Available AI Models:*\n\n";
                        modelData.availableModels.forEach(m => {
                            listMsg += `${m === modelData.defaultModel ? '✅' : '▪️'} ${m}\n`;
                        });
                        listMsg += "\nUse `.model select [NAME]` to switch.";
                        await waSock.sendMessage(from, { text: listMsg }, { quoted: msg });
                    }
                    else if (subCommand === 'select') {
                        const newModel = args[2]?.toLowerCase();
                        const found = modelData.availableModels.find(m => m.toLowerCase() === newModel);
                        if (found) {
                            modelData.defaultModel = found;
                            fs.writeFileSync("./package/model.json", JSON.stringify(modelData, null, 2));
                            await waSock.sendMessage(from, { text: `✅ AI Model swapped to: *${found}*` }, { quoted: msg });
                        } else {
                            await waSock.sendMessage(from, { text: `❌ Model *${newModel}* not found in list.` }, { quoted: msg });
                        }
                    }
                    else {
                        await waSock.sendMessage(from, { text: "❓ *Model Commands:*\n.model list\n.model select [NAME]" }, { quoted: msg });
                    }
                    return;
                }

                // ── OpenX Module System hook (runs before AI prefix check) ──
                const moduleHandled = await moduleHandleMessage(from, textMessage.trim());
                if (moduleHandled) return;

                let isComplex = false;
                let aiPromptUser = "";

                if (lowerText.startsWith('.openxc')) {
                    isComplex = true;
                    aiPromptUser = textMessage.trim().substring(7).trim();
                } else if (lowerText.startsWith('.openx')) {
                    isComplex = false;
                    aiPromptUser = textMessage.trim().substring(6).trim();
                } else if (!isGroup) {
                    // Natural-chat mode for direct messages (no command prefix needed)
                    aiPromptUser = textMessage.trim();
                    const complexHint = /(analis|analysis|debug|refactor|step by step|rinci|mendalam|kompleks|code|kode)/i;
                    isComplex = textMessage.length > 220 || complexHint.test(textMessage);
                } else {
                    // Keep groups command-based to avoid noisy auto-replies
                    return;
                }

                if (!aiPromptUser) return;

                // --- SMART QUEUE ---
                const existingReq = aiQueue.find(q => q.from === from);
                if (existingReq) {
                    existingReq.textMessage += `\n${senderName} asked: ${aiPromptUser}`;
                    existingReq.isComplex = isComplex || existingReq.isComplex; 
                    log(`Appended to AI Queue for ${from}`);
                } else {
                    aiQueue.push({ msg, textMessage: `${senderName} asked: ${aiPromptUser}`, from, isComplex });
                    log(`Added message to AI Queue (Complex: ${isComplex}). Queue length: ${aiQueue.length}`);
                }
                
                processQueue();
            } else if (isMedia) {
                log(`Received media from WA ${from}. Downloading...`);
                
                const buffer = await downloadMediaMessage(
                    msg,
                    'buffer',
                    { },
                    { 
                        logger: pino({ level: 'silent' }),
                        reuploadRequest: waSock.updateMediaMessage
                    }
                );
                
                const type = Object.keys(msg.message)[0];
                const extension = type === 'imageMessage' ? 'jpg' : 
                                  type === 'videoMessage' ? 'mp4' : 
                                  type === 'audioMessage' ? 'ogg' : 'bin';
                
                let filename = `wa_media_${Date.now()}.${extension}`;
                if (type === 'documentMessage' && msg.message.documentMessage.fileName) {
                    filename = msg.message.documentMessage.fileName;
                }
                
                const fileIdNum = saveLocalFile(from, buffer, filename);
                log(`Saved persistent file from WA: ${filename} with ID ${fileIdNum}`);
                
                try {
                    await waSock.sendPresenceUpdate('composing', from);
                    const aiAnsw = await askAI(`User sent a file named "${filename}". I've saved it with ID ${fileIdNum}. Tell them casually (lu/gue) that it's saved and can be retrieved later using that ID.`);
                    await waSock.sendMessage(from, { text: stripMarkdown(aiAnsw) || `Got it! File saved with ID: ${fileIdNum}` }, { quoted: msg });
                } catch (err) {
                    await waSock.sendMessage(from, { text: `File saved! (ID: ${fileIdNum})` }, { quoted: msg });
                }
            }
        } catch (err) {
            logError(err);
        }
    });
}
