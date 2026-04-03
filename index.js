import TelegramBot from "node-telegram-bot-api";
import { config } from "./config.js";
import fs from "fs";
import path from "path";
import { chatCompletion } from "./package/openx/openrouter.js";
import { log, error as logError } from "./logger.js";
import { connectToWhatsApp, waSock } from "./whatsapp.js";
import cron from "node-cron";

const bot = new TelegramBot(config.telegram.token, { polling: true });
const USER_LANGS = new Map();

const MESSAGES = {
    id: {
        welcome: (name, model) => `Halo ${name}! Saya OPENX, asisten AI untuk pelajar Indonesia (OpenClaw version).\n\nModel: ${model}\n\nKirim pesan apa saja untuk mulai berbicara dengan saya. Anda juga bisa mengirim file/gambar dan saya akan membantu menyimpannya.`,
        accessDenied: "AKSES DITOLAK\n\nKamu tidak memiliki izin untuk menggunakan bot ini.",
        thinking: "...",
        error: "Maaf, terjadi kesalahan. Silakan coba lagi.",
        fileSaved: (id) => `File berhasil disimpan dengan ID: ${id}`,
        fileNotFound: "File dengan ID tersebut tidak ditemukan.",
        modelChanged: (model) => `Model diubah ke: ${model}`,
        langChanged: "Bahasa diubah ke Indonesia",
        profileTitle: "Profil Pengguna",
        profileName: "Nama",
        profileId: "ID",
        profileStatus: "Status",
        profileModel: "Model",
        profileLanguage: "Bahasa",
        statusDeveloper: "Developer",
        statusStudent: "Student",
        langButton: "Ganti Bahasa",
        langButtonID: "Indonesia",
        langButtonEN: "English",
        backButton: "Kembali",
        helpText: "Perintah tersedia:\n/start - Mulai bot\n/profile - Lihat profil & ganti bahasa\n/model - Ganti model AI\n/help - Bantuan\n\nUntuk mengambil file yang sudah disimpan, cukup kirim ID file (angka 5 digit)."
    },
    en: {
        welcome: (name, model) => `Hello ${name}! I'm OPENX, an AI assistant for Indonesian students (OpenClaw version).\n\nModel: ${model}\n\nSend any message to start talking with me. You can also send files/images and I'll help store them.`,
        accessDenied: "ACCESS DENIED\n\nYou don't have permission to use this bot.",
        thinking: "...",
        error: "Sorry, an error occurred. Please try again.",
        fileSaved: (id) => `File saved with ID: ${id}`,
        fileNotFound: "File with that ID was not found.",
        modelChanged: (model) => `Model changed to: ${model}`,
        langChanged: "Language changed to English",
        profileTitle: "User Profile",
        profileName: "Name",
        profileId: "ID",
        profileStatus: "Status",
        profileModel: "Model",
        profileLanguage: "Language",
        statusDeveloper: "Developer",
        statusStudent: "Student",
        langButton: "Change Language",
        langButtonID: "Indonesia",
        langButtonEN: "English",
        backButton: "Back",
        helpText: "Available commands:\n/start - Start bot\n/profile - View profile & change language\n/model - Change AI model\n/help - Help\n\nTo retrieve a saved file, just send the file ID (5-digit number)."
    }
};

function getLang(chatId) {
    return USER_LANGS.get(chatId) || 'id';
}

function t(chatId, key, ...args) {
    const lang = getLang(chatId);
    const msg = MESSAGES[lang][key];
    return typeof msg === 'function' ? msg(...args) : msg;
}

function generateFileId() {
    return Math.floor(10000 + Math.random() * 90000).toString();
}

function getCurrentModel() {
    try {
        const modelData = JSON.parse(fs.readFileSync("./package/model.json", "utf-8"));
        return modelData.defaultModel;
    } catch {
        return "stepfun/step-3.5-flash:free";
    }
}

function isAuthorized(chatId) {
    const ownerId = parseInt(config.telegram.devId);
    let students = [];
    try {
        const studentData = fs.readFileSync("./package/studentId.json", "utf-8");
        if (studentData.trim()) {
            students = JSON.parse(studentData);
        }
    } catch {
        students = [];
    }
    return chatId === ownerId || students.includes(chatId);
}

