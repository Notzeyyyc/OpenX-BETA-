import { exec, spawn } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';

const execPromise = util.promisify(exec);

export async function getDeviceInfo() {
    let info = "[Device Info via ADB]\n";
    try {
        // RAM
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
            info += `- RAM: Gagal baca (/proc/meminfo)\n`;
        }
        
        // Kernel / OS
        try {
            const { stdout: unameOut } = await execPromise('adb shell uname -a');
            info += `- Kernel: ${unameOut.trim()}\n`;
        } catch (e) { }

        // Storage (/data)
        try {
            const { stdout: dfOut } = await execPromise("adb shell df -h /data");
            const lines = dfOut.trim().split('\n');
            if (lines.length > 1) {
                const parts = lines[1].trim().split(/\s+/);
                // Filesystem Size Used Avail Use% Mounted on
                info += `- Storage Data: ${parts[3]} Free / ${parts[1]} Total (${parts[4]} Terpakai)\n`;
            }
        } catch (e) {}

        // Root
        try {
            const { stdout: suOut } = await execPromise('adb shell which su');
            if (suOut.trim().length > 0) info += `- Root: Akses SU Tersedia (${suOut.trim()})\n`;
        } catch (e) {
            info += `- Root: Tidak terdeteksi\n`;
        }

    } catch (e) {
        info += "Gagal terhubung ke ADB atau device tidak ada.\n";
    }
    
    return info;
}

export async function getAppList() {
    try {
        const { stdout } = await execPromise('adb shell pm list packages -3');
        const lines = stdout.trim().split('\n');
        const apps = lines.map(line => line.replace('package:', '').trim()).filter(p => p);
        if (apps.length === 0) return "Tidak ada aplikasi pihak ketiga ditemukan.";
        return `[Daftar Package Aplikasi Terinstal]:\n${apps.join(', ')}`;
    } catch (e) {
        return "Gagal mengambil daftar aplikasi via ADB.";
    }
}

export async function openApp(pkgName) {
    try {
        await execPromise(`adb shell monkey -p ${pkgName} -c android.intent.category.LAUNCHER 1`);
        return true;
    } catch (e) {
        return false;
    }
}

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

export async function typeText(text) {
    try {
        // ADB input text doesn't handle spaces well unless it's escaped or using %s
        // But a more robust way for modern Android is using quotes
        const escapedText = text.replace(/ /g, '%s').replace(/'/g, "\\'");
        await execPromise(`adb shell input text "${escapedText}"`);
        return true;
    } catch (e) {
        return false;
    }
}

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


