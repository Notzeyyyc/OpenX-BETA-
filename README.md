## Setup (Security First)

This repo intentionally does **not** commit any secrets.

1. Copy environment template:
   - See [.env.example](.env.example:1)
2. Create a local `.env` file (ignored by git via [.gitignore](.gitignore:1))
3. Fill:
   - `OPENX_DEV_PHONE_NUMBER`
   - `OPENX_OPENROUTER_API_KEYS` (comma-separated)

### Secret scanning

Running tests will run a small secret scanner:

- Script: [scripts/scan-secrets.mjs](scripts/scan-secrets.mjs:1)
- Package script: `pnpm test` (mapped to `pnpm run scan:secrets` in [package.json](package.json:1))

## Plugins (Security Model)

Plugin config lives in:

- [package/plugins.json](package/plugins.json:1)
- Integrity pins: [package/plugins.lock.json](package/plugins.lock.json:1)

### Integrity (sha256 pinning)

Each plugin has an `id` and an `entry` (path or npm specifier). At runtime OpenX computes sha256 of the resolved entry file and requires a matching pin in `plugins.lock.json` unless `OPENX_ALLOW_UNPINNED_PLUGINS=true`.

### Permissions (capabilities)

Plugins get a `host` API and are blocked unless they requested a permission:

- `wa.send` for WhatsApp send
- `ai.chat` for OpenRouter calls

Enforcement happens inside the plugin host API in [package/openx/plugin_manager.mjs](package/openx/plugin_manager.mjs:1).

### Optional sandbox

Per plugin you can set `sandbox: true` in [package/plugins.json](package/plugins.json:1). This runs the plugin in a separate process (IPC), and privileged calls go through the permission-checked host API.

## REST API (Plugin Management + Tool Execution)

OpenX can optionally expose a minimal REST API server (no Express) for:

- plugin management (install/enable/disable/reload/list)
- listing tools from plugins
- executing tools via HTTP

The server is implemented in [`startRestServer()`](package/openx/rest_server.mjs:141) and is started from [`initModules()`](modules/index.mjs:44).

### Enable

Set these env vars (see [.env.example](.env.example:1)):

- `OPENX_REST_ENABLED=true`
- `OPENX_REST_HOST=127.0.0.1`
- `OPENX_REST_PORT=8787`
- `OPENX_REST_API_KEY=openx-local-dev`

Auth is a query param: `?apikey=...` for all `/api/*` routes.

### Endpoints

- `GET /api/health?apikey=...`
- `GET /api/plugins?apikey=...`
- `POST /api/plugins/install?apikey=...` body: `{ "package": "openx-plugin-...", "permissions": ["..."], "sandbox": false }`
- `POST /api/plugins/enable?apikey=...` body: `{ "id": "openx-plugin-..." }`
- `POST /api/plugins/disable?apikey=...` body: `{ "id": "openx-plugin-..." }`
- `POST /api/plugins/reload?apikey=...`
- `GET /api/tools?apikey=...`
- `POST /api/tools/execute?apikey=...` body: `{ "toolId": "pluginId/toolId", "input": { ... } }`

### Plugin tool contract (authoring)

In addition to the existing WhatsApp hook (optional `onMessage()`), a plugin may export:

- `export const tools = [...]` (metadata)
- `export async function runTool({ toolId, input, host }) { ... }`

The host provides capability-checked APIs (see [`makeHostApi()`](package/openx/plugin_manager.mjs:74)):

- `host.wa.sendText` (permission `wa.send`)
- `host.ai.chat` (permission `ai.chat`)
- `host.net.fetch` (permission `net.fetch`)

### Sample tool plugin

There is a sample plugin in [`openx-plugin-fgsi-xai-grok`](package/openx/plugins/openx-plugin-fgsi-xai-grok/index.js:1). It is disabled by default in [`package/plugins.json`](package/plugins.json:1).
