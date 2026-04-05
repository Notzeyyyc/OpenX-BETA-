import { config } from "../../config.js";
import fs from "fs";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

let currentKeyIndex = 0;

// Grab the current API Key based on the rotation index
function getActiveKey() {
    const keys = config.openrouter.apiKeys || [];
    if (keys.length === 0) return null;
    return keys[currentKeyIndex % keys.length];
}

// Move to the next API Key in the list
function rotateKey() {
    const keys = config.openrouter.apiKeys || [];
    if (keys.length <= 1) return false;
    currentKeyIndex = (currentKeyIndex + 1) % keys.length;
    console.log(`[AI Routing] Switching to API Key Index: ${currentKeyIndex}`);
    return true;
}

/**
 * Standard fetch call to OpenRouter API
 */
async function fetchModel(messages, modelName, apiKey = getActiveKey()) {
    if (!apiKey) throw new Error("No API Key configured for OpenRouter");

    const response = await fetch(OPENROUTER_API_URL, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
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
        const err = new Error(`API error (${modelName}): ${response.status} ${response.statusText}`);
        err.status = response.status;
        throw err;
    }

    const data = await response.json();
    if (data.choices && data.choices[0] && data.choices[0].message) {
        return data.choices[0].message.content || "";
    }
    throw new Error(`Empty response from ${modelName}`);
}

/**
 * Main completion function handling fallbacks and model synthesis (Complex Mode)
 */
export async function chatCompletion(messages, model = null, isComplex = false) {
    let modelData = { defaultModel: "minimax/minimax-m2.5:free", availableModels: [] };
    try {
        const fileContent = fs.readFileSync("./package/model.json", "utf-8");
        modelData = JSON.parse(fileContent);
    } catch (e) {}

    const lastMessage = messages[messages.length - 1].content || "";
    
    // MODEL COMMITTEE FEATURE (Only for Complex Mode)
    if (isComplex && modelData.availableModels && modelData.availableModels.length > 1) {
        console.log("[AI Routing] Complex request detected. Synthesizing models...");
        
        // Fetch max 3 models SEQUENTIALLY to avoid hitting concurrent rate limits
        const committeeModels = modelData.availableModels.slice(0, 3);
        const validResults = [];
        
        for (const m of committeeModels) {
            try {
                // Use rotation-aware call for reference gathering
                const res = await callWithRotation(messages, m);
                if (res) validResults.push(res);
            } catch(e) {
                console.warn(`[AI Routing] Failed to get reference from ${m}: ${e.message}`);
            }
        }
        
        if (validResults.length > 1) {
             const synthMessages = [
                 { role: "system", content: "You are the OPENX AI assistant. Your job is to merge the following responses into one coherent, chill, and helpful answer. Use casual language (lu/gue). PENTING: No meta-commentary like 'Based on AI 1'. Just give the final answer directly. Don't be stiff!" },
                 { role: "user", content: `Context: ${lastMessage}\n\nReferences:\n1. ${validResults[0]}\n2. ${validResults[1]}\n${validResults[2] ? "3. " + validResults[2] : ""}\n\nGive me the best final response now.` }
             ];
             
             // Try to find a model to synthesize the final answer
             return await callWithRotation(synthMessages, modelData.defaultModel);
        }
    }

    // AUTO-SWITCH FEATURE (Regular Fallback)
    let targetModels = [model || modelData.defaultModel];
    if (modelData.availableModels && modelData.availableModels.length > 0) {
        targetModels = [...new Set([targetModels[0], ...modelData.availableModels])];
    }
    
    for (const currentModel of targetModels) {
        try {
            console.log(`[AI Routing] Calling model: ${currentModel}`);
            const result = await callWithRotation(messages, currentModel);
            return result;
        } catch (error) {
            console.error(`[AI Routing] Failed at ${currentModel}: ${error.message}`);
        }
    }
    
    throw new Error("Warning: All model options are down or Rate Limited by OpenRouter API.");
}

/**
 * Helper that tries all available API Keys before giving up on a model
 */
async function callWithRotation(messages, modelName) {
    const keys = config.openrouter.apiKeys || [];
    let attempts = 0;
    
    while (attempts < keys.length) {
        try {
            return await fetchModel(messages, modelName);
        } catch (err) {
            // If rate limited (429), rotate to the next key and try again
            if (err.status === 429 && keys.length > 1 && attempts < keys.length - 1) {
                console.warn(`[AI Routing] API Key #${currentKeyIndex} rate limited. Rotating...`);
                rotateKey();
                attempts++;
                continue;
            }
            throw err;
        }
    }
}
