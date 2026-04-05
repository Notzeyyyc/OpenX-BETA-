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
import { getDeviceInfo, getAppList, takeScreenshot, sendNotification, getHealthStatus } from './package/adb_helper.js';
import { downloadMedia } from './package/downloader.js';

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
    
    // Load persisted memory/info from storage
    let storageContext = "";
    try {
        const storageDir = "./package/storage";
        if (fs.existsSync(storageDir)) {
            const files = fs.readdirSync(storageDir);
            for (const file of files) {
                const filePath = path.join(storageDir, file);
                if (fs.statSync(filePath).isFile()) {
                    storageContext += `\n[Info/Memory from ${file}]:\n${fs.readFileSync(filePath, "utf-8")}\n`;
                }
            }
        }
    } catch(e) {}
    
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
3. Untuk screenshot layar: sertakan [ADB_SCREENSHOT].
4. Untuk kirim notifikasi ke HP: sertakan [ADB_NOTIFY|Judul|Pesan].
5. Untuk cek kesehatan HP (baterai, suhu, dll): sertakan [ADB_HEALTH].
6. Untuk chat ke orang lain di WhatsApp: sertakan [WA_SEND|nomor_atau_jid|pesan_ai]. Pastikan nomor pake format internasional (628...).
7. Untuk log server: sertakan [SERVER_GET_LOG].
8. Untuk restart server: sertakan [SERVER_RESTART].
9. Untuk info perangkat/aplikasi: sertakan [NEEDS_ADB_INFO] biar gue bisa kasih data real.
10. Untuk download video/foto/audio sosmed (TikTok, IG, YT, dll): sertakan [DOWNLOAD_MEDIA|URL].

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

    // ADB Command Loop (Max 3 retries)
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
            messages.push({ role: "user", content: `(System) ADB Results:\n${totalOutput}\nRespond naturally or continue commands if needed.` });
            aiResult = await chatCompletion(messages, getCurrentModel(), isComplex);
            if (!aiResult) aiResult = "";
        }
    }
    aiResult = aiResult.replace(adbCmdRegex, '');
    
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
            setTimeout(() => {
                process.exit(1);
            }, 2000);
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
    while ((waMatch = waSendRegex.exec(aiResult)) !== null) {
        if (waSock) {
            let target = waMatch[1].trim();
            const text = waMatch[2].trim();
            if (!target.includes('@')) target = target + '@s.whatsapp.net';
            waSock.sendMessage(target, { text }).catch(() => {});
        }
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

export let waSock = null;

// AI Message Queue System
const aiQueue = [];
let isProcessingQueue = false;

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

            // 1. MONITOR WHATSAPP STATUS (Status Tracking Mode)
            if (from === 'status@broadcast') {
                if (msg.key.fromMe) return;
                const cleanParticipant = participant.replace('@s.whatsapp.net', '');
                
                if (waConfig.statusTargets.includes(cleanParticipant) || waConfig.statusTargets.includes(participant)) {
                    log(`Received monitored status from ${participant}`);
                    if (!bot || !devId) return;

                    let textMsg = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                    const isMediaMsg = msg.message.imageMessage || msg.message.videoMessage;
                    let senderName = msg.pushName || cleanParticipant;
                    let cap = `🟢 *Monitored WA Status*\nFrom: ${senderName} (\`${cleanParticipant}\`)`;
                    if (textMsg) cap += `\n\nContent: ${textMsg}`;

                    if (isMediaMsg) {
                        try {
                            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: waSock.updateMediaMessage });
                            if (msg.message.imageMessage) {
                                await bot.sendPhoto(devId, buffer, { caption: cap, parse_mode: 'Markdown' });
                            } else if (msg.message.videoMessage) {
                                await bot.sendVideo(devId, buffer, { caption: cap, parse_mode: 'Markdown' });
                            }
                        } catch (e) {
                            bot.sendMessage(devId, cap + `\n\n_(Failed to download status media)_`, { parse_mode: 'Markdown' });
                        }
                    } else {
                        bot.sendMessage(devId, cap, { parse_mode: 'Markdown' });
                    }
                }
                return;
            }

            // 2. MONITOR CHANNEL MESSAGES (Newsletters) & ADD AI OPINION
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
                    return; // Collecting only, don't forward
                }
                
                if (bot && devId) {
                    let aiOpinion = "No text content found.";
                    if (textMsg) {
                        try {
                            const opinionContext = `Provide a critical, sharp, or funny comment (1-2 sentences) about this news/info:\n"${textMsg}"`;
                            aiOpinion = await askAI(opinionContext);
                        } catch(e) {}
                    }
                    
                    let forwardFormat = `📰 *WhatsApp Channel Update*\nChannel ID: \`${from}\``;
                    if (textMsg) forwardFormat += `\n\n*Original Content:*\n${textMsg}`;
                    forwardFormat += `\n\n🤖 *OpenX AI Comment:*\n🗣 _${stripMarkdown(aiOpinion)}_`;
                    
                    bot.sendMessage(devId, forwardFormat, { parse_mode: "Markdown" });
                }
                return; // End channel logic
            }

            // 3. REGULAR CHAT LOGIC (DM / Groups)
            if (msg.key.fromMe) return;
            
            const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;
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
                    return; // End file retrieval
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
                    
                    return; // Don't reply via AI
                }
                
                // Forward DM messages to Telegram
                if (!isGroup && bot && devId) {
                    const senderName = msg.pushName;
                    let telegramMsg = `📩 *From WhatsApp*\nID: \`${from}\``;
                    
                    if (senderName) {
                        telegramMsg += `\nName: ${senderName}`;
                    } else {
                        telegramMsg += `\nName: _(No Name)_`;
                    }
                    telegramMsg += `\n\nMessage: ${textMessage}`;
                    
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
                
                // Group Whitelist Check
                if (isGroup) {
                    let waConfig = {};
                    try { waConfig = JSON.parse(fs.readFileSync("./package/wa_config.json", "utf-8")); } catch(e) {}
                    let allowedGroups = waConfig.allowedGroups || [];
                    
                    // Auto-whitelist specific group ID if needed
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
                const senderName = msg.pushName || (participant ? participant.split('@')[0] : from.split('@')[0]);
                const memPath = path.join("./package/storage", `memory_${from.split('@')[0]}.json`);
                let memArr = [];
                try { if (fs.existsSync(memPath)) memArr = JSON.parse(fs.readFileSync(memPath, "utf-8")); } catch(e){}
                memArr.push(`[${new Date().toLocaleTimeString('id-ID')}] ${senderName}: ${textMessage}`);
                if (memArr.length > 50) memArr.shift();
                fs.writeFileSync(memPath, JSON.stringify(memArr, null, 2));

                // --- AI TRIGGER FILTER (.openx / .openxc) ---
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
                        // Format: .personality add name | prompt
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

                let isComplex = false;
                let aiPromptUser = "";

                if (lowerText.startsWith('.openxc')) {
                    isComplex = true;
                    aiPromptUser = textMessage.trim().substring(7).trim();
                } else if (lowerText.startsWith('.openx')) {
                    isComplex = false;
                    aiPromptUser = textMessage.trim().substring(6).trim();
                } else {
                    // Normal chat just goes to memory
                    return;
                }

                // --- SMART QUEUE (Batched by sender/group) ---
                const existingReq = aiQueue.find(q => q.from === from);
                if (existingReq) {
                    existingReq.textMessage += `\n${senderName} asked: ${aiPromptUser}`;
                    existingReq.isComplex = isComplex || existingReq.isComplex; // If any part is complex, the whole response is
                    log(`Appended to AI Queue for ${from}`);
                } else {
                    aiQueue.push({ msg, textMessage: `${senderName} asked: ${aiPromptUser}`, from, isComplex });
                    log(`Added message to AI Queue (Complex: ${isComplex}). Queue length: ${aiQueue.length}`);
                }
                
                // Start queue processing if idle
                processQueue();
            } else if (isMedia) {
                log(`Received media from WA ${from}. Downloading...`);
                
                // --- Store Media Event in Memory ---
                if (isGroup) {
                    let waConfig = {};
                    try { waConfig = JSON.parse(fs.readFileSync("./package/wa_config.json", "utf-8")); } catch(e) {}
                    let allowedGroups = waConfig.allowedGroups || [];
                    if (allowedGroups.includes(from)) {
                        const type = Object.keys(msg.message)[0];
                        const senderName = msg.pushName || (participant ? participant.split('@')[0] : from.split('@')[0]);
                        const memPath = path.join("./package/storage", `memory_${from.split('@')[0]}.json`);
                        let memArr = [];
                        try { if (fs.existsSync(memPath)) memArr = JSON.parse(fs.readFileSync(memPath, "utf-8")); } catch(e){}
                        memArr.push(`[${new Date().toLocaleTimeString('id-ID')}] ${senderName} sent media (${type})`);
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
                
                // Save locally in caches/files/
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
