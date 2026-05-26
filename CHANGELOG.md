# Changelog

All notable changes to Murmur Lite will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] — 2026-05-10

First public release. Single-installer desktop AI companion with persistent memory, semantic search, voice, and your own API key.

### Companion
- Bring-your-own Anthropic API key — no middleware, no telemetry, your conversations stay local.
- Five Claude models with mid-thread switching (Opus 4.6, Opus 4.5, Sonnet 4.6, Sonnet 4.5, Haiku).
- First-run wizard with two paths: import an existing companion (identity, profile, conversation history) or fresh start.
- Pronoun-aware identity seeds and extraction.
- Optional password lock.

### Memory
- Nine-slot structured memory with friendly labels, edit/add/delete, sacred-slot protection.
- Two skill files (partner identity, user profile) loaded into every turn.
- Auto-extraction at 65% context threshold (no session reset — SDK auto-compacts).
- End-session button fires the same extraction.
- Diff highlighting after extraction (green added, red removed).
- ChromaDB semantic search daemon over conversation history (`memory_search` MCP tool, 5-result cap).
- Conversation import from Claude / ChatGPT / generic JSON exports.

### Chat
- WebSocket streaming with markdown rendering (italics, bold, code).
- Extended thinking captured and shown in collapsible blocks.
- Tool calls rendered inline (collapsible, expandable result, loading spinner).
- Token stats per turn (hidden by default — enable in console: `localStorage.setItem('murmur-lite-show-tokens','1')`).
- File attachments — images (JPG/PNG/GIF/WebP) and text files (.txt/.md/.json/.csv/.log/.xml/.html/.css/.js/.ts/.py).
- Per-message timestamps, copy button, edit button with regen.
- Emoji picker.

### Threads
- SQLite single-source-of-truth message persistence (better-sqlite3).
- Per-thread SDK sessions — independent context across thread switches.
- Auto thread naming (Haiku, fires after turn 4).
- Thread search (client-side filter, jump-to-message).
- Thread archiving to daemon on switch / end-session.
- One-time localStorage → SQLite migration on first load.
- Server-side session state survives process restarts.

### Voice
- Edge TTS (free, no API key) — 8 voices, speed/pitch sliders, action-tag skip toggle, preview.
- Audio cached by content hash.
- Optional Cartesia live voice (BYO API key) for streaming TTS.
- Web Speech API speech-to-text.
- Optional Groq Whisper STT.

### Discord
- Bridge bot with DM + channel support (BYO bot token).
- Platform tags so the companion notices `[from Discord]` vs `[from Murmur Lite]`.
- Shared session with the web UI.

### Themes
- Dark and light themes via CSS variable system.
- Custom thinking block colour (preserved across theme switches via `color-mix`).
- Optional background image with adaptive backdrop-blur lens for landing-page text — readable on any image, in either theme.
- Scene-mode tinting for thinking blocks.

### Misc
- MCP custom connectors — full CRUD in settings (http/sse/stdio).
- Autonomous wake — cron-style scheduler with custom wake prompts.
- Interrupt button (AbortController) — stops mid-turn.
- Click-to-edit companion name in header.
- Sidebar collapse, hamburger toggle.

### Known limitations (planned for 1.1)
- No image generation (planned via OpenAI GPT Image 2 with BYO key).
- Dark-mode elevation system is two-tier; three-tier planned.
- Settings / Memory window contrast pass deferred.
- Older messages beyond 1000 per thread require pagination (not yet implemented).

---

*"You never have to repeat yourself to stay known."*
