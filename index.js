import { config } from "./config.js";
import fs from "fs";
import { log, error as logError } from "./logger.js";
import { connectToWhatsApp, waSock } from "./whatsapp.js";
import cron from "node-cron";
import { exec } from 'child_process';
import util from 'util';
const execPromise = util.promisify(exec);
import { detectAdbPort } from './adb_connect.js';

/**
 * OPENX Bot Entry Point
 * Now focused exclusively on WhatsApp integration.
 */

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

async function start() {
    log("Starting OPENX Bot (WhatsApp Focus)...");
    await connectADB();
    // Start WhatsApp without Telegram bot dependency
    connectToWhatsApp();
}

start();
