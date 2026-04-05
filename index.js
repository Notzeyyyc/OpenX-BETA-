import TelegramBot from "node-telegram-bot-api";
import { config } from "./config.js";
import fs from "fs";
import path from "path";
import { chatCompletion } from "./package/openx/openrouter.js";
import { log, error as logError } from "./logger.js";
import { connectToWhatsApp, waSock } from "./whatsapp.js";
import cron from "node-cron";
import { getDeviceInfo, getAppList, openApp, takeScreenshot, typeText, searchWeb, sendNotification, getHealthStatus } from './package/adb_helper.js';
import { exec } from 'child_process';
import util from 'util';
import { downloadMedia } from './package/downloader.js';

const execPromise = util.promisify(exec);
import { detectAdbPort } from './adb_connect.js';

const bot = new TelegramBot(config.telegram.token, { polling: true });
const USER_LANGS = new Map();

// UI Text for Telegram Bot (Supports Indonesian and English)
const MESSAGES = {
    id: {
        welcome: (name, model) => `Yo ${name}! I'm OPENX, your student AI assistant (OpenClaw version).\n\nModel: ${model}\n\nSend me anything to chat. You can also toss me files/images and I'll keep 'em safe for you.`,
        accessDenied: "ACCESS DENIED\n\nYou're not on the list to use this bot, sorry!",
        thinking: "...",
        error: "My bad, something went wrong. Try again?",
        fileSaved: (id) => `File locked in! ID: ${id}`,
        fileNotFound: "Couldn't find any file with that ID. Double check it!",
        modelChanged: (model) => `Model swapped to: ${model}`,
        langChanged: "Switching language to Indonesian!",
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
        helpText: "Commands:\n/start - Kick things off\n/profile - View profile & swap languages\n/model - Swap AI models\n/help - Need a hand?\n\nTo grab a saved file, just send the 5-digit file ID."
    },
    en: {
        welcome: (name, model) => `Hello ${name}! I'm OPENX, an AI assistant for students (OpenClaw version).\n\nModel: ${model}\n\nSend any message to start talking with me. You can also send files/images and I'll help store them.`,
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

// Helper: Get user's preferred language
function getLang(chatId) {
    return USER_LANGS.get(chatId) || 'id';
}

// Translate logic with dynamic args
function t(chatId, key, ...args) {
    const lang = getLang(chatId);
    const msg = MESSAGES[lang][key];
    return typeof msg === 'function' ? msg(...args) : msg;
}

// Generate a random 5-digit file ID
function generateFileId() {
    return Math.floor(10000 + Math.random() * 90000).toString();
}

// Fetch current default AI model
function getCurrentModel() {
    try {
        const modelData = JSON.parse(fs.readFileSync("./package/model.json", "utf-8"));
        return modelData.defaultModel;
    } catch {
        return "stepfun/step-3.5-flash:free";
    }
}

// Check if user has access (Dev or Whitelisted Student)
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

// Ensure specific dir for user files exist
function ensureUserDir(chatId) {
    const dir = path.join("./caches/files", String(chatId));
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

// Save file metadata to persistent storage
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

// Fetch file metadata by ID
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

// List all files for a specific user
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

/**
 * AI logic for Telegram Bot.
 * Manages contexts, ADB actions, and schedules.
 */
async function askAI(chatId, userMessage, systemContext = null) {
    const lang = getLang(chatId);
    const files = listFiles(chatId);
    const fileList = files.length > 0 ? files.map(f => `${f.id}: ${f.filename}`).join(", ") : "(empty)";
    
    let contextData = {};
    try {
        contextData = JSON.parse(fs.readFileSync("./package/context.json", "utf-8"));
    } catch {}

    // Load global personality
    let personalities = { active: "default", profiles: {} };
    try {
        personalities = JSON.parse(fs.readFileSync("./package/personalities.json", "utf-8"));
    } catch (e) {}
    
    const activeProfile = personalities.profiles[personalities.active] || personalities.profiles["default"];
    const personalityPrompt = activeProfile ? activeProfile.prompt : "Lu adalah OPENX, asisten AI khusus buat pelajar.";
    
    let resolvedContext = personalityPrompt.replace("{chatId}", chatId).replace("{fileList}", fileList);
    
    // Fetch schedule context
    let schedulesContext = "";
    try {
        const schedules = JSON.parse(fs.readFileSync("./package/schedules.json", "utf-8"));
        if (schedules.length > 0) {
            schedulesContext = "\n\nSchedules/Tasks Info:\n" + schedules.map(s => `- ${s.day} ${s.time}: ${s.text}`).join("\n");
        }
    } catch(e) {}
    resolvedContext += schedulesContext;
    
    // Fetch persistent memory context
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
    resolvedContext += storageContext;
    
    // Server health/status context
    let serverStatus = `\n\n[Server Status]: Uptime ${Math.floor(process.uptime() / 60)} mins, RAM ${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)} MB.`;
    try {
        const logContent = fs.readFileSync("./log.txt", "utf-8");
        const logLines = logContent.split('\n').filter(l => l.trim().length > 0).slice(-15).join('\n');
        serverStatus += `\n[Recent Logs (log.txt)]:\n${logLines}`;
    } catch(e) {}
    resolvedContext += serverStatus;
    
    // Inject ADB Context if relevant keywords are used
    let adbContext = "";
    if (userMessage) {
        const lowerMsg = userMessage.toLowerCase();
        if (['open', 'app', 'ram', 'storage', 'battery', 'device', 'specs', 'screen', 'screenshot', 'ss', 'type', 'write', 'search', 'google'].some(k => lowerMsg.includes(k))) {
            const di = await getDeviceInfo();
            const al = await getAppList();
            adbContext = `\n\nReal Device Data:\n${di}\n${al}`;
        }
    }
    resolvedContext += adbContext;
    
    // Aturan interaksi core
    const aiRules = `\n\nAturan Penting:
1. Untuk pengingat/jadwal: balas secara natural dan sertakan [ADD_SCHEDULE|Hari|HH:MM|Deskripsi|TargetJID_ATAU_none] di paling akhir balasan.
2. Untuk log server / status: infokan berdasarkan context dari system ini.
3. Untuk buka aplikasi: cari nama package-nya di daftar aplikasi dan sertakan [ADB_OPEN|nama.package].
4. Untuk screenshot: sertakan [ADB_SCREENSHOT].
5. Untuk kirim notifikasi ke HP: sertakan [ADB_NOTIFY|Judul|Pesan].
6. Untuk cek kesehatan HP (baterai, suhu, dll): sertakan [ADB_HEALTH].
7. Untuk chat ke orang lain di WhatsApp: sertakan [WA_SEND|nomor_atau_jid|pesan_ai]. Pastikan nomor pake format internasional (628...).
8. Untuk mengetik: sertakan [ADB_TYPE|teks_yang_diketik].
9. Untuk mencari di web: sertakan [ADB_SEARCH|query].
Bawaannya sesuaikan sama kepribadian di atas, taro tag di akhir balasan.`;
    
    const context = systemContext || (resolvedContext + aiRules);
    
    const contextMessages = [
        { role: "system", content: context },
        { role: "user", content: userMessage }
    ];
    
    let aiResult = await chatCompletion(contextMessages, getCurrentModel());
    if (!aiResult) aiResult = "";
    
    // Handle Schedule Tag
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
    
    // Parse ADB Commands from AI
    const adbOpnRegex = /\[ADB_OPEN\|(.*?)\]/g;
    let opMatch;
    while ((opMatch = adbOpnRegex.exec(aiResult)) !== null) {
        const pkg = opMatch[1].trim();
        openApp(pkg).catch(()=>{});
    }
    aiResult = aiResult.replace(adbOpnRegex, '');
    
    const adbTypeRegex = /\[ADB_TYPE\|(.*?)\]/g;
    let typeMatch;
    while ((typeMatch = adbTypeRegex.exec(aiResult)) !== null) {
        const textToType = typeMatch[1].trim();
        typeText(textToType).catch(()=>{});
    }
    aiResult = aiResult.replace(adbTypeRegex, '');

    const adbSearchRegex = /\[ADB_SEARCH\|(.*?)\]/g;
    let searchMatch;
    while ((searchMatch = adbSearchRegex.exec(aiResult)) !== null) {
        const query = searchMatch[1].trim();
        searchWeb(query).catch(()=>{});
    }
    aiResult = aiResult.replace(adbSearchRegex, '');
    
    const adbScRegex = /\[ADB_SCREENSHOT\]/g;
    if (adbScRegex.test(aiResult)) {
        if (chatId && bot) {
            const tempPath = path.join(process.cwd(), "caches", `ss_tg_${Date.now()}.png`);
            takeScreenshot(tempPath).then(success => {
                if (success) {
                    bot.sendPhoto(chatId, fs.createReadStream(tempPath)).catch(()=>{});
                    setTimeout(() => { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); }, 5000);
                }
            });
        }
        aiResult = aiResult.replace(adbScRegex, '');
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
            contextMessages.push({ role: "assistant", content: aiResult });
            contextMessages.push({ role: "user", content: `(System) Real Health Info:\n${healthReport}\nTell the user about this health status naturally.` });
            aiResult = await chatCompletion(contextMessages, getCurrentModel());
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
            if (chatId) {
                if (res.type === "video") await bot.sendVideo(chatId, res.buffer);
                else if (res.type === "audio") await bot.sendAudio(chatId, res.buffer);
                else await bot.sendDocument(chatId, res.buffer, {}, { filename: res.filename });
            }
        }).catch(err => logError(`Download failed for ${url}:`, err));
    }
    aiResult = aiResult.replace(dlRegex, '');
    
    return aiResult.trim();
}

