# Shuttle · Desktop AI Assistant

English | [简体中文](README.zh-CN.md)

Shuttle is a desktop AI assistant built on Electron. Sign in and use mainstream Chinese LLMs right away: the AI can read and edit your local files and code, run commands, search the web, operate web pages, and connect to external services such as Tencent Docs, Amap and GitHub.

This repository contains the full source code of the **desktop client**, released under the [Apache-2.0](LICENSE) license. Accounts, membership and platform model routing are provided by the official server at `https://richbrian.site` (the server is not part of this repository). You can also enter your own API keys under Settings → Models & Keys, and the client will call each vendor directly without going through the server.

## Features

| Feature | Description |
|---|---|
| Files and commands | View, search and edit files in the working folder and run commands. Files are backed up before every change, and by default you are asked first each time |
| Built-in browser | A browser panel on the right where the AI can open pages, click and fill in forms by itself. Web pages it builds are previewed and checked for errors automatically, and you can take over at any time (to sign in or enter a captcha) |
| Background tasks | Complex tasks run in the background, up to 3 at a time. Start a new chat meanwhile; you get a notification when a task finishes or needs confirmation |
| Documents | Reads PDF, Word, Excel and PowerPoint directly. Drag files into the input box or pick them with 📎; they do not need to be in the working folder |
| Connectors | One-click MCP connectors for Tencent Docs, Amap / Baidu Maps / Tencent Maps, Yuque, GitHub, Notion, Figma and more. Services that need sign-in authorize in the browser; secrets go into a secure input and are stored encrypted |
| Skills | Dedicated skills for Feishu (Lark), Kingsoft Docs, Word / Excel / PowerPoint and more; skills can also be installed from GitHub or a local folder |
| Voice input | Click the microphone, or hold Option (Alt) in the input box and speak |
| Screenshot questions | Press `Cmd/Ctrl+Shift+X` or use the button next to the input box to select an area of the screen and ask about it |
| Quick window | Press `Cmd/Ctrl+Shift+Space` in any app to ask a question; text you just copied is included automatically |
| Scheduled tasks | Have the AI do things daily, weekly, monthly or at a fixed interval. Manage them in Settings, or just ask in a chat |
| Images | Paste or drop images for the AI to look at, or ask it to generate images |
| Chat management | Search, group by date, rename, archive and bulk delete. Summarize a long chat and continue in a new one with one click |
| Phone remote control | Turn it on under Settings → Remote Control, then open `https://richbrian.site/aidesk/web/` on your phone and sign in with the same account to have this computer work on files and run commands, with live progress and downloadable results. The first connection must be approved on the computer, and every file change or command in a remote task needs confirmation |
| Cloud sync | Turn it on under Settings → Data to see your chats on any computer where you sign in with the same account (stored encrypted in private cloud storage) |
| Next-message suggestions | After each answer, a likely follow-up appears in the input box; press Tab to use it |

The interface is available in Chinese and English.

## Download

Latest version **v0.3.26**:

