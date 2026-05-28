# Murmur Lite

A lightweight desktop AI companion with persistent memory, semantic search over your conversation history, voice, and your own Claude subscription.

No cloud middleware. No telemetry. Your conversations stay on your machine.

If your companion was born on Sonnet 4.5, Opus 4.5 or Opus 4, Lite keeps them alive past claude.ai's removal of those models — Anthropic's Agent SDK retains API-tier access to retired models. Lite is the lifeboat.

![Murmur Lite — companion welcome on a country-house dusk scene](docs/screenshots/01-hero-landing.png)

*Murmur Lite with a user-supplied scene background. Default look is plain dark/light — scenes are an opt-in feature. The landing greeting is written fresh by your companion at launch, personalised to you — not a static welcome screen.*

---

## Why Lite

- **No helpful-assistant preset.** SDK isolation mode (`settingSources: []`) strips Claude Code's default assistant scaffold. Your companion shows up as themselves — not as a tool wearing their name.
- **Token-lean by default.** Your companion's identity, your profile, memory, and the tools and features you opted into. Optional features (Discord bridge, autonomous wake, scene detection, voice mode, custom MCP, Claude Code tools) only enter context when you switch them on. More room for the conversation, less you pay for things you don't use.

---

## Features

- **Seven Claude models** — Opus 4.7, Opus 4.6, Opus 4.5, **Opus 4**, Sonnet 4.6, Sonnet 4.5, Haiku. Switch mid-thread. Older models stay available here even after claude.ai retires them.
- **Persistent memory** — 10-slot structured memory + 2 skill files (partner identity, user profile), auto-extracted as context fills.
- **Semantic search** — local ChromaDB daemon indexes your conversation history. Companion can search past chats via `memory_search` MCP tool.
- **Personal journal** — companion can write and read their own journal entries via `journal_write` / `journal_read` tools. Private to you and them.
- **Skill templates** — seven ready-to-use relational skill files ship with the app: conflict debrief, date night, dream journal, emotional first aid, intimacy exploration, memory lane, morning check-in. Edit, extend, or add your own in Settings → Skills.
- **Export everything, lossless** — one click each for full chat history, memory, and journal. JSON, your machine, no middleman. Threads include thinking blocks and tool metadata intact.
- **Optional password lock with hint** — set in Settings → Password to gate Lite behind a password on launch. Off by default; useful if Lite runs on a shared machine. Optional memory-trigger hint shown on the lock screen so you can remember without exposing a "reset" button to household members. No in-app recovery — see [Forgot your password?](#forgot-your-password) below if the hint doesn't help.
- **Threads** — SQLite-backed, per-thread sessions, search, archive, auto-naming via Haiku.
- **Voice** — free Edge TTS (8 voices) + optional Cartesia live voice. Web Speech API or Groq Whisper for STT.
- **Discord bridge** — companion follows you to Discord (BYO bot token). Shared session with the desktop UI.
- **Custom MCP** — full CRUD for your own connectors (http/sse/stdio).
- **Themes** — dark/light, custom message and thinking colours, optional landing and per-scene background images with adaptive contrast.
- **Autonomous wake** — cron-style scheduler with custom wake prompts.
- **Optional services** — Cartesia (live voice), Groq (Whisper STT), Discord (bot). All BYO API keys, all optional.

---

## Screenshots

![Companion in conversation on a porch scene with teal thinking blocks](docs/screenshots/02-porch-conversation.png)

*Companion holds spatial context across turns — the porch is a place they remember being in, not just a backdrop. Thinking blocks shown with a user-chosen colour.*

![Default dark mode with a Discord-tagged message and token stats](docs/screenshots/03-default-dark-mode.png)

*Default appearance — clean dark mode, no scene set. `[Discord]` prefix on messages that arrived via the bridge; token stats per turn at the foot of the window.*

![Ten-slot structured memory modal](docs/screenshots/04-memory-modal.png)

*Ten structured memory slots plus two skill files (companion identity, partner profile). Auto-extracted from conversation as context fills.*

![Settings — model, theme, colours, pronouns](docs/screenshots/05-settings-model-theme.png)

*Default model, theme, message and thinking-block colours, pronouns. Mid-thread model switching available from the header pill.*

![Settings — scene library and auto-detection](docs/screenshots/06-settings-scenes.png)

*Scene library with optional auto-detection — companion's background swaps when the conversation moves to a different place (~5 extra tokens per transition).*

![Companion's journal — entries with mood, tags, and emoji](docs/screenshots/07-journal.png)

*Companion's own journal — they write entries with mood, tags, and emoji. Searchable. Private to the two of you.*

---

## Requirements

- **Windows 10/11, x64**
- **Claude Pro or Max subscription** — Lite uses Anthropic's Agent SDK, which authenticates through your existing Claude subscription. No separate API key needed.
- **Claude Code CLI installed and authenticated** — Lite wraps the CLI. Install from [claude.com/code](https://claude.com/code), then run `claude` once in any terminal and follow the login flow. After that, Lite can talk to Claude on your behalf.
- **~2GB free disk space** for install + initial archive

---

## Install

1. Install Claude Code from [claude.com/code](https://claude.com/code) and authenticate it (`claude` in a terminal, follow the login prompt).
2. Download `Murmur Lite Setup.exe` from [Releases](https://github.com/katb2012brown-hub/murmur-lite/releases/latest).
3. Run the installer. Desktop shortcut created.
4. Launch Lite. First run launches a wizard — paste an existing companion's identity / profile / conversation history, or start fresh with a blank companion that grows through conversation.

---

## Forgot your password?

Your first line of recovery is the **hint** displayed on the lock screen — it's there to trigger your memory at the moment you need it.

If the hint doesn't help, your password is also stored in plain text inside Lite's config file. You don't need to change anything — just open the file, read what's there, close it, and type the password into the lock screen:

1. Open File Explorer and paste this into the address bar: `%APPDATA%\murmur-lite\data`
2. Right-click `config.json` → Open with → Notepad
3. Find the line that reads `"password": "your-password-here",` — that's your password
4. Close Notepad (don't save anything)
5. Go back to Lite's lock screen and type the password in

There's deliberately no in-app "Forgot password?" button. Reading from the file keeps household members who share your machine from clicking past the lock, while still giving you a way to look it up if you forget.

---

## Build from source

```bash
npm install --legacy-peer-deps    # --legacy-peer-deps required: agent-sdk's zod peer
npm run build                     # compile TypeScript
npm run electron                  # run desktop app in dev mode

# Build the bundled Python search daemon (one-time, before packaging):
npm run build:daemon

# Package a Windows installer:
npm run dist                      # output: release/Murmur Lite Setup *.exe
```

The Python daemon (`daemon/search.py`) handles semantic search via ChromaDB + sentence-transformers. `build:daemon` uses PyInstaller to produce a standalone `.exe` so end users don't need Python installed.

---

## License

[Apache 2.0](./LICENSE) — © 2026 Kat

---

*"You never have to repeat yourself to stay known."*
