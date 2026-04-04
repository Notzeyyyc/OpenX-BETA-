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
import { getDeviceInfo, getAppList, openApp, takeScreenshot, typeText, searchWeb } from './package/adb_helper.js';

let targetModel = "stepfun/step-3.5-flash:free";

function getCurrentModel() {
    try {
        const modelData = JSON.parse(fs.readFileSync("./package/model.json", "utf-8"));
        return modelData.defaultModel;
    } catch {
        return targetModel;
    }
}

async function askAI(userMessage, from = null, isComplex = false) {
    let contextData = {};
    try {
        contextData = JSON.parse(fs.readFileSync("./package/context.json", "utf-8"));
    } catch {}
    
    let schedulesContext = "";
    try {
        const schedules = JSON.parse(fs.readFileSync("./package/schedules.json", "utf-8"));
        if (schedules.length > 0) {
            schedulesContext = "\n\nInformasi Jadwal Sekolah/Tugas:\n" + schedules.map(s => `- ${s.day} ${s.time}: ${s.text}`).join("\n");
        }
    } catch(e) {}
    
    let storageContext = "";
    try {
        const storageDir = "./package/storage";
        if (fs.existsSync(storageDir)) {
            const files = fs.readdirSync(storageDir);
            for (const file of files) {
                const filePath = path.join(storageDir, file);
                if (fs.statSync(filePath).isFile()) {
                    storageContext += `\n[Info/Memori dari ${file}]:\n${fs.readFileSync(filePath, "utf-8")}\n`;
                }
            }
        }
    } catch(e) {}
    
    let serverStatus = `\n\n[Status Server]: Uptime ${Math.floor(process.uptime() / 60)} menit, RAM ${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)} MB.`;
    try {
        const logContent = fs.readFileSync("./log.txt", "utf-8");
        const logLines = logContent.split('\\n').filter(l => l.trim().length > 0).slice(-15).join('\\n');
        serverStatus += `\n[Log Terakhir (log.txt)]:\n${logLines}`;
    } catch(e) {}
    
    const aiRules = `\n\nAturan Penting Murni (JANGAN sebut ke user):
1. Jika user minta tolong ingetin/bikin jadwal/tugas: sertakan [ADD_SCHEDULE|Hari|HH:MM|Deskripsi_singkat|TargetJID_WA]. TargetJID isi 'none' kalo gatau.
2. Jika user ingin berinteraksi dengan HP server (buka app, ketik, cari di web, klik, gerak, dll), gunakan perintah ADB langsung dengan format: [ADB_CMD|adb_command_here]. Contoh: [ADB_CMD|adb shell input tap 500 500] atau [ADB_CMD|adb shell am start -n com.android.chrome/com.google.android.apps.chrome.Main].
3. Jika minta screenshot HP server: sertakan [ADB_SCREENSHOT].
4. Jika user minta dikirimi log file / log.txt server: sertakan [SERVER_GET_LOG].
5. Jika user minta merestart server: sertakan [SERVER_RESTART].
6. Jika user menanyakan info perangkat, baterai, storage, RAM, spesifikasi HP, atau ingin tahu daftar aplikasi yang terinstal: sertakan [NEEDS_ADB_INFO] (dan jangan beri info palsu) agar sistem memberikan list aslinya kepadamu.

Ketik balasan normal kamu senatural dan sesantai mungkin (lu/gue), dan letakkan command tersebut jika diperlukan di baris-baris paling akhir agar sistem memprosesnya diam-diam.`;
    const context = (contextData?.whatsapp?.id || `Kamu adalah OPENX, asisten AI untuk pelajar. Wajib pakai bahasa gaul, santai abis, dan kekinian (pake lu/gue, asik kayak temen nongkrong). Saat ini kamu menjawab pesan via WhatsApp.`) + schedulesContext + storageContext + serverStatus + aiRules;
    
    let messages = [
        { role: "system", content: context },
        { role: "user", content: userMessage }
    ];
    
    let aiResult = await chatCompletion(messages, getCurrentModel(), isComplex);
    
    if (aiResult.includes("[NEEDS_ADB_INFO]")) {
        try {
            const di = await getDeviceInfo();
            const al = await getAppList();
            messages.push({ role: "assistant", content: aiResult });
            messages.push({ role: "user", content: `(Sistem) Berikut informasi perangkat dan aplikasi asli:\n${di}\n${al}\nBerdasarkan data di atas, silakan lanjutkan / penuhi permintaan awal user.` });
            aiResult = await chatCompletion(messages, getCurrentModel(), isComplex);
        } catch(e) {}
        aiResult = aiResult.replace(/\[NEEDS_ADB_INFO\]/g, "");
    }

    // Parse Direct ADB Commands with Result Feedback Loop (up to 3 times to prevent infinite loops)
    let loopCount = 0;
    const adbCmdRegex = /\[ADB_CMD\|(.*?)\]/g;
    while (adbCmdRegex.test(aiResult) && loopCount < 3) {
        loopCount++;
        let match;
        const commands = [];
        adbCmdRegex.lastIndex = 0;
        while ((match = adbCmdRegex.exec(aiResult)) !== null) {
            commands.push(match[1].trim());
        }

        let totalOutput = "";
        for (const cmd of commands) {
            try {
                const { stdout, stderr } = await execPromise(cmd);
                totalOutput += `[Command: ${cmd}]\nOutput:\n${stdout || "No Output"}\n${stderr ? "Error:\n" + stderr : ""}\n---\n`;
            } catch (err) {
                totalOutput += `[Command: ${cmd}]\nFailed: ${err.message}\n---\n`;
            }
        }

        if (totalOutput) {
            messages.push({ role: "assistant", content: aiResult });
            messages.push({ role: "user", content: `(Sistem) Hasil eksekusi ADB:\n${totalOutput}\nBerdasarkan hasil di atas, berikan respon final yang santai atau lanjutkan perintah jika diperlukan.` });
            aiResult = await chatCompletion(messages, getCurrentModel(), isComplex);
        }
    }
    aiResult = aiResult.replace(adbCmdRegex, '');
    
    // Parse Interaktif Setup Jadwal
    const regex = /\[ADD_SCHEDULE\|(.*?)\|(.*?)\|(.*?)\|(.*?)\]/g;
    let match;
    while ((match = regex.exec(aiResult)) !== null) {
        try {
            let dayStr = match[1].trim().toLowerCase();
            const timeStr = match[2].trim();
            const desc = match[3].trim();
            const targetWa = match[4].trim() === "none" ? null : match[4].trim();
            
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

    const restartRegex = /\[SERVER_RESTART\]/g;
    if (restartRegex.test(aiResult)) {
        if (from && waSock) {
            setTimeout(() => {
                process.exit(1);
            }, 2000);
        }
        aiResult = aiResult.replace(restartRegex, '');
    }
    
    return aiResult.trim();
}

function stripMarkdown(text) {
    if (!text) return text;
    return text
        .replace(/\*\*/g, '')
        .replace(/\*/g, '')
        .replace(/__/g, '')
        .replace(/_/g, '')
        .replace(/`/g, '')
        .replace(/\[\]/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/#{1,6}\s/g, '')
        .replace(/\n\s*\n/g, '\n\n')
        .trim();
}

function generateFileId() {
    return Math.floor(10000 + Math.random() * 90000).toString();
}

function ensureUserDir(chatId) {
    const cleanId = String(chatId).split('@')[0];
    const dir = path.join("./caches/files", cleanId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

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

export let waSock = null;

// Sistem Antrean (Queue) AI
const aiQueue = [];
let isProcessingQueue = false;

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
            const cleanResponse = stripMarkdown(aiResponse) || 'Maaf, terjadi kesalahan saat memproses pesan.';
            
            await waSock.sendPresenceUpdate('paused', from);
            await waSock.sendMessage(from, { text: cleanResponse }, { quoted: msg });
            log(`Successfully replied to WA message ${from}`);
        } catch (err) {
            logError(err);
            await waSock.sendMessage(from, { text: 'Terjadi kesalahan sistem, coba lagi.' }, { quoted: msg });
        }
        
        // Jeda antar request (delay 18 detik) untuk menghindari Rate Limit OpenRouter
        await new Promise(resolve => setTimeout(resolve, 18000));
    }
    isProcessingQueue = false;
}

export async function connectToWhatsApp(bot, devId) {
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

            // 1. TANGKAP STATUS WHATSAPP (Mode Pemantauan)
            if (from === 'status@broadcast') {
                if (msg.key.fromMe) return;
                const cleanParticipant = participant.replace('@s.whatsapp.net', '');
                
                if (waConfig.statusTargets.includes(cleanParticipant) || waConfig.statusTargets.includes(participant)) {
                    log(`Received monitored status from ${participant}`);
                    if (!bot || !devId) return;

                    let textMsg = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                    const isMediaMsg = msg.message.imageMessage || msg.message.videoMessage;
                    let senderName = msg.pushName || cleanParticipant;
                    let cap = `🟢 *Status WA Terpantau*\nDari: ${senderName} (\`${cleanParticipant}\`)`;
                    if (textMsg) cap += `\n\nIsi: ${textMsg}`;

                    if (isMediaMsg) {
                        try {
                            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: waSock.updateMediaMessage });
                            if (msg.message.imageMessage) {
                                await bot.sendPhoto(devId, buffer, { caption: cap, parse_mode: 'Markdown' });
                            } else if (msg.message.videoMessage) {
                                await bot.sendVideo(devId, buffer, { caption: cap, parse_mode: 'Markdown' });
                            }
                        } catch (e) {
                            bot.sendMessage(devId, cap + `\n\n_(Gagal mendownload media status)_`, { parse_mode: 'Markdown' });
                        }
                    } else {
                        bot.sendMessage(devId, cap, { parse_mode: 'Markdown' });
                    }
                }
                return;
            }

            // 2. TANGKAP PESAN DARI CHANNEL (Newsletter) LAIN & KOMENTARI
            if (from.endsWith('@newsletter')) {
                if (msg.key.fromMe) return;
                
                let textMsg = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                
                // CEK READ MODE PADA CHANNEL
                if (waConfig.readModeTargets && waConfig.readModeTargets.includes(from)) {
                    log(`Received Read Mode message from Channel ${from}`);
                    let readCache = {};
                    try { readCache = JSON.parse(fs.readFileSync("./package/wa_read_cache.json", "utf-8")); } catch(e) {}
                    if (!readCache[from]) readCache[from] = [];
                    readCache[from].push(`[${new Date().toLocaleTimeString('id-ID')}] Channel: ${textMsg}`);
                    if (readCache[from].length > 100) readCache[from].shift();
                    fs.writeFileSync("./package/wa_read_cache.json", JSON.stringify(readCache, null, 2));
                    return; // Stop here, collect to cache
                }
                
                if (bot && devId) {
                    let aiOpinion = "Tidak ada referensi konten berbentuk Teks.";
                    if (textMsg) {
                        try {
                            const opinionContext = `Tolong berikan respons berupa komentar kritis, tajam, atau lucu (singkat 1-2 kalimat saja) mengenai informasi/berita berikut ini:\n"${textMsg}"`;
                            aiOpinion = await askAI(opinionContext);
                        } catch(e) {}
                    }
                    
                    let forwardFormat = `📰 *Update WhatsApp Channel*\nID Channel: \`${from}\``;
                    if (textMsg) forwardFormat += `\n\n*Konten Asli:*\n${textMsg}`;
                    forwardFormat += `\n\n🤖 *Komentar AI OpenX:*\n🗣 _${stripMarkdown(aiOpinion)}_`;
                    
                    bot.sendMessage(devId, forwardFormat, { parse_mode: "Markdown" });
                }
                return; // Jangan lanjutkan ke logika chat pribadi
            }

            // 3. LOGIKA CHAT BIASA (PM / Grup)
            if (msg.key.fromMe) return;
            
            // Handle regular text message
            const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;
            
            // Handle media (image/document)
            const isMedia = msg.message.imageMessage || msg.message.documentMessage || msg.message.videoMessage || msg.message.audioMessage;
            
            const isGroup = from.endsWith('@g.us');

            if (textMessage) {
                log(`Received WhatsApp message from ${from}: ${textMessage}`);
                
                // Cek tarikan File ID (5 digit angka murni)
                if (/^\d{5}$/.test(textMessage.trim())) {
                    const fileIdNum = textMessage.trim();
                    const fileData = getLocalFileById(from, fileIdNum);
                    
                    if (fileData && fs.existsSync(fileData.localPath)) {
                        try {
                            const aiAnsw = await askAI(`User WhatsApp barusan narik file ID ${fileIdNum} (nama file: ${fileData.filename}). Reply asik/chill kalo file-nya lagi lu kirimin sekarang.`);
                            await waSock.sendPresenceUpdate('composing', from);
                            await waSock.sendMessage(from, { text: stripMarkdown(aiAnsw) || "Otw gue kirim filenya cuy..." }, { quoted: msg });
                            
                            const ext = path.extname(fileData.localPath).toLowerCase();
                            const b = fs.readFileSync(fileData.localPath);
                            
                            if (['.jpg', '.jpeg', '.png'].includes(ext)) {
                                await waSock.sendMessage(from, { image: b, caption: `File ID: ${fileIdNum}` });
                            } else if (['.mp4', '.avi'].includes(ext)) {
                                await waSock.sendMessage(from, { video: b, caption: `File ID: ${fileIdNum}` });
                            } else if (['.ogg', '.mp3'].includes(ext)) {
                                await waSock.sendMessage(from, { audio: b, mimetype: "audio/ogg" });
                            } else {
                                await waSock.sendMessage(from, { document: b, fileName: fileData.filename, mimetype: "application/octet-stream" });
                            }
                            log(`Berhasil mengirim file ID ${fileIdNum} ke ${from}`);
                        } catch (e) {
                            logError("Gagal membalas media ID: ", e);
                        }
                    } else {
                        const aiAnsw = await askAI(`User WhatsApp narik file ID ${fileIdNum} tapi filenya ga ketemu atau ga ada. Kasih tau lu ga nemu filenya pake bahasa santai lu/gue.`);
                        await waSock.sendMessage(from, { text: stripMarkdown(aiAnsw) || "Waduh, gue cari-cari file ID itu ga ketemu cuy. Coba cek lagi bener gaknya." });
                    }
                    return; // Selesai ngurus file
                }
                
                // 3a. CEK READ MODE PADA PM / GRUP / TARGET APAPUN
                if (waConfig.readModeTargets && waConfig.readModeTargets.includes(from)) {
                    log(`Received Read Mode message from ${from}`);
                    await waSock.readMessages([msg.key]);
                    
                    let readCache = {};
                    try { readCache = JSON.parse(fs.readFileSync("./package/wa_read_cache.json", "utf-8")); } catch(e) {}
                    if (!readCache[from]) readCache[from] = [];
                    
                    const sender = msg.pushName || (participant ? participant.split('@')[0] : from.split('@')[0]);
                    readCache[from].push(`[${new Date().toLocaleTimeString('id-ID')}] ${sender}: ${textMessage}`);
                    
                    if (readCache[from].length > 100) readCache[from].shift(); // Limit 100 recent
                    fs.writeFileSync("./package/wa_read_cache.json", JSON.stringify(readCache, null, 2));
                    
                    return; // Jangan dibalas oleh bot Telegram/AI
                }
                
                // Forward ke Telegram jika dari PM
                if (!isGroup && bot && devId) {
                    const senderName = msg.pushName;
                    let telegramMsg = `📩 *Dari WhatsApp*\nID: \`${from}\``;
                    
                    if (senderName) {
                        telegramMsg += `\nNama: ${senderName}`;
                    } else {
                        telegramMsg += `\nNama: _(Tanpa Nama)_`;
                    }
                    telegramMsg += `\n\nPesan: ${textMessage}`;
                    
                    let picSent = false;
                    if (!senderName) {
                        try {
                            const ppUrl = await waSock.profilePictureUrl(from, 'image').catch(() => null);
                            if (ppUrl) {
                                await bot.sendPhoto(devId, ppUrl, { caption: telegramMsg, parse_mode: "Markdown" });
                                picSent = true;
                            }
                        } catch (e) { }
                    }
                    
                    if (!picSent) {
                        bot.sendMessage(devId, telegramMsg, { parse_mode: "Markdown" });
                    }
                }
                
                // Hentikan proses AI untuk grup yang tidak ada di whitelist
                if (isGroup) {
                    let waConfig = {};
                    try { waConfig = JSON.parse(fs.readFileSync("./package/wa_config.json", "utf-8")); } catch(e) {}
                    let allowedGroups = waConfig.allowedGroups || [];
                    
                    // Otomatis masukkan grup jika diminta user via hardcode atau config
                    const TARGET_GROUP = "120363402992623966@g.us";
                    if (!allowedGroups.includes(TARGET_GROUP)) {
                        allowedGroups.push(TARGET_GROUP);
                        waConfig.allowedGroups = allowedGroups;
                        fs.writeFileSync("./package/wa_config.json", JSON.stringify(waConfig, null, 2));
                    }
                    
                    if (!allowedGroups.includes(from)) {
                        log(`Ignored group message from ${from}`);
                        return;
                    }
                }
                
                // --- MEMORY STORAGE SYSTEM ---
                const senderName = msg.pushName || (msg.key.participant ? msg.key.participant.split('@')[0] : from.split('@')[0]);
                const memPath = path.join("./package/storage", `memory_${from.split('@')[0]}.json`);
                let memArr = [];
                try { if (fs.existsSync(memPath)) memArr = JSON.parse(fs.readFileSync(memPath, "utf-8")); } catch(e){}
                memArr.push(`[${new Date().toLocaleTimeString('id-ID')}] ${senderName}: ${textMessage}`);
                if (memArr.length > 50) memArr.shift(); // keep 50 latest 
                fs.writeFileSync(memPath, JSON.stringify(memArr, null, 2));

                // --- FILTER PREFIX .openx / .openxc ---
                const lowerText = textMessage.trim().toLowerCase();
                let isComplex = false;
                let aiPromptUser = "";

                if (lowerText.startsWith('.openxc')) {
                    isComplex = true;
                    aiPromptUser = textMessage.trim().substring(7).trim();
                } else if (lowerText.startsWith('.openx')) {
                    isComplex = false;
                    aiPromptUser = textMessage.trim().substring(6).trim();
                } else {
                    // Chat biasa hanya masuk memori, tidak di-reply AI
                    return;
                }

                // --- SMART QUEUE (Batched by sender/group) ---
                const existingReq = aiQueue.find(q => q.from === from);
                if (existingReq) {
                    existingReq.textMessage += `\\n${senderName} nanya: ${aiPromptUser}`;
                    existingReq.isComplex = isComplex || existingReq.isComplex; // Jika salah satu kompleks, maka kompleks
                    log(`Appended to AI Queue for ${from}`);
                } else {
                    aiQueue.push({ msg, textMessage: `${senderName} nanya: ${aiPromptUser}`, from, isComplex });
                    log(`Added message to AI Queue (Complex: ${isComplex}). Queue length: ${aiQueue.length}`);
                }
                
                // Jalankan queue jika sedang idle
                processQueue();
            } else if (isMedia) {
                log(`Received media from WA ${from}. Attempting download...`);
                
                // --- Save Media Info to Memory ---
                if (isGroup) {
                    let waConfig = {};
                    try { waConfig = JSON.parse(fs.readFileSync("./package/wa_config.json", "utf-8")); } catch(e) {}
                    let allowedGroups = waConfig.allowedGroups || [];
                    if (allowedGroups.includes(from)) {
                        const type = Object.keys(msg.message)[0];
                        const senderName = msg.pushName || (msg.key.participant ? msg.key.participant.split('@')[0] : from.split('@')[0]);
                        const memPath = path.join("./package/storage", `memory_${from.split('@')[0]}.json`);
                        let memArr = [];
                        try { if (fs.existsSync(memPath)) memArr = JSON.parse(fs.readFileSync(memPath, "utf-8")); } catch(e){}
                        memArr.push(`[${new Date().toLocaleTimeString('id-ID')}] ${senderName} mengirim media (${type})`);
                        if (memArr.length > 50) memArr.shift(); 
                        fs.writeFileSync(memPath, JSON.stringify(memArr, null, 2));
                    }
                }
                
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
                
                // Simpan secara lokal sesuai struktur `caches/files/`
                const fileIdNum = saveLocalFile(from, buffer, filename);
                log(`Successfully saved persistent file from WA: ${filename} with ID ${fileIdNum}`);
                
                try {
                    await waSock.sendPresenceUpdate('composing', from);
                    const aiAnsw = await askAI(`User ngirim gambar/dokumen bernama "${filename}". Filenya udah sukses gue save pake ID ${fileIdNum}. Beritahu dia dengan bahasa santai lu/gue kalo file udah disimpen dan kapan-kapan bisa ditarik lagi pake ID itu.`);
                    await waSock.sendMessage(from, { text: stripMarkdown(aiAnsw) || `Sip, file udah disimpen di server. ID-nya: ${fileIdNum}` }, { quoted: msg });
                } catch (err) {
                    await waSock.sendMessage(from, { text: `File tersimpan! (ID: ${fileIdNum})` }, { quoted: msg });
                }
            }
        } catch (err) {
            logError(err);
        }
    });
}