// Remove markdown symbols for cleaner message rendering
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
        const aiWelcome = await askAI(chatId, "User just started the chat. Greet them and explain how to use OPENX in a super casual/gaul way.");
        await bot.deleteMessage(chatId, waitMsg.message_id);
        bot.sendMessage(chatId, stripMarkdown(aiWelcome) || t(chatId, "welcome", username, getCurrentModel()));
        log(`Successfully responded to start command for ${chatId}`);
    } catch (error) {
        logError(error);
        await bot.deleteMessage(chatId, waitMsg.message_id);
        bot.sendMessage(chatId, t(chatId, "welcome", username, getCurrentModel()));
    }
});

bot.onText(/\/personality/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;

    const args = msg.text.split(' ');
    const subCommand = args[1]?.toLowerCase();
    let personalities = { active: "default", profiles: {} };
    try { personalities = JSON.parse(fs.readFileSync("./package/personalities.json", "utf-8")); } catch(e){}

    if (!subCommand) {
        return bot.sendMessage(chatId, "🎭 *Personality Commands:*\n/personality list\n/personality select [key]\n/personality add [Name] | [Prompt]\n/personality delete [key]", { parse_mode: "Markdown" });
    }

    if (subCommand === 'list') {
        let listMsg = "🎭 *Available Personalities:*\n\n";
        for (const key in personalities.profiles) {
            const p = personalities.profiles[key];
            listMsg += `${key === personalities.active ? '✅' : '▪️'} *${key}*: ${p.name}\n`;
        }
        bot.sendMessage(chatId, listMsg, { parse_mode: "Markdown" });
    } else if (subCommand === 'select') {
        const key = args[2]?.toLowerCase();
        if (personalities.profiles[key]) {
            personalities.active = key;
            fs.writeFileSync("./package/personalities.json", JSON.stringify(personalities, null, 2));
            bot.sendMessage(chatId, `✅ Personality swapped to: *${personalities.profiles[key].name}*`);
        } else {
            bot.sendMessage(chatId, `❌ Personality *${key}* not found.`);
        }
    } else if (subCommand === 'add') {
        const content = msg.text.split('|');
        if (content.length < 2) return bot.sendMessage(chatId, "❌ Format: `/personality add Name | Prompt Text`", { parse_mode: "Markdown" });
        const namePart = msg.text.substring(17).split('|')[0].trim();
        const promptPart = msg.text.substring(17).split('|').slice(1).join('|').trim();
        const key = namePart.toLowerCase().replace(/\s+/g, '_');
        
        if (key && promptPart) {
            personalities.profiles[key] = { name: namePart, prompt: promptPart };
            fs.writeFileSync("./package/personalities.json", JSON.stringify(personalities, null, 2));
            bot.sendMessage(chatId, `✨ New personality added: *${namePart}* (key: ${key})`);
        } else {
            bot.sendMessage(chatId, "❌ Format: `/personality add Name | Prompt Text`", { parse_mode: "Markdown" });
        }
    } else if (subCommand === 'delete') {
        const key = args[2]?.toLowerCase();
        if (key === 'default') return bot.sendMessage(chatId, "❌ Cannot delete default personality.");
        if (personalities.profiles[key]) {
            delete personalities.profiles[key];
            if (personalities.active === key) personalities.active = 'default';
            fs.writeFileSync("./package/personalities.json", JSON.stringify(personalities, null, 2));
            bot.sendMessage(chatId, `🗑️ Personality *${key}* deleted.`);
        } else {
            bot.sendMessage(chatId, `❌ Personality *${key}* not found.`);
        }
    }
});

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) return;
    
    const waitMsg = await bot.sendMessage(chatId, t(chatId, "thinking"));
    
    try {
        const aiHelp = await askAI(chatId, "User is asking for help. Explain how to use OPENX friendly and casually.");
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

    bot.sendMessage(chatId, `Select AI Model:\n\nActive: ${modelData.defaultModel}`, {
        reply_markup: {
            inline_keyboard: [...modelButtons, [{ text: "Back", callback_data: "cancel_model" }]]
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
        const aiResponse = await askAI(chatId, `User changed the language to ${newLang === 'id' ? 'Bahasa Indonesia' : 'English'}. Confirm the change casually.`);
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
        bot.answerCallbackQuery(query.id, { text: "Access Denied!" });
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
                const aiResponse = await askAI(chatId, `AI Model changed to "${selectedModel}". Confirm the change casually.`);
                await bot.deleteMessage(chatId, waitMsg.message_id);
                await bot.deleteMessage(chatId, messageId);
                bot.sendMessage(chatId, stripMarkdown(aiResponse) || t(chatId, "modelChanged", selectedModel));
            } catch (error) {
                await bot.deleteMessage(chatId, waitMsg.message_id);
                await bot.deleteMessage(chatId, messageId);
                bot.sendMessage(chatId, t(chatId, "modelChanged", selectedModel));
            }
        } catch (error) {
            bot.answerCallbackQuery(query.id, { text: "Failed to change model!" });
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
            bot.answerCallbackQuery(query.id, { text: newLang === 'id' ? "Already in Indonesian" : "Already in English" });
            return;
        }
        
        USER_LANGS.set(chatId, newLang);
        const confirmMsg = newLang === 'id' ? MESSAGES.id.langChanged : MESSAGES.en.langChanged;
        
        bot.answerCallbackQuery(query.id, { text: confirmMsg });
        
        // Refresh profile view with updated language
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
        // Return to main profile view
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
    
    // Relay Telegram messages to WhatsApp via Reply feature
    if (msg.reply_to_message && msg.reply_to_message.text && msg.text && !msg.text.startsWith('/')) {
        const repliedText = msg.reply_to_message.text;
        const match = repliedText.match(/ID: `([^`]+)`/);
        if (match && waSock) {
            const waJid = match[1];
            try {
                await waSock.sendMessage(waJid, { text: msg.text });
                bot.sendMessage(chatId, `✅ Reply sent to WA \`${waJid}\``, { parse_mode: "Markdown" });
            } catch (err) {
                bot.sendMessage(chatId, `❌ Failed to send reply to WA: ${err.message}`);
            }
            return;
        }
    }

    // Config commands: /wa, /status, /channel_set, /waread, /wasummarize
    if (msg.text && msg.text.startsWith("/")) {
        if (msg.text.startsWith("/status ")) {
            const parts = msg.text.split(' ');
            if (parts.length < 2) return bot.sendMessage(chatId, 'Usage: /status [phone_number]\nExample: /status 628123');
            const target = parts[1];
            try {
                const configPath = "./package/wa_config.json";
                let waConfig = { statusTargets: [], adminChannels: [] };
                if (fs.existsSync(configPath)) waConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
                
                if (!waConfig.statusTargets.includes(target)) {
                    waConfig.statusTargets.push(target);
                    fs.writeFileSync(configPath, JSON.stringify(waConfig, null, 2));
                    bot.sendMessage(chatId, `✅ Number ${target} added to Status Monitoring radar.`);
                } else {
                    bot.sendMessage(chatId, `⚠️ Number ${target} is already on the list.`);
                }
            } catch (e) { bot.sendMessage(chatId, `❌ Error: ${e.message}`); }
            return;
        }

        if (msg.text.startsWith("/channel_set ")) {
            const parts = msg.text.split(' ');
            if (parts.length < 2) return bot.sendMessage(chatId, 'Usage: /channel_set [JID]\nExample: /channel_set 123@newsletter');
            const target = parts[1];
            try {
                const configPath = "./package/wa_config.json";
                let waConfig = { statusTargets: [], adminChannels: [] };
                if (fs.existsSync(configPath)) waConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
                
                if (!waConfig.adminChannels.includes(target)) {
                    waConfig.adminChannels.push(target);
                    fs.writeFileSync(configPath, JSON.stringify(waConfig, null, 2));
                    bot.sendMessage(chatId, `✅ Channel ${target} added to Auto-Post AI radar.`);
                } else {
                    bot.sendMessage(chatId, `⚠️ Channel ${target} is already registered.`);
                }
            } catch (e) { bot.sendMessage(chatId, `❌ Error: ${e.message}`); }
            return;
        }

        if (msg.text.startsWith("/wa ")) {
            const parts = msg.text.split(' ');
            if (parts.length < 3) {
                bot.sendMessage(chatId, 'Invalid format. Use: /wa 628xxxxx your message');
                return;
            }
            const waNumber = parts[1];
            const waMsg = parts.slice(2).join(' ');
            if (waSock) {
                try {
                    const targetJid = waNumber.includes('@') ? waNumber : `${waNumber}@s.whatsapp.net`;
                    await waSock.sendMessage(targetJid, { text: waMsg });
                    bot.sendMessage(chatId, `✅ Message sent to WhatsApp \`${waNumber}\``, { parse_mode: "Markdown" });
                } catch (err) {
                    bot.sendMessage(chatId, `❌ Failed to send to WA: ${err.message}`);
                }
            } else {
                bot.sendMessage(chatId, '❌ WhatsApp is not connected.');
            }
            return;
        }

        if (msg.text.startsWith("/waread ")) {
            const target = msg.text.split(' ')[1];
            if (!target) return bot.sendMessage(chatId, "Usage: /waread [JID]");
            
            try {
                const configPath = "./package/wa_config.json";
                let waConfig = { statusTargets: [], adminChannels: [], readModeTargets: [] };
                if (fs.existsSync(configPath)) waConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
                if (!waConfig.readModeTargets) waConfig.readModeTargets = [];
                
                const cleanTarget = target.includes('@') ? target : `${target}@s.whatsapp.net`;
                
                if (!waConfig.readModeTargets.includes(cleanTarget)) {
                    waConfig.readModeTargets.push(cleanTarget);
                    fs.writeFileSync(configPath, JSON.stringify(waConfig, null, 2));
                    bot.sendMessage(chatId, `✅ Read Mode enabled for WA \`${cleanTarget}\`. Messages will be collected.`);
                } else {
                    waConfig.readModeTargets = waConfig.readModeTargets.filter(t => t !== cleanTarget);
                    fs.writeFileSync(configPath, JSON.stringify(waConfig, null, 2));
                    bot.sendMessage(chatId, `❌ Read Mode disabled for WA \`${cleanTarget}\`.`);
                }
            } catch (e) { bot.sendMessage(chatId, `❌ Error: ${e.message}`); }
            return;
        }

        if (msg.text.startsWith("/wasummarize ")) {
            const target = msg.text.split(' ')[1];
            if (!target) return bot.sendMessage(chatId, "Usage: /wasummarize [JID]");
            
            const cleanTarget = target.includes('@') ? target : `${target}@s.whatsapp.net`;
            try {
                const cachePath = "./package/wa_read_cache.json";
                let readCache = {};
                if (fs.existsSync(cachePath)) readCache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
                
                const messagesTarget = readCache[cleanTarget];
                if (!messagesTarget || messagesTarget.length === 0) {
                    bot.sendMessage(chatId, `⚠️ No messages collected for \`${cleanTarget}\`.`);
                    return;
                }
                
                const combinedMsg = messagesTarget.join("\n");
                bot.sendMessage(chatId, `⏳ Summarizing ${messagesTarget.length} messages from \`${cleanTarget}\`...`);
                
                const prompt = `Here are the messages collected from a user/group:\n\n${combinedMsg}\n\nPlease summarize the key points clearly and concisely!`;
                
                const aiResult = await askAI(chatId, prompt, "You are a chat summarizer tool. Provide only the summary without any introduction.");
                
                let outText = `👀 *WA Read Mode & Summarize*\nFrom: \`${cleanTarget}\`\n\n*AI Summary:*\n${stripMarkdown(aiResult)}`;
                bot.sendMessage(chatId, outText, { parse_mode: "Markdown" });
                
                // Reset cache after summarizing
                readCache[cleanTarget] = [];
                fs.writeFileSync(cachePath, JSON.stringify(readCache, null, 2));
            } catch (e) {
                bot.sendMessage(chatId, `❌ Failed to summarize: ${e.message}`);
            }
            return;
        }

        // --- SCHEDULE COMMANDS (/jadwal) ---
        if (msg.text.startsWith("/jadwal")) {
            const command = msg.text;
            const parts = command.split(' ');
            
            const schedulePath = "./package/schedules.json";
            let schedules = [];
            try { if (fs.existsSync(schedulePath)) schedules = JSON.parse(fs.readFileSync(schedulePath, "utf-8")); } catch(e) {}
            
            if (parts[1] === "add") {
                // Format: /jadwal add [Day] [HH:MM] [Target_WA_OR_none] [Description]
                if (parts.length < 5) {
                    bot.sendMessage(chatId, "Usage: `/jadwal add [Day] [HH:MM] [TargetJID_OR_none] [Description]`\nExample: `/jadwal add Monday 07:30 123@g.us Flag Ceremony`. Use 'none' for TargetJID if no WhatsApp alert is needed.", { parse_mode: "Markdown" });
                    return;
                }
                const dayStr = parts[2].toLowerCase(); 
                const timeStr = parts[3]; 
                const targetWa = parts[4] === "none" ? null : parts[4];
                const desc = parts.slice(5).join(' ');
                
                const dayMap = { "sunday": 0, "monday": 1, "tuesday": 2, "wednesday": 3, "thursday": 4, "friday": 5, "saturday": 6, "minggu": 0, "senin": 1, "selasa": 2, "rabu": 3, "kamis": 4, "jumat": 5, "sabtu": 6 };
                const dayIdx = dayMap[dayStr] !== undefined ? dayMap[dayStr] : '*';
                
                let cronString = "";
                let [hh, mm] = timeStr.split(':');
                if (hh && mm) {
                    cronString = `${mm} ${hh} * * ${dayIdx}`;
                } else {
                    return bot.sendMessage(chatId, "Invalid time format. Use HH:MM");
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
                bot.sendMessage(chatId, `✅ Schedule Added!\nID: ${newSchedule.id}\nDay: ${newSchedule.day} ${newSchedule.time}\nTarget: ${targetWa || 'Telegram Only'}\nDescription: ${newSchedule.text}`);
            } else if (parts[1] === "list") {
                if (schedules.length === 0) return bot.sendMessage(chatId, "No active schedules.");
                const listStr = schedules.map(s => `ID: ${s.id} | ${s.day} ${s.time} | WA Target: ${s.targets.length ? s.targets[0] : 'None'} | ${s.text}`).join('\n');
                bot.sendMessage(chatId, `📅 *Active Schedules:*\n${listStr}`, { parse_mode: "Markdown" });
            } else if (parts[1] === "delete") {
                if (!parts[2]) return bot.sendMessage(chatId, "Please provide the Schedule ID.");
                const initialLen = schedules.length;
                schedules = schedules.filter(s => s.id !== parts[2]);
                if (schedules.length < initialLen) {
                    fs.writeFileSync(schedulePath, JSON.stringify(schedules, null, 2));
                    bot.sendMessage(chatId, `✅ Schedule ${parts[2]} deleted.`);
                } else {
                    bot.sendMessage(chatId, `⚠️ Schedule ID ${parts[2]} not found.`);
                }
            } else {
                 bot.sendMessage(chatId, "Invalid command. Use /jadwal add, list, or delete.");
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
            if (!s.cronString) continue;
            const [minStr, hourStr, dom, month, dow] = s.cronString.split(' ');
            
            const minMatch = minStr === '*' || parseInt(minStr) === currentMinute;
            const hourMatch = hourStr === '*' || parseInt(hourStr) === currentHour;
            const dowMatch = dow === '*' || parseInt(dow) === currentDay;

            if (minMatch && hourMatch && dowMatch) {
                const message = `⏰ *SCHEDULE ALERT*\n\n${s.text}`;
                
                // Alert to Master Telegram
                bot.sendMessage(config.telegram.devId, message, { parse_mode: "Markdown" }).catch(e => logError("Schedule failed (TG):", e));
                
                // Alert to WA targets
                if (s.targets && s.targets.length > 0 && waSock) {
                    for (const target of s.targets) {
                        const cleanTarget = target.includes('@') ? target : `${target}@s.whatsapp.net`;
                        waSock.sendMessage(cleanTarget, { text: message }).catch(e => logError(`Schedule failed (WA ${target}):`, e));
                    }
                }
                log(`[CRON] Schedule executed: ${s.id}`);
            }
        }
    } catch(e) {
        logError("Cron schedule check failed:", e);
    }
});

log("OPENX Bot is ready!");

async function connectADB() {
    if (!config.adbPort) return;
    if (config.adbPort === "auto") {
        await detectAdbPort();
        return;
    }
    log(`⏳ Auto-connecting to localhost:${config.adbPort}...`);
    try {
        const { stdout } = await execPromise(`adb connect localhost:${config.adbPort}`);
        log(`✅ ADB: ${stdout.trim()}`);
    } catch (e) {
        logError("ADB Auto-connect failed:", e);
    }
}

connectADB();
connectToWhatsApp(bot, parseInt(config.telegram.devId));