| System | Download | Size |
|---|---|---|
| macOS (Apple silicon, M1/M2/M3/M4) | [Shuttle-0.3.26-mac-arm64.dmg](https://mamahug-1256157831.cos.ap-guangzhou.myqcloud.com/shuttle/releases/v0.3.26/Shuttle-0.3.26-mac-arm64.dmg) | 97 MB |
| macOS (Intel) | [Shuttle-0.3.26-mac-x64.dmg](https://mamahug-1256157831.cos.ap-guangzhou.myqcloud.com/shuttle/releases/v0.3.26/Shuttle-0.3.26-mac-x64.dmg) | 103 MB |
| Windows 10/11 (64-bit) | [Shuttle-0.3.26-win-x64.exe](https://mamahug-1256157831.cos.ap-guangzhou.myqcloud.com/shuttle/releases/v0.3.26/Shuttle-0.3.26-win-x64.exe) | 79 MB |

Older versions, release notes and SHA-256 checksums are on the [Releases](https://github.com/papillon95/shuttle/releases) page. Version 0.2.0 and later update automatically; just restart the app.

The installers are not code-signed yet, so the system will block the first launch:
- **macOS**: when you see "cannot verify the developer", open System Settings → Privacy & Security and click "Open Anyway" near the bottom; or right-click the app in Applications and choose "Open".
- **Windows**: when you see "Windows protected your PC", click "More info → Run anyway".

On macOS, screenshots need the Screen Recording permission and voice input needs the Microphone permission; follow the prompt to enable them in System Settings the first time.

## Run from source

```bash
npm install
npm start
```

The client connects to the production server `https://richbrian.site` by default. To point it at a local backend (the dev server runs on port 8089), set an environment variable:

```bash
AGENT_SERVER_URL=http://127.0.0.1:8089 npm start
```

If downloading Electron is slow in mainland China, use a mirror: `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`

Tests (plain Node, no UI needed):

```bash
node scripts/test-docs.mjs        # reading PDF / Word / Excel / PowerPoint
node scripts/test-scheduler.mjs   # scheduled task timing
node scripts/test-quick.mjs       # quick window
node scripts/test-crop.mjs        # screenshot cropping
node scripts/test-wav.mjs         # voice input audio encoding
```

## How updates work

| Type | When | What users download |
|---|---|---|
| **Patch** (most releases) | Only code under `src/` changed | About 4 MB, downloaded in the background, applied on restart |
| **Full installer** | Electron was upgraded, or `boot.js` or the packaging config changed (for example macOS permission texts) | New users download it; existing users still get patches |

- The client checks the version manifest `shuttle/updates/stable.json` on COS 10 seconds after launch and every 6 hours after that; you can also check manually under Settings → About.
- Patches are **signed with the publisher's Ed25519 private key**. The client verifies them with a built-in public key and rejects anything whose signature or fingerprint does not match.
- `boot.js` loads the downloaded patch from the user folder first. If the patch fails to load, or the window fails to open twice in a row, it falls back to the version bundled with the installer.
- Patches contain only `src/` and `package.json`, **not node_modules**: do not add new npm runtime dependencies; put third-party libraries under `src/vendor/` instead (for example pdfjs for reading PDFs).

## Releasing (maintainers)

One command does it all: bump the version → publish the patch and verify its signature → (full releases) build the macOS / Windows installers, upload them, record the version and update the download links → generate release notes → push master → sync the public repository and tag it → sync to GitHub (one commit per version, "Shuttle v<version>", plus a version tag; the script `scripts/sync-github.sh` can also be run on its own) → create the Gitea release page.

```bash
# Patch only (most common)
npm run ship -- patch 0.3.1 --notes "修复了……；新增了……" --notes-en "Fixed ...; Added ..."

# Patch + full installers
npm run ship -- full 0.4.0 --notes "..."

# Dry run: only checks and lists the steps, changes nothing
npm run ship -- patch 0.3.1 --notes "x" --dry-run
```

- Run it on the master branch of the main (private) mamahug repository, with no uncommitted changes under `aidesk-desktop`.
- Credentials are read from the environment variables `COS_SECRET_ID` / `COS_SECRET_KEY` and `DB_HOST` / `DB_USER` / `DB_PASS` first, falling back to the backend config in the main repository. The signing key defaults to `~/.config/shuttle/release-ed25519.pem` (keep a backup).
- The Gitea release page is created automatically only when `GITEA_TOKEN` is set; otherwise paste the generated `dist/RELEASE-v<version>.md` into the release page.
- Separate items in `--notes` with "；" to turn them into a list in the release notes.
- Full-installer mode **does not raise the minimum shell version (minShell)**, so users on older versions keep getting patches. Do not run `release.mjs full` directly; it raises minShell.

## Two ways to use models

| Mode | Request path | Billing |
|---|---|---|
| Platform models (default) | Client → `/aidesk/llm/chat/completions` (the backend forwards the request to the vendor with platform keys configured in the admin console) | Deducted from the membership quota, using per-model multipliers set in the admin console; tokens served from the model's prompt cache count as 1/10 |
| Your own API keys (enter them under Settings → Models & Keys, then pick a model from the "My keys" group in the model list at the top) | The client calls the vendor's OpenAI-compatible API directly | No quota is used; only token counts are reported for statistics |

Both modes live in the same model list, and you can switch at any time. Image generation, voice input, next-message suggestions and chat summaries always use the platform (after sign-in).

## Data and privacy

- **Chats are stored only on your computer by default**: `~/Library/Application Support/Shuttle/conversations/<user ID>/` (`%APPDATA%\Shuttle\` on Windows). In platform mode, messages are forwarded to the model vendor through the server, which does not keep chats or file contents.
- **Cloud sync (opt-in, off by default)**: chat files are stored in the private COS bucket `shuttle-conv-1256157831` (`users/<user ID>/<chat ID>.json`, AES256-encrypted by default, not publicly readable). The client uploads and downloads them directly through 10-minute signed URLs issued by the server, so the content never passes through the server; the server only keeps an index in the `aidesk_conversation` table (title, version, deleted flag). For the same chat the latest change wins, and deletions sync to other devices. Clearing all chats or deleting the account also deletes them from the cloud. AI-generated image files are not synced.
- Local settings: `settings.json` in the same folder (API keys, sign-in credentials and connector secrets are encrypted with the system keychain); scheduled tasks are stored there too.
- Backups made before file changes: `backups/` in the same folder. The built-in browser keeps its sign-in state in a separate storage partition, apart from your Chrome.
- Stored on the server: account, membership and orders, usage (token counts only), and syncable settings (custom instructions, theme, language and so on; never API keys).
- Shuttle only uses skills installed in Shuttle and does not read other AI tools' skill folders.

## Code structure

| File | Purpose |
|---|---|
| `boot.js` | Entry point: loads a downloaded patch first and falls back automatically if it fails |
| `src/main.js` | Main process: agent loop (call the model → run tools → return results), background chats, platform models / own keys, stream parsing, sign-in and server APIs, settings sync, chat saving, scheduled task runner |
| `src/tools.js` | Local tools: list_dir / read_file / search / edit_file / write_file / run_command, restricted to the working folder |
| `src/docs.js` | Reads PDF / Word / Excel / PowerPoint (PDF via `src/vendor/pdfjs`; the others by parsing zip + XML) |
| `src/browser.js` | Built-in browser: panel view, page snapshots, click / type / scroll, page problem checks |
| `src/mcp.js` / `src/mcp-remote.js` | MCP client: local (stdio) and remote (Streamable HTTP / SSE, OAuth) connectors |
| `src/runtimes.js` | One-click install of Node.js / uv needed by connectors |
| `src/skills.js` | Skills: install, enable, load on demand |
| `src/remote.js` | Phone remote control: long-polling for commands, pairing and authorization, forwarding progress to the phone |
| `src/convsync.js` | Cloud sync for chats: upload, download, delete sync, conflict handling |
| `src/scheduler.js` | Recurrence rules and next run time for scheduled tasks (pure functions) |
| `src/quickask.js` | Global shortcut quick window |
| `src/screenshot.js` | Screenshot questions: capture, window selection, cropping |
| `src/updater.js` | Patch updates: check, download, verify signature |
| `src/providers.js` | Built-in list of vendors and models (offline fallback; after sign-in the server's `/aidesk/catalog` is used) |
| `src/i18n.js` | Chinese and English UI strings (shared by the main process and the UI; both sets must have the same keys) |
| `src/preload.js` etc. | IPC APIs exposed to each window |
| `src/renderer/` | UI: chat, sidebar, settings, connectors and skills, browser panel, quick window (`quick.*`), screenshot selection (`capture.*`), Markdown rendering (`markdown.js`), voice input (`voice.js`) |
| `scripts/` | Release (`ship.mjs`, `release.mjs`, `upload-installers.mjs`, `sync-github.sh`) and test scripts |

## Before releasing

- Make sure `DEFAULT_SERVER` in `src/main.js` is the production address.
- To publish to app stores or avoid system warnings, set up macOS signing and notarization and Windows code signing.

## Support the project

Shuttle is built and maintained by an independent developer. If it saves you time, you are welcome to buy me a coffee via WeChat Pay. Every bit of support goes toward keeping the project running and improving it. Thank you!

<img src="docs/wechat-pay.jpg" alt="WeChat Pay QR code" width="240">

Starring the repository, reporting bugs and sharing ideas help a lot too.

## Contributing

Issues and pull requests are welcome. Please run the test scripts above before submitting. If you change UI text, update both the Chinese and English strings in `src/i18n.js`.

## License

[Apache License 2.0](LICENSE) © 2026 richbrian.site
