import { exec, spawn } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';

const execPromise = util.promisify(exec);

/**
 * Diagnostics for the remote Android device via ADB.
 */
export async function getDeviceInfo() {
    let info = "[Device Info via ADB]\n";
    try {
        // RAM Diagnostics
        try {
            const { stdout: ramOut } = await execPromise('adb shell cat /proc/meminfo');
            const totalMatch = ramOut.match(/MemTotal:\s+(\d+)\s+kB/);
            const freeMatch = ramOut.match(/MemFree:\s+(\d+)\s+kB/);
            const availMatch = ramOut.match(/MemAvailable:\s+(\d+)\s+kB/);
            if (totalMatch) {
                const totalMb = Math.round(parseInt(totalMatch[1]) / 1024);
                const freeMb = availMatch ? Math.round(parseInt(availMatch[1]) / 1024) : 
                               (freeMatch ? Math.round(parseInt(freeMatch[1]) / 1024) : 0);
                info += `- RAM: ${freeMb}MB Free / ${totalMb}MB Total\n`;
            }
        } catch (e) {
            info += `- RAM: Read failed (/proc/meminfo)\n`;
        }
        
        // Kernel / OS details
        try {
            const { stdout: unameOut } = await execPromise('adb shell uname -a');
            info += `- Kernel: ${unameOut.trim()}\n`;
        } catch (e) { }

        // Local Storage (/data partition)
        try {
            const { stdout: dfOut } = await execPromise("adb shell df -h /data");
            const lines = dfOut.trim().split('\n');
            if (lines.length > 1) {
                const parts = lines[1].trim().split(/\s+/);
                // Filesystem Size Used Avail Use% Mounted on
                info += `- Storage Data: ${parts[3]} Free / ${parts[1]} Total (${parts[4]} Used)\n`;
            }
        } catch (e) {}

        // Root Access check
        try {
            const { stdout: suOut } = await execPromise('adb shell which su');
            if (suOut.trim().length > 0) info += `- Root: SU Access Available (${suOut.trim()})\n`;
        } catch (e) {
            info += `- Root: Not detected\n`;
        }

    } catch (e) {
        info += "ADB failed or device disconnected.\n";
    }
    
    return info;
}

/**
 * Fetches all 3rd-party apps installed on the device.
 */
export async function getAppList() {
    try {
        const { stdout } = await execPromise('adb shell pm list packages -3');
        const lines = stdout.trim().split('\n');
        const apps = lines.map(line => line.replace('package:', '').trim()).filter(p => p);
        if (apps.length === 0) return "No 3rd party apps found.";
        return `[Installed App Packages]:\n${apps.join(', ')}`;
    } catch (e) {
        return "Failed to fetch app list via ADB.";
    }
}

/**
 * Launches an application using its package name.
 */
export async function openApp(pkgName) {
    try {
        // Use monkey for a simple force-launch of the main activity
        await execPromise(`adb shell monkey -p ${pkgName} -c android.intent.category.LAUNCHER 1`);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Captures a high-quality screenshot from the device.
 */
export function takeScreenshot(outputPath) {
    return new Promise((resolve) => {
        try {
            const adbProc = spawn('adb', ['exec-out', 'screencap', '-p'], { shell: false });
            const stream = fs.createWriteStream(outputPath);
            adbProc.stdout.pipe(stream);
            
            adbProc.on('close', (code) => resolve(code === 0));
            adbProc.on('error', () => resolve(false));
            stream.on('error', () => resolve(false));
        } catch (e) {
            resolve(false);
        }
    });
}

/**
 * Injects text input into the active focused element on the device.
 */
export async function typeText(text) {
    try {
        // Escaping spaces for ADB input
        const escapedText = text.replace(/ /g, '%s').replace(/'/g, "\\'");
        await execPromise(`adb shell input text "${escapedText}"`);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Opens a Google search query in the device's default browser.
 */
export async function searchWeb(query) {
    try {
        const encodedQuery = encodeURIComponent(query);
        const url = `https://www.google.com/search?q=${encodedQuery}`;
        await execPromise(`adb shell am start -a android.intent.action.VIEW -d "${url}"`);
        return true;
    } catch (e) {
        return false;
    }
}