function ensureUserDir(chatId) {
    const dir = path.join("./caches/files", String(chatId));
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function saveFile(chatId, fileId, filename) {
    const dir = ensureUserDir(chatId);
    const metaPath = path.join(dir, "meta.json");
    let meta = {};
    try {
        meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    } catch {}
    
    let fileIdNum = generateFileId();
    while (meta[fileIdNum]) {
        fileIdNum = generateFileId();
    }
    
    meta[fileIdNum] = { fileId, filename, date: new Date().toISOString() };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    return fileIdNum;
}

function getFileById(chatId, fileIdNum) {
    const dir = path.join("./caches/files", String(chatId));
    const metaPath = path.join(dir, "meta.json");
    try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        return meta[fileIdNum] || null;
    } catch {
        return null;
    }
}

function listFiles(chatId) {
    const dir = path.join("./caches/files", String(chatId));
    const metaPath = path.join(dir, "meta.json");
    try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        return Object.entries(meta).map(([id, data]) => ({ id, ...data }));
    } catch {
        return [];
    }
}

async function askAI(chatId, userMessage, systemContext = null) {
    const lang = getLang(chatId);
    const files = listFiles(chatId);
    const fileList = files.length > 0 ? files.map(f => `${f.id}: ${f.filename}`).join(", ") : "(kosong)";
    
    let contextData = {};
    try {
        contextData = JSON.parse(fs.readFileSync("./package/context.json", "utf-8"));
    } catch {}

    const defaultContextStr = contextData?.telegram?.[lang] || 
        (lang === 'id' 
            ? "Kamu adalah OPENX, asisten AI untuk pelajar. Wajib pakai bahasa gaul, santai abis, pake lu/gue biar asik kayak temen nongkrong.\nInfo user:\n- Chat ID: {chatId}\n- File tersimpan: {fileList}"
            : "You are OPENX, an AI assistant for Indonesian students.\nUser info:\n- Chat ID: {chatId}\n- Saved files: {fileList}");
    
    let resolvedContext = defaultContextStr.replace("{chatId}", chatId).replace("{fileList}", fileList);
    
    let schedulesContext = "";
    try {
        const schedules = JSON.parse(fs.readFileSync("./package/schedules.json", "utf-8"));
        if (schedules.length > 0) {
            schedulesContext = "\n\nInformasi Jadwal Sekolah/Tugas:\n" + schedules.map(s => `- ${s.day} ${s.time}: ${s.text}`).join("\n");
        }
    } catch(e) {}
    resolvedContext += schedulesContext;
    
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
    resolvedContext += storageContext;
    
    let serverStatus = `\n\n[Status Server]: Uptime ${Math.floor(process.uptime() / 60)} menit, RAM ${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)} MB.`;
    try {
        const logContent = fs.readFileSync("./log.txt", "utf-8");
        const logLines = logContent.split('\\n').filter(l => l.trim().length > 0).slice(-15).join('\\n');
        serverStatus += `\n[Log Terakhir (log.txt)]:\n${logLines}`;
    } catch(e) {}
    resolvedContext += serverStatus;
    
    const aiRules = `\n\nAturan Penting: Jika user minta tolong ingetin/bikin jadwal/tugas secara interaktif, balas secara natural dan DI AKHIR BALASAN wajib sertakan format rahasia ini: [ADD_SCHEDULE|Hari|HH:MM|Deskripsi_singkat|TargetJID_ATAU_none]. Contoh: [ADD_SCHEDULE|Senin|07:00|Upacara|none]. Jika user mau liat log / status server, infokan berdasarkan context dari system ini.`;
    
    const context = systemContext || (resolvedContext + aiRules);
    
    const messages = [
        { role: "system", content: context },
        { role: "user", content: userMessage }
    ];
    
    let aiResult = await chatCompletion(messages, getCurrentModel());
    
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
    
    return aiResult.replace(regex, '').trim();
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

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username || msg.from.first_name || "User";
    const lang = getLang(chatId);

    if (!isAuthorized(chatId)) {
        bot.sendMessage(chatId, t(chatId, "accessDenied"));
        return;
    }

    const waitMsg = await bot.sendMessage(chatId, t(chatId, "thinking"));
    
    try {
        const aiWelcome = await askAI(chatId, "User baru memulai chat. Sapa mereka dan beritahu cara menggunakan OPENX dengan bahasa gaul.");
        await bot.deleteMessage(chatId, waitMsg.message_id);
        bot.sendMessage(chatId, stripMarkdown(aiWelcome) || t(chatId, "welcome", username, getCurrentModel()));
        log(`Successfully responded to start command for ${chatId}`);
    } catch (error) {
        logError(error);
        await bot.deleteMessage(chatId, waitMsg.message_id);
        bot.sendMessage(chatId, t(chatId, "welcome", username, getCurrentModel()));
    }
});

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    
    const waitMsg = await bot.sendMessage(chatId, t(chatId, "thinking"));
    
    try {
        const aiHelp = await askAI(chatId, "User meminta bantuan. Jelaskan cara menggunakan OPENX dengan ramah.");
        await bot.deleteMessage(chatId, waitMsg.message_id);
        bot.sendMessage(chatId, stripMarkdown(aiHelp) || t(chatId, "helpText"));
    } catch (error) {
        await bot.deleteMessage(chatId, waitMsg.message_id);
        bot.sendMessage(chatId, t(chatId, "helpText"));
    }
});

