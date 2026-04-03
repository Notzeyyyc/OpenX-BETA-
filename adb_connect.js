import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

/**
 * Script pembantu untuk koneksi ADB Localhost (Termux)
 * Jalankan dengan: node adb_connect.js [PORT]
 */
async function connectLocalADB() {
    const port = process.argv[2];
    if (!port) {
        console.log("❌ Masukkan Port Wireless Debugging!");
        console.log("Contoh: node adb_connect.js 34567");
        return;
    }

    console.log(`⏳ Mencoba koneksi ke localhost:${port}...`);
    try {
        const { stdout } = await execPromise(`adb connect localhost:${port}`);
        console.log(`✅ Output: ${stdout.trim()}`);
        
        const { stdout: devices } = await execPromise('adb devices');
        console.log(`\n📱 Daftar Device:\n${devices}`);
    } catch (e) {
        console.log(`❌ Gagal: ${e.message}`);
    }
}

connectLocalADB();
