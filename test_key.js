import { config } from "./config.js";

async function checkAccount(apiKey, index) {
    console.log(`Checking OpenRouter API Key #${index}...`);
    console.log(`Key: ${apiKey.substring(0, 10)}...`);

    if (apiKey.includes("REPLACE_WITH")) {
        console.warn(`[!] Key #${index} is still a placeholder. Skipping.`);
        return;
    }

    try {
        const response = await fetch("https://openrouter.ai/api/v1/credits", {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            }
        });

        if (!response.ok) {
            console.error(`Error: ${response.status} ${response.statusText}`);
            const text = await response.text();
            console.error("Response:", text);
            return;
        }

        const data = await response.json();
        console.log(`--- Key #${index} Info ---`);
        console.log(JSON.stringify(data, null, 2));
        console.log("------------------------");

    } catch (error) {
        console.error(`Fetch failed for Key #${index}:`, error.message);
    }
}

async function run() {
    const keys = config.openrouter.apiKeys || [];
    if (keys.length === 0) {
        console.error("No API keys found in config.js");
        return;
    }

    for (let i = 0; i < keys.length; i++) {
        await checkAccount(keys[i], i);
        console.log("");
    }
}

run();