bot.onText(/\/model/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;

    let modelData = { availableModels: [], defaultModel: "stepfun/step-3.5-flash:free" };
    try {
        modelData = JSON.parse(fs.readFileSync("./package/model.json", "utf-8"));
    } catch {}

    const modelButtons = modelData.availableModels.map(model => [{
        text: (model === modelData.defaultModel ? "[x] " : "[ ] ") + model.split("/").pop(),
        callback_data: `set_model_${model}`
    }]);

    bot.sendMessage(chatId, `Pilih Model AI:\n\nAktif: ${modelData.defaultModel}`, {
        reply_markup: {
            inline_keyboard: [...modelButtons, [{ text: "Kembali", callback_data: "cancel_model" }]]
        }
    });
});

bot.onText(/\/profile/, async (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username || msg.from.first_name || "User";
    
    if (!isAuthorized(chatId)) return;
    
    const lang = getLang(chatId);
    const status = chatId === parseInt(config.telegram.devId) ? t(chatId, "statusDeveloper") : t(chatId, "statusStudent");
    const currentLang = lang === 'id' ? t(chatId, "langButtonID") : t(chatId, "langButtonEN");
    
    const profileText = `${t(chatId, "profileTitle")}\n\n${t(chatId, "profileName")}: ${username}\n${t(chatId, "profileId")}: ${chatId}\n${t(chatId, "profileStatus")}: ${status}\n${t(chatId, "profileModel")}: ${getCurrentModel()}\n${t(chatId, "profileLanguage")}: ${currentLang}`;
    
    bot.sendMessage(chatId, profileText, {
        reply_markup: {
            inline_keyboard: [
                [{ text: t(chatId, "langButton"), callback_data: "menu_lang" }]
            ]
        }
    });
});

bot.onText(/\/lang/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    
    const currentLang = getLang(chatId);
    const newLang = currentLang === 'id' ? 'en' : 'id';
    USER_LANGS.set(chatId, newLang);
    
    const confirmMsg = newLang === 'id' ? MESSAGES.id.langChanged : MESSAGES.en.langChanged;
    
    const waitMsg = await bot.sendMessage(chatId, t(chatId, "thinking"));
    
    try {
        const aiResponse = await askAI(chatId, `User mengganti bahasa ke ${newLang === 'id' ? 'Bahasa Indonesia' : 'English'}. Konfirmasi perubahan bahasa dengan ramah.`);
        await bot.deleteMessage(chatId, waitMsg.message_id);
        bot.sendMessage(chatId, stripMarkdown(aiResponse) || confirmMsg);
    } catch (error) {
        await bot.deleteMessage(chatId, waitMsg.message_id);
        bot.sendMessage(chatId, confirmMsg);
    }
});

bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;

    if (!isAuthorized(chatId)) {
        bot.answerCallbackQuery(query.id, { text: "Akses ditolak!" });
        return;
    }

    if (data.startsWith("set_model_")) {
        const selectedModel = data.replace("set_model_", "");
        try {
            const modelData = JSON.parse(fs.readFileSync("./package/model.json", "utf-8"));
            modelData.defaultModel = selectedModel;
            fs.writeFileSync("./package/model.json", JSON.stringify(modelData, null, 4));
            
            bot.answerCallbackQuery(query.id, { text: t(chatId, "modelChanged", selectedModel.split("/").pop()) });
            
            const waitMsg = await bot.sendMessage(chatId, t(chatId, "thinking"));
            try {
                const aiResponse = await askAI(chatId, `Model AI diubah ke "${selectedModel}". Konfirmasi perubahan model dengan ramah.`);
                await bot.deleteMessage(chatId, waitMsg.message_id);
                await bot.deleteMessage(chatId, messageId);
                bot.sendMessage(chatId, stripMarkdown(aiResponse) || t(chatId, "modelChanged", selectedModel));
            } catch (error) {
                await bot.deleteMessage(chatId, waitMsg.message_id);
                await bot.deleteMessage(chatId, messageId);
                bot.sendMessage(chatId, t(chatId, "modelChanged", selectedModel));
            }
        } catch (error) {
            bot.answerCallbackQuery(query.id, { text: "Gagal mengubah model!" });
        }
    } else if (data === "cancel_model") {
        await bot.deleteMessage(chatId, messageId);
        bot.answerCallbackQuery(query.id);
    } else if (data === "menu_lang") {
        // Show language selection buttons
        bot.editMessageText(`${t(chatId, "profileTitle")}\n\n${t(chatId, "profileLanguage")}:`, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
                inline_keyboard: [
                    [{ text: "Indonesia", callback_data: "set_lang_id" }, { text: "English", callback_data: "set_lang_en" }],
                    [{ text: t(chatId, "backButton"), callback_data: "back_profile" }]
                ]
            }
        });
        bot.answerCallbackQuery(query.id);
    } else if (data === "set_lang_id" || data === "set_lang_en") {
        const newLang = data === "set_lang_id" ? 'id' : 'en';
        const oldLang = getLang(chatId);
        
        if (oldLang === newLang) {
            bot.answerCallbackQuery(query.id, { text: newLang === 'id' ? "Bahasa sudah Indonesia" : "Language already English" });
            return;
        }
        
        USER_LANGS.set(chatId, newLang);
        const confirmMsg = newLang === 'id' ? MESSAGES.id.langChanged : MESSAGES.en.langChanged;
        
        bot.answerCallbackQuery(query.id, { text: confirmMsg });
        
        // Update profile view with new language
        const username = query.from.username || query.from.first_name || "User";
        const status = chatId === parseInt(config.telegram.devId) ? t(chatId, "statusDeveloper") : t(chatId, "statusStudent");
        const currentLang = newLang === 'id' ? t(chatId, "langButtonID") : t(chatId, "langButtonEN");
        
        const profileText = `${t(chatId, "profileTitle")}\n\n${t(chatId, "profileName")}: ${username}\n${t(chatId, "profileId")}: ${chatId}\n${t(chatId, "profileStatus")}: ${status}\n${t(chatId, "profileModel")}: ${getCurrentModel()}\n${t(chatId, "profileLanguage")}: ${currentLang}`;
        
        bot.editMessageText(profileText, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
                inline_keyboard: [
                    [{ text: t(chatId, "langButton"), callback_data: "menu_lang" }]
                ]
            }
        });
    } else if (data === "back_profile") {
        // Go back to profile view
        const username = query.from.username || query.from.first_name || "User";
        const status = chatId === parseInt(config.telegram.devId) ? t(chatId, "statusDeveloper") : t(chatId, "statusStudent");
        const currentLang = getLang(chatId) === 'id' ? t(chatId, "langButtonID") : t(chatId, "langButtonEN");
        
        const profileText = `${t(chatId, "profileTitle")}\n\n${t(chatId, "profileName")}: ${username}\n${t(chatId, "profileId")}: ${chatId}\n${t(chatId, "profileStatus")}: ${status}\n${t(chatId, "profileModel")}: ${getCurrentModel()}\n${t(chatId, "profileLanguage")}: ${currentLang}`;
        
        bot.editMessageText(profileText, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
                inline_keyboard: [
                    [{ text: t(chatId, "langButton"), callback_data: "menu_lang" }]
                ]
            }
        });
        bot.answerCallbackQuery(query.id);
    }
});

bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    
    // Relay pesan Telegram -> WhatsApp via fitur Reply
    if (msg.reply_to_message && msg.reply_to_message.text && msg.text && !msg.text.startsWith('/')) {
        const repliedText = msg.reply_to_message.text;
        const match = repliedText.match(/ID: `([^`]+)`/);
        if (match && waSock) {
            const waJid = match[1];
            try {
                await waSock.sendMessage(waJid, { text: msg.text });
                bot.sendMessage(chatId, `✅ Balasan terkirim ke WA \`${waJid}\``, { parse_mode: "Markdown" });
            } catch (err) {
                bot.sendMessage(chatId, `❌ Gagal membalas ke WA: ${err.message}`);
            }
            return;
        }
    }

    // Command inisiasi pesan dan config /wa, /status, /channel_set
    if (msg.text && msg.text.startsWith("/")) {
        if (msg.text.startsWith("/status ")) {
            const parts = msg.text.split(' ');
            if (parts.length < 2) return bot.sendMessage(chatId, 'Gunakan: /status [nomor]\nContoh: /status 628123');
            const target = parts[1];
            try {
                const configPath = "./package/wa_config.json";
                let waConfig = { statusTargets: [], adminChannels: [] };
                if (fs.existsSync(configPath)) waConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
                
                if (!waConfig.statusTargets.includes(target)) {
                    waConfig.statusTargets.push(target);
                    fs.writeFileSync(configPath, JSON.stringify(waConfig, null, 2));
                    bot.sendMessage(chatId, `✅ Nomor ${target} ditaruh di radar pantauan Status.`);
                } else {
                    bot.sendMessage(chatId, `⚠️ Nomor ${target} sudah ada di daftar.`);
                }
            } catch (e) { bot.sendMessage(chatId, `❌ Gagal: ${e.message}`); }
            return;
        }

        if (msg.text.startsWith("/channel_set ")) {
            const parts = msg.text.split(' ');
            if (parts.length < 2) return bot.sendMessage(chatId, 'Gunakan: /channel_set [JID]\nContoh: /channel_set 123@newsletter');
            const target = parts[1];
            try {
                const configPath = "./package/wa_config.json";
                let waConfig = { statusTargets: [], adminChannels: [] };
                if (fs.existsSync(configPath)) waConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
                
                if (!waConfig.adminChannels.includes(target)) {
                    waConfig.adminChannels.push(target);
                    fs.writeFileSync(configPath, JSON.stringify(waConfig, null, 2));
                    bot.sendMessage(chatId, `✅ Channel ${target} masuk radar Auto-Post AI.`);
                } else {
                    bot.sendMessage(chatId, `⚠️ Channel ${target} sudah terdaftar.`);
                }
            } catch (e) { bot.sendMessage(chatId, `❌ Gagal: ${e.message}`); }
            return;
        }

        if (msg.text.startsWith("/wa ")) {
            const parts = msg.text.split(' ');
            if (parts.length < 3) {
                bot.sendMessage(chatId, 'Format salah. Gunakan: /wa 628xxxxx pesan anda');
                return;
            }
            const waNumber = parts[1];
            const waMsg = parts.slice(2).join(' ');
            if (waSock) {
                try {
                    const targetJid = waNumber.includes('@') ? waNumber : `${waNumber}@s.whatsapp.net`;
                    await waSock.sendMessage(targetJid, { text: waMsg });
                    bot.sendMessage(chatId, `✅ Pesan terkirim ke WhatsApp \`${waNumber}\``, { parse_mode: "Markdown" });
                } catch (err) {
                    bot.sendMessage(chatId, `❌ Gagal mengirim ke WA: ${err.message}`);
                }
            } else {
                bot.sendMessage(chatId, '❌ WhatsApp belum terhubung.');
            }
            return;
        }

        if (msg.text.startsWith("/waread ")) {
            const target = msg.text.split(' ')[1];
            if (!target) return bot.sendMessage(chatId, "Gunakan: /waread [JID]");
            
            try {
                const configPath = "./package/wa_config.json";
                let waConfig = { statusTargets: [], adminChannels: [], readModeTargets: [] };
                if (fs.existsSync(configPath)) waConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
                if (!waConfig.readModeTargets) waConfig.readModeTargets = [];
                
                const cleanTarget = target.includes('@') ? target : `${target}@s.whatsapp.net`;
                
                if (!waConfig.readModeTargets.includes(cleanTarget)) {
                    waConfig.readModeTargets.push(cleanTarget);
                    fs.writeFileSync(configPath, JSON.stringify(waConfig, null, 2));
                    bot.sendMessage(chatId, `✅ Read Mode diaktifkan untuk WA \`${cleanTarget}\`. Pesan akan dikumpulkan.`);
                } else {
                    waConfig.readModeTargets = waConfig.readModeTargets.filter(t => t !== cleanTarget);
                    fs.writeFileSync(configPath, JSON.stringify(waConfig, null, 2));
                    bot.sendMessage(chatId, `❌ Read Mode dinonaktifkan untuk WA \`${cleanTarget}\`.`);
                }
            } catch (e) { bot.sendMessage(chatId, `❌ Gagal: ${e.message}`); }
            return;
        }

        if (msg.text.startsWith("/wasummarize ")) {
            const target = msg.text.split(' ')[1];
            if (!target) return bot.sendMessage(chatId, "Gunakan: /wasummarize [JID]");
            
            const cleanTarget = target.includes('@') ? target : `${target}@s.whatsapp.net`;
            try {
                const cachePath = "./package/wa_read_cache.json";
                let readCache = {};
                if (fs.existsSync(cachePath)) readCache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
                
                const messagesTarget = readCache[cleanTarget];
                if (!messagesTarget || messagesTarget.length === 0) {
                    bot.sendMessage(chatId, `⚠️ Tidak ada pesan terkumpul untuk \`${cleanTarget}\`.`);
                    return;
                }
                
                const combinedMsg = messagesTarget.join("\\n");
                bot.sendMessage(chatId, `⏳ Meringkas ${messagesTarget.length} pesan dari \`${cleanTarget}\`...`);
                
                const prompt = `Berikut adalah percakapan/pesan yang dikumpulkan dari seseorang:\n\n${combinedMsg}\n\nTolong ringkas poin-poin intisari penting secara singkat dan padat!`;
                
                const aiResult = await askAI(chatId, prompt, "Kamu adalah alat peringkas chat. Jawab hanya dengan ringkasan singkat tanpa intro.");
                
                let outText = `👀 *WA Read Mode & Summarize*\nDari: \`${cleanTarget}\`\n\n*Ringkasan AI:*\n${stripMarkdown(aiResult)}`;
                bot.sendMessage(chatId, outText, { parse_mode: "Markdown" });
                
                // Clear cache
                readCache[cleanTarget] = [];
                fs.writeFileSync(cachePath, JSON.stringify(readCache, null, 2));
            } catch (e) {
                bot.sendMessage(chatId, `❌ Gagal meringkas: ${e.message}`);
            }
            return;
        }

        // --- COMMAND JADWAL ---
        if (msg.text.startsWith("/jadwal")) {
            const command = msg.text;
            const parts = command.split(' ');
            
            const schedulePath = "./package/schedules.json";
            let schedules = [];
            try { if (fs.existsSync(schedulePath)) schedules = JSON.parse(fs.readFileSync(schedulePath, "utf-8")); } catch(e) {}
            
            if (parts[1] === "add") {
                // format: /jadwal add Hari HH:MM [target WA] Deskripsi
                // exp:    /jadwal add Senin 07:00 120@g.us Upacara
                if (parts.length < 5) {
                    bot.sendMessage(chatId, "Format: `/jadwal add [Hari] [Jam:Menit] [Target_Jika_WA] [Deskripsi]`\nContoh: `/jadwal add Senin 07:30 123@g.us Upacara Bendera` Atau ganti target dengan 'none' jika tidak ada target WA.", { parse_mode: "Markdown" });
                    return;
                }
                const dayStr = parts[2].toLowerCase(); // ex: senin
                const timeStr = parts[3]; // ex: 07:30
                const targetWa = parts[4] === "none" ? null : parts[4];
                const desc = parts.slice(5).join(' ');
                
                const dayMap = { "minggu": 0, "senin": 1, "selasa": 2, "rabu": 3, "kamis": 4, "jumat": 5, "sabtu": 6 };
                const dayIdx = dayMap[dayStr] !== undefined ? dayMap[dayStr] : '*';
                
                let cronString = "";
                let [hh, mm] = timeStr.split(':');
                if (hh && mm) {
                    cronString = `${mm} ${hh} * * ${dayIdx}`;
                } else {
                    return bot.sendMessage(chatId, "Format waktu salah. Harusnya HH:MM");
                }
                
                const newSchedule = {
                    id: Date.now().toString().slice(-6),
                    day: dayStr,
                    time: timeStr,
                    cronString: cronString,
                    text: desc,
                    targets: targetWa ? [targetWa] : []
                };
                
                schedules.push(newSchedule);
                fs.writeFileSync(schedulePath, JSON.stringify(schedules, null, 2));
                bot.sendMessage(chatId, `✅ Jadwal ditambahkan!\nID: ${newSchedule.id}\nHari: ${newSchedule.day} ${newSchedule.time}\nTarget: ${targetWa || 'Hanya Telegram'}\nDeskripsi: ${newSchedule.text}`);
            } else if (parts[1] === "list") {
                if (schedules.length === 0) return bot.sendMessage(chatId, "Tidak ada jadwal aktif.");
                const listStr = schedules.map(s => `ID: ${s.id} | ${s.day} ${s.time} | Target WA: ${s.targets.length ? s.targets[0] : 'None'} | ${s.text}`).join('\n');
                bot.sendMessage(chatId, `📅 *Daftar Jadwal:*\n${listStr}`, { parse_mode: "Markdown" });
            } else if (parts[1] === "delete") {
                if (!parts[2]) return bot.sendMessage(chatId, "Masukkan ID Jadwal.");
                const initialLen = schedules.length;
                schedules = schedules.filter(s => s.id !== parts[2]);
                if (schedules.length < initialLen) {
                    fs.writeFileSync(schedulePath, JSON.stringify(schedules, null, 2));
                    bot.sendMessage(chatId, `✅ Jadwal ${parts[2]} dihapus.`);
                } else {
                    bot.sendMessage(chatId, `⚠️ Jadwal ID ${parts[2]} tidak ditemukan.`);
                }
            } else {
                 bot.sendMessage(chatId, "Perintah tidak valid. Gunakan /jadwal add, list, atau delete.");
            }
            return;
        }

        return;
    }

    const text = msg.text || msg.caption;
    if (!text) return;

    // Check if it's a file ID (5 digit number)
    if (/^\d{5}$/.test(text.trim())) {
        const fileIdNum = text.trim();
        const fileData = getFileById(chatId, fileIdNum);
        
        if (!fileData) {
            const waitMsg = await bot.sendMessage(chatId, t(chatId, "thinking"));
            try {
                const aiResponse = await askAI(chatId, `User mencoba mengambil file dengan ID "${fileIdNum}" tapi tidak ditemukan. Beritahu mereka dengan ramah.`);
                await bot.deleteMessage(chatId, waitMsg.message_id);
                bot.sendMessage(chatId, stripMarkdown(aiResponse) || t(chatId, "fileNotFound"));
            } catch (error) {
                await bot.deleteMessage(chatId, waitMsg.message_id);
                bot.sendMessage(chatId, t(chatId, "fileNotFound"));
            }
            return;
        }
        
        const waitMsg = await bot.sendMessage(chatId, t(chatId, "thinking"));
        try {
            const aiResponse = await askAI(chatId, `User mengambil file dengan ID "${fileIdNum}" (nama file: ${fileData.filename}). Beritahu bahwa file sedang dikirim.`);
            await bot.deleteMessage(chatId, waitMsg.message_id);
            await bot.sendMessage(chatId, stripMarkdown(aiResponse) || `Mengirim file: ${fileData.filename}`);
            
            await bot.sendDocument(chatId, fileData.fileId).catch(() => {
                bot.sendPhoto(chatId, fileData.fileId).catch(() => {
                    bot.sendMessage(chatId, t(chatId, "fileNotFound"));
                });
            });
        } catch (error) {
            await bot.deleteMessage(chatId, waitMsg.message_id);
            await bot.sendDocument(chatId, fileData.fileId).catch(() => {
                bot.sendPhoto(chatId, fileData.fileId).catch(() => {
                    bot.sendMessage(chatId, t(chatId, "fileNotFound"));
                });
            });
        }
        return;
    }

    // Regular chat with AI
    const waitMsg = await bot.sendMessage(chatId, t(chatId, "thinking"));

    try {
        log(`Processing chat message from ${chatId}: ${text}`);
        const response = await askAI(chatId, text);
        await bot.deleteMessage(chatId, waitMsg.message_id);
        bot.sendMessage(chatId, stripMarkdown(response) || t(chatId, "error"));
        log(`Successfully replied to message from ${chatId}`);
    } catch (error) {
        logError(error);
        await bot.deleteMessage(chatId, waitMsg.message_id);
        bot.sendMessage(chatId, t(chatId, "error"));
    }
});

