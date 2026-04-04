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

export async function chatCompletion(messages, model = null, isComplex = false) {
    let modelData = { defaultModel: "minimax/minimax-m2.5:free", availableModels: [] };
    try {
        const fileContent = fs.readFileSync("./package/model.json", "utf-8");
        modelData = JSON.parse(fileContent);
    } catch (e) {}

    const lastMessage = messages[messages.length - 1].content || "";
    // isComplex sekarang dipicu oleh prefix .openxc dari whatsapp.js
    
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
                 { role: "system", content: "Kamu adalah asisten AI OPENX yang asik dan gaul. Tugasmu adalah menggabungkan beberapa poin jawaban berikut menjadi satu respons yang koheren, santai, dan solutif. Gunakan bahasa tongkrongan (lu/gue). PENTING: Jangan sertakan embel-embel seperti 'Berdasarkan jawaban AI 1', 'Hasil rangkuman:', atau meta-commentary lainnya. Langsung saja jawab ke user. Jangan kaku!" },
                 { role: "user", content: `Konteks Pertanyaan: ${lastMessage}\n\nReferensi Jawaban:\n1. ${validResults[0]}\n2. ${validResults[1]}\n${validResults[2] ? "3. " + validResults[2] : ""}\n\nBerikan jawaban final yang paling mantap sekarang.` }
             ];
             // Fallback loop untuk nembak synthesizer-nya
             for (const m of modelData.availableModels) {
                 try {
                     const finalResponse = await fetchModel(synthMessages, m);
                     if (finalResponse) return finalResponse;
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
