import { config } from "../../config.js";
import fs from "fs";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

async function fetchModel(messages, modelName) {
    const response = await fetch(OPENROUTER_API_URL, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${config.openrouter.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/openxx",
            "X-Title": "OPENX Bot"
        },
        body: JSON.stringify({
            model: modelName,
            messages: messages
        })
    });

    if (!response.ok) {
        throw new Error(`API error (${modelName}): ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    if (data.choices && data.choices[0] && data.choices[0].message) {
        return data.choices[0].message.content;
    }
    throw new Error(`Empty response from ${modelName}`);
}

export async function chatCompletion(messages, model = null) {
    let modelData = { defaultModel: "minimax/minimax-m2.5:free", availableModels: [] };
    try {
        const fileContent = fs.readFileSync("./package/model.json", "utf-8");
        modelData = JSON.parse(fileContent);
    } catch (e) {}

    const lastMessage = messages[messages.length - 1].content || "";
    const isComplex = lastMessage.match(/(?:```|kode|code|kompleks|script|program|jelaskan|detail|error)/i);
    
    // FITUR KOMITE MODEL (Penggabungan jika kompleks)
    if (isComplex && modelData.availableModels && modelData.availableModels.length > 1) {
        console.log("[AI Routing] Pertanyaan kompleks terdeteksi. Menggabungkan model...");
        // Tembak max 3 model agar tidak memakan waktu terlalu lama
        const committeeModels = modelData.availableModels.slice(0, 3);
        const promises = committeeModels.map(m => fetchModel(messages, m).catch(() => null));
        
        const rawResults = await Promise.all(promises);
        const validResults = rawResults.filter(r => r !== null);
        
        if (validResults.length > 1) {
             const synthMessages = [
                 { role: "system", content: "Kamu adalah AI Synthesizer. Rangkum dan gabungkan referensi jawaban dari beberapa AI menjadi satu instruksi atau solusi terbaik yang paling akurat, komprehensif, logis, tapi tetap pake bahasa gaul asik (lu/gue)." },
                 { role: "user", content: `Pertanyaan user asli: ${lastMessage}\n\n[Jawaban AI 1]: ${validResults[0]}\n\n[Jawaban AI 2]: ${validResults[1]}\n\nBuatlah 1 jawaban paling final dari gabungan ini.` }
             ];
             // Fallback loop untuk nembak synthesizer-nya
             for (const m of modelData.availableModels) {
                 try {
                     return await fetchModel(synthMessages, m);
                 } catch(e) {}
             }
        }
    }

    // FITUR AUTO-SWITCH (Fallback Biasa)
    let targetModels = [model || modelData.defaultModel];
    if (modelData.availableModels && modelData.availableModels.length > 0) {
        targetModels = [...new Set([targetModels[0], ...modelData.availableModels])];
    }
    
    for (const currentModel of targetModels) {
        try {
            console.log(`[AI Routing] Memanggil model: ${currentModel}`);
            const result = await fetchModel(messages, currentModel);
            return result;
        } catch (error) {
            console.error(`[AI Routing] Gagal di ${currentModel}, beralih ke model berikutnya...`);
        }
    }
    
    throw new Error("Peringatan: Semua pilihan model AI (Auto Switch) sedang down atau terkena limit dari OpenRouter API.");
}