bot.on("document", async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;

    const fileId = msg.document.file_id;
    const filename = msg.document.file_name || `file_${Date.now()}`;
    const lang = getLang(chatId);

    const fileIdNum = saveFile(chatId, fileId, filename);

    const waitMsg = await bot.sendMessage(chatId, t(chatId, "thinking"));

    try {
        const aiResponse = await askAI(chatId, `User mengirim file dengan nama "${filename}". File telah disimpan dengan ID ${fileIdNum}. Acknowledge penyimpanan file dengan ramah dan natural.`);
        await bot.deleteMessage(chatId, waitMsg.message_id);
        bot.sendMessage(chatId, stripMarkdown(aiResponse) || t(chatId, "fileSaved", fileIdNum));
    } catch (error) {
        await bot.deleteMessage(chatId, waitMsg.message_id);
        bot.sendMessage(chatId, t(chatId, "fileSaved", fileIdNum));
    }
});

bot.on("photo", async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;

    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const caption = msg.caption || `image_${Date.now()}.jpg`;
    const lang = getLang(chatId);

    const fileIdNum = saveFile(chatId, fileId, caption);

    const waitMsg = await bot.sendMessage(chatId, t(chatId, "thinking"));

    try {
        const aiResponse = await askAI(chatId, `User mengirim gambar dengan nama "${caption}". Gambar telah disimpan dengan ID ${fileIdNum}. Acknowledge penyimpanan gambar dengan ramah dan natural.`);
        await bot.deleteMessage(chatId, waitMsg.message_id);
        bot.sendMessage(chatId, stripMarkdown(aiResponse) || t(chatId, "fileSaved", fileIdNum));
    } catch (error) {
        await bot.deleteMessage(chatId, waitMsg.message_id);
        bot.sendMessage(chatId, t(chatId, "fileSaved", fileIdNum));
    }
});

