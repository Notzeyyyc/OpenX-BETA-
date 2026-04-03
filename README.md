# OPENX - Automated Cross-Platform AI Companion 🤖

A highly dynamic, cross-platform AI assistant natively built for **WhatsApp** (via Baileys) and **Telegram**. OPENX pushes the boundaries of standard chatbots by implementing advanced memory persistence, interactive scheduling, and complex multi-LLM model routing.

## 🌟 Key Features

- **🧠 Deep Memory & Context Storage**
  Dynamically extracts and stores chat context locally. The AI organically understands ongoing group conversations instead of reading raw inputs blindly, preventing API rate limit issues.
- **🔄 Smart Model Routing & Synthesizer Committee**
  Automatically falls back to standby models (`OpenRouter`) if API rate limits (e.g., 429 Too Many Requests) occur. For complex or code-related questions, a parallel "Committee Mode" engages. Multiple AI models generate raw solutions, and a master "Synthesizer AI" curates the most accurate, finalized response.
- **📁 Persistent Server File System**
  Brings Telegram's seamless, ID-based media experience natively to WhatsApp. Media files are stored securely on the local server and can be redeemed or pulled anytime using mapped 5-digit unique IDs.
- **⏰ Natural Language Operations**
  Interact with the bot naturally to create intricate cron-job reminders or school tasks. The AI intercepts and parses the casual text, automatically registering background cron-jobs without needing rigid command syntaxes.
- **👨‍💻 SysAdmin Diagnostics**
  The AI has read-access to its parent server logs (`log.txt`), active RAM footprint, and system uptime fed directly into its real-time context—allowing the bot to diagnose server health interactively.

## 🚀 Installation & Setup

1. **Prerequisites**
   - Node.js environment
   - `pnpm` installed natively

2. **Install Dependencies**
   ```bash
   pnpm install
   # Ensure you authorize any required build scripts for dependencies (like Baileys/Sharp)
   pnpm approve-builds
   ```

3. **Configuration**
   Populate the `.json` architectures inside the `/package/` folder and assign valid Developer Telegram IDs and `OpenRouter` API keys within `config.js`.

4. **Run the Server**
   ```bash
   pnpm start
   ```
   > On the first start, a WhatsApp QR Code will be printed in the terminal. Scan it to authenticate the local Baileys session.

## ⚖️ License

**Proprietary / Closed Source**
All rights reserved. Unauthorized reproduction, distribution, or modification of this project's code is strictly prohibited. See the `LICENSE` file for more details.