// Initialize Cron for Schedules
cron.schedule('* * * * *', async () => {
    try {
        const schedulePath = "./package/schedules.json";
        if (!fs.existsSync(schedulePath)) return;
        const schedules = JSON.parse(fs.readFileSync(schedulePath, "utf-8"));
        
        const now = new Date();
        const currentMinute = now.getMinutes();
        const currentHour = now.getHours();
        const currentDay = now.getDay();
        
        for (const s of schedules) {
            const [minStr, hourStr, dom, month, dow] = s.cronString.split(' ');
            
            // Basic matching (only checks minute, hour, day of week)
            // Asterisk means match all.
            const minMatch = minStr === '*' || parseInt(minStr) === currentMinute;
            const hourMatch = hourStr === '*' || parseInt(hourStr) === currentHour;
            const dowMatch = dow === '*' || parseInt(dow) === currentDay;

            if (minMatch && hourMatch && dowMatch) {
                const message = `⏰ *PENGINGAT JADWAL/TUGAS*\n\n${s.text}`;
                
                // Send to Telegram devId
                bot.sendMessage(config.telegram.devId, message, { parse_mode: "Markdown" }).catch(e => logError("Failed to send schedule to Telegram:", e));
                
                // Send to WA targets
                if (s.targets && s.targets.length > 0 && waSock) {
                    for (const target of s.targets) {
                        const cleanTarget = target.includes('@') ? target : `${target}@s.whatsapp.net`;
                        waSock.sendMessage(cleanTarget, { text: message }).catch(e => logError(`Failed to send schedule to WA ${target}:`, e));
                    }
                }
                log(`[CRON] Schedule executed: ${s.id}`);
            }
        }
    } catch(e) {
        logError("Error on cron schedule check:", e);
    }
});

log("OPENX Telegram Bot started!");
connectToWhatsApp(bot, parseInt(config.telegram.devId));

