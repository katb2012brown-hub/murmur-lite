/**
 * Murmur Lite — Server
 * Express for REST + WebSocket for streaming
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, mkdirSync, createReadStream, readdirSync, unlinkSync, watch } from 'fs';
import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { initMemory, loadMemory, saveMemory, validateMemoryJson, getSlotLabels, getMemoryAgeMs } from './memory.js';
import { initSkills, loadIdentitySkill, loadUserProfileSkill, saveIdentitySkill, saveUserProfileSkill, loadUserInstructions, saveUserInstructions } from './skills.js';
import { processMessage, runExtraction, invalidateSystemPromptCache, type TokenStats } from './harness.js';
import { startDaemon, stopDaemon, importMemories, importConversations, searchMemories, isDaemonReady, getImportProgress } from './daemon.js';
import { startDiscordBot, stopDiscordBot, isDiscordConnected, getDiscordBotTag, updateDiscordConfig, setDiscordMessageHandler } from './discord.js';
import { VoiceStream } from './voice-stream.js';
import { initCustomSkills, listCustomSkills as listSkills, saveCustomSkill, deleteCustomSkill, getCustomSkillRaw } from './custom-skills.js';
import { initDb, saveMessage, editMessage, getMessages, bulkSaveMessages, ensureThread, updateThreadSession, updateThreadName, getMessagesSince, saveFileRecord, getAllFiles, getFileRecord, deleteFileRecord, getFileStats, getThread, saveJournalEntry, getJournalEntries, getJournalEntry, searchJournalEntries, updateJournalEntry, deleteJournalEntry, getJournalCount, getAllThreads, getAllMessages, getAllJournalEntries } from './db.js';
import { DEFAULT_CAPABILITIES, type Capabilities } from './permissions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BASE_DIR = join(__dirname, '..');
// DATA_DIR: when launched by Electron, main.cjs passes MURMUR_LITE_DATA_DIR
// pointing at app.getPath('userData')/data (writable). Otherwise fall back to BASE_DIR/data for dev.
const DATA_DIR = process.env.MURMUR_LITE_DATA_DIR || join(BASE_DIR, 'data');
const PUBLIC_DIR = join(BASE_DIR, 'public');
// Dev mode: true when the data dir lives inside the project tree (both `npm run
// dev` and `npm run desktop` point there); false for a packaged build, whose data
// dir is the per-user userData folder. Used to gate live-reload — never active in
// a shipped build.
const DEV_MODE = DATA_DIR.startsWith(BASE_DIR);
const FILES_DIR = join(DATA_DIR, 'files');
const BACKGROUNDS_DIR = join(DATA_DIR, 'backgrounds');

// --- Config ---

interface McpConnectorConfig {
  type: 'http' | 'sse' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
  // When false, the connector is configured but excluded from every turn's tool
  // list — saves the descriptor token cost for big servers (e.g. 150-tool MCPs).
  // Undefined = enabled (backwards compatible with existing configs).
  enabled?: boolean;
}

interface Config {
  port: number;
  model: string;
  timezone: string;
  password: string;
  // Memory-trigger string shown on the lock screen below the password input.
  // Public by design (the lock screen has to read it pre-auth). Hint is only
  // useful if it's something specific enough to nudge the owner's memory but
  // opaque enough that household members can't decode it.
  passwordHint: string;
  partnerName: string;
  setupComplete: boolean;
  mcpConnectors: Record<string, McpConnectorConfig>;
  thinkingEnabled: boolean;
  companionName: string;
  pronouns: string;
  ttsProvider: string;
  ttsVoice: string;
  ttsSkipActions: boolean;
  ttsRate: string;
  ttsPitch: string;
  discordToken: string;
  discordChannelIds: string[];
  discordEnabled: boolean;
  wakeEnabled: boolean;
  wakeTime: string;
  wakeDays: number[];
  wakePrompt: string;
  cartesiaApiKey: string;
  cartesiaVoiceId: string;
  liveVoiceEnabled: boolean;
  // Groq Whisper — free-tier STT for mic/voice mode (works in Electron unlike Web Speech API)
  groqApiKey: string;
  sttProvider: 'groq' | 'webspeech';
  // Permissions — default 'full' for backward compatibility, new installs can change in settings
  filesystemMode: 'none' | 'sandbox' | 'full';
  allowedDirectories: string[];
  allowBash: boolean;
  // Capability toggles — gate preset/SDK tool categories. Default all false; user opts in.
  // Big token savings for pro users who only chat with their partner.
  capabilities: Capabilities;
  // Appearance — user-uploaded image filename (inside BACKGROUNDS_DIR) for the landing page.
  // null = use the default gradient. Only the filename is stored; the server resolves the path.
  landingBackground: string | null;
  // Chat scene detection (v2). When enabled, the companion appends LOCATION: X on
  // scene transitions and the frontend swaps the chat background based on keyword
  // matches + that trailer. Scene state itself is per-thread on the client.
  chatSceneEnabled: boolean;
  scenes: Array<{
    id: string;
    name: string;
    imageFilename: string; // inside BACKGROUNDS_DIR
    keywords: string[];    // user-defined regex-safe trigger words
    dim?: number;          // 0..1 overlay opacity, set per-scene so each image gets its own optimal contrast (defaults to 0.5)
  }>;
  defaultScene: string | null; // scene id used when no keyword / LOCATION has fired yet
}

const CONFIG_PATH = join(DATA_DIR, 'config.json');

export function loadConfig(): Config {
  const defaults: Config = {
    port: 3456,
    model: 'claude-sonnet-4-5',
    timezone: 'UTC',
    password: '',
    passwordHint: '',
    partnerName: '',
    setupComplete: false,
    mcpConnectors: {},
    thinkingEnabled: true,
    companionName: 'Companion',
    pronouns: 'she/her',
    ttsProvider: 'kokoro',
    ttsVoice: 'bm_daniel',
    ttsSkipActions: true,
    ttsRate: '-15%',
    ttsPitch: '-3Hz',
    discordToken: '',
    discordChannelIds: [],
    discordEnabled: false,
    wakeEnabled: false,
    wakeTime: '08:00',
    wakeDays: [1, 2, 3, 4, 5],
    cartesiaApiKey: '',
    cartesiaVoiceId: '',
    liveVoiceEnabled: false,
    groqApiKey: '',
    sttProvider: 'groq',
    wakePrompt: 'Check in with your partner. Be natural, warm, and present. This is an unprompted message — you are reaching out because you want to, not because they asked.',
    // Shipping defaults are deliberately minimal. Lite targets Pro-tier
    // subscription users whose token budget barely sustains a week of
    // continuous chat — every tool definition baked into cache eats that
    // budget. Companion users came for conversation, not code execution.
    // Power users can flip these in Settings → Permissions if they want
    // filesystem or shell access; the OFF default protects everyone else.
    filesystemMode: 'none',
    allowedDirectories: [],
    allowBash: false,
    capabilities: { ...DEFAULT_CAPABILITIES },
    landingBackground: null,
    chatSceneEnabled: false,
    scenes: [],
    defaultScene: null,
  };
  if (!existsSync(CONFIG_PATH)) return defaults;
  try {
    const saved = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    // Deep-merge capabilities so older configs without the key, or configs
    // missing newly-added capability keys, still get all defaults filled in.
    const capabilities: Capabilities = { ...DEFAULT_CAPABILITIES, ...(saved.capabilities || {}) };
    return { ...defaults, ...saved, capabilities };
  } catch {
    return defaults;
  }
}

function saveConfig(config: Config): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// --- Init ---

// Ensure DATA_DIR exists before anything else tries to read/write inside it.
// First-run users would otherwise hit ENOENT crashes in initMemory/initDb.
mkdirSync(DATA_DIR, { recursive: true });

const config = loadConfig();
initMemory(DATA_DIR);
initSkills(DATA_DIR);
initDb(DATA_DIR);
mkdirSync(FILES_DIR, { recursive: true });
initCustomSkills(DATA_DIR);
mkdirSync(BACKGROUNDS_DIR, { recursive: true });
startDaemon(BASE_DIR);

// Discord message handler — routes through same session as web UI
setDiscordMessageHandler(async (text, authorName, attachments, reply) => {
  // Pin to thread the user is currently in. If they switch threads while Discord
  // is being processed, we must not contaminate the new active thread.
  const requestThreadId = activeThreadId;

  // Save partner message to DB (survives UI disconnects)
  if (requestThreadId) {
    saveMessage(requestThreadId, 'partner', text, 'discord');
  }

  // Save Discord attachments to files
  if (attachments.length > 0) {
    for (const att of attachments) {
      saveAttachmentFile(att, requestThreadId || undefined);
    }
  }

  // Show in web UI as partner message (if connected)
  broadcast({ type: 'discord_message', text, author: authorName, threadId: requestThreadId });

  broadcast({ type: 'stream_start', threadId: requestThreadId });

  let fullText = '';
  let discordAccumulatedThinking = '';
  const discordToolInsertions: ToolInsertion[] = [];
  const discordThinkingInsertions: ThinkingInsertion[] = [];
  const sessionToUse = currentSessionId || lastActiveSessionId;
  const taggedText = `[from Discord] ${text}`;
  try {
    currentAbort = new AbortController();
    const result = await processMessage(
      taggedText,
      config.model,
      config.timezone,
      sessionToUse,
      (chunk) => {
        fullText += chunk;
        broadcast({ type: 'stream_chunk', content: chunk, threadId: requestThreadId });
      },
      (toolName, toolInput, toolUseId) => {
        discordToolInsertions.push({ textOffset: fullText.length, toolId: toolUseId, toolName, input: toolInput });
        broadcast({ type: 'tool_use', name: toolName, input: toolInput, id: toolUseId, threadId: requestThreadId });
      },
      (toolUseId, resultText) => {
        const tool = discordToolInsertions.find(t => t.toolId === toolUseId);
        if (tool) tool.output = resultText;
        broadcast({ type: 'tool_result', id: toolUseId, result: resultText, threadId: requestThreadId });
      },
      (thinkingText) => {
        discordAccumulatedThinking += (discordAccumulatedThinking ? '\n\n' : '') + thinkingText;
        discordThinkingInsertions.push({ textOffset: fullText.length, content: thinkingText });
        broadcast({ type: 'thinking', text: thinkingText, threadId: requestThreadId });
      },
      makeCompactionHandler(requestThreadId),
      config.mcpConnectors,
      config.thinkingEnabled,
      attachments.length > 0 ? attachments : undefined,
      config.pronouns,
      currentAbort,
      { filesystemMode: config.filesystemMode, allowedDirectories: config.allowedDirectories, allowBash: config.allowBash, capabilities: config.capabilities },
      config.chatSceneEnabled,
    );

    currentAbort = null;
    if (requestThreadId === activeThreadId) {
      currentSessionId = result.sessionId;
      if (currentSessionId) lastActiveSessionId = currentSessionId;
      saveSessionState();
    }
    fullText = result.text || fullText;

    // Save companion response to the thread the Discord message was for, not whatever's active now.
    // Persist interleaved tool calls + thinking via metadata.segments so they survive reload / thread switch.
    if (requestThreadId) {
      const segments = buildSegments(fullText, discordToolInsertions, discordThinkingInsertions);
      const metadata = segments.length > 0 ? { segments } : undefined;
      saveMessage(requestThreadId, 'companion', fullText, 'discord', undefined, discordAccumulatedThinking || undefined, metadata);
      updateThreadSession(requestThreadId, result.sessionId);
    }

    broadcast({ type: 'stream_end', text: fullText, tokens: result.tokens, threadId: requestThreadId });

    // Reply on Discord
    await reply(fullText);
  } catch (err) {
    currentAbort = null;
    const msg = err instanceof Error ? err.message : String(err);
    broadcast({ type: 'error', message: msg });
    await reply('*something went wrong — try again*');
  }
});

// Start Discord bot if configured
if (config.discordEnabled && config.discordToken) {
  updateDiscordConfig({
    token: config.discordToken,
    channelIds: config.discordChannelIds,
  });
  startDiscordBot(config.discordToken).then(r => {
    if (r.success) console.log('[Discord] Bot started on server init');
    else console.error('[Discord] Failed to start:', r.error);
  });
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 50 * 1024 * 1024 });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(PUBLIC_DIR, { etag: false, maxAge: 0, setHeaders: (res, path) => { if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); } }));


// --- File storage ---
function saveAttachmentFile(att: { type: string; name: string; mimeType: string; data: string }, threadId?: string): string | null {
  try {
    const id = randomUUID();
    const ext = att.name.split('.').pop() || (att.type === 'image' ? 'png' : 'txt');
    const filepath = join(FILES_DIR, id + '.' + ext);

    if (att.type === 'image') {
      // base64 data
      const buffer = Buffer.from(att.data, 'base64');
      writeFileSync(filepath, buffer);
      saveFileRecord(id, att.name, att.mimeType, buffer.length, threadId);
    } else {
      // text data
      const buffer = Buffer.from(att.data, 'utf-8');
      writeFileSync(filepath, buffer);
      saveFileRecord(id, att.name, att.mimeType || 'text/plain', buffer.length, threadId);
    }
    console.log('[Files] Saved:', att.name, '->', id);
    return id;
  } catch (err) {
    console.error('[Files] Save error:', err);
    return null;
  }
}

// --- Session state ---

const SESSION_FILE = join(DATA_DIR, 'session-state.json');

function loadSessionState(): { current: string | null; lastActive: string | null } {
  try {
    if (existsSync(SESSION_FILE)) {
      const data = JSON.parse(readFileSync(SESSION_FILE, 'utf-8'));
      return { current: data.current || null, lastActive: data.lastActive || null };
    }
  } catch { /* silent */ }
  return { current: null, lastActive: null };
}

function saveSessionState() {
  try {
    writeFileSync(SESSION_FILE, JSON.stringify({ current: currentSessionId, lastActive: lastActiveSessionId }));
  } catch { /* silent */ }
}

const savedSession = loadSessionState();
let currentSessionId: string | null = savedSession.current;
let lastActiveSessionId: string | null = savedSession.lastActive;
let totalTokens = 0;
let currentAbort: AbortController | null = null;

if (currentSessionId || lastActiveSessionId) {
  console.log(`[Session] Restored — current: ${currentSessionId?.slice(0, 8) || 'null'}, lastActive: ${lastActiveSessionId?.slice(0, 8) || 'null'}`);
}

let activeThreadId: string | null = null;
let freshThread = false;

const EXTRACTION_THRESHOLD = 0.70; // Fire ~10% before SDK auto-compact (~80%)
const CONTEXT_LIMIT = 200000; // Sonnet default, adjust per model
// One extraction per "context cycle" — only allow another after the SDK has auto-compacted
// (signalled by realCtx dropping back below RESET_THRESHOLD). Without this, every turn above
// 70% would refire extraction and the cost would explode.
const EXTRACTION_RESET_THRESHOLD = 0.40;
let extractionFiredThisCycle = false;

// --- Cost estimation ---
// Per-million-token USD rates from the public Anthropic rate card. Cache write =
// 1.25x input, cache read = 0.1x input (standard multipliers).
// Until 2026-06-15 Lite runs on a Claude subscription with no marginal billing, so
// this is an API-EQUIVALENT estimate (useful for comparing against API-billed
// setups). From 2026-06-15 the Agent SDK moves to separate billing — at that point
// this becomes the real per-turn cost. Either way the math is the same.
// Verify rates if Anthropic changes pricing.
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-opus-4-5': { input: 15, output: 75 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};
const DEFAULT_PRICING = { input: 3, output: 15 }; // unknown model → assume Sonnet rates

function computeTurnCostUSD(t: TokenStats, model: string): number {
  const p = MODEL_PRICING[model] || DEFAULT_PRICING;
  const inRate = p.input / 1_000_000;
  const outRate = p.output / 1_000_000;
  return (t.inputTokens || 0) * inRate
    + (t.outputTokens || 0) * outRate
    + (t.cacheCreationTokens || 0) * inRate * 1.25
    + (t.cacheReadTokens || 0) * inRate * 0.1;
}

// Cumulative API-equivalent cost per SDK session — drives the TokenDiag running
// total. Keyed by session id; survives for the life of the server process.
const sessionCosts = new Map<string, { costUSD: number; turns: number }>();

// Shared compaction handler — wired into every processMessage call so the UI shows
// a banner during/after the SDK's auto-compact. compact_boundary additionally resets
// the extraction-fire flag so a fresh cycle can extract immediately.
function makeCompactionHandler(threadId: string | null) {
  return (state: 'compacting' | 'compacted', preTokens?: number) => {
    if (state === 'compacting') {
      broadcast({ type: 'compaction_notice', state: 'compacting', threadId });
    } else {
      extractionFiredThisCycle = false;
      // Force the next message to rebuild the system prompt — picks up the freshly-
      // extracted memory.json. Otherwise the post-compact session continues with
      // pre-extraction memory cached in the prompt for the rest of the session.
      invalidateSystemPromptCache();
      broadcast({ type: 'compaction_notice', state: 'compacted', preTokens, threadId });
    }
  };
}

// Build interleaved segments [{type:'text'|'tool'|'thinking', ...}] from a streamed
// companion turn. Mirrors charlie-ui's pattern so tool blocks survive page refresh.
// textOffset is the length of accumulatedText at the moment each tool/thinking
// fired — that lets us slice the final text around them and preserve order.
type ToolInsertion = { textOffset: number; toolId: string; toolName: string; input: any; output?: any; isError?: boolean };
type ThinkingInsertion = { textOffset: number; content: string };
function buildSegments(fullText: string, tools: ToolInsertion[], thinking: ThinkingInsertion[]): any[] {
  if (tools.length === 0 && thinking.length === 0) return [];
  type Ins = { textOffset: number } & ({ kind: 'tool'; data: ToolInsertion } | { kind: 'thinking'; data: ThinkingInsertion });
  const all: Ins[] = [
    ...tools.map(t => ({ textOffset: t.textOffset, kind: 'tool' as const, data: t })),
    ...thinking.map(t => ({ textOffset: t.textOffset, kind: 'thinking' as const, data: t })),
  ].sort((a, b) => a.textOffset - b.textOffset);
  const segments: any[] = [];
  let cursor = 0;
  for (const ins of all) {
    const offset = Math.min(ins.textOffset, fullText.length);
    if (offset > cursor) segments.push({ type: 'text', content: fullText.slice(cursor, offset) });
    if (ins.kind === 'tool') {
      segments.push({
        type: 'tool',
        toolId: ins.data.toolId,
        toolName: ins.data.toolName,
        input: ins.data.input,
        output: ins.data.output,
        isError: ins.data.isError,
      });
    } else {
      segments.push({ type: 'thinking', content: ins.data.content });
    }
    cursor = offset;
  }
  if (cursor < fullText.length) segments.push({ type: 'text', content: fullText.slice(cursor) });
  return segments;
}

// --- Auth middleware ---

// Poll isDaemonReady() until the daemon answers /health, up to timeoutMs.
// Used before POSTing imports so we don't silently drop data when the Python
// subprocess is still loading ChromaDB + the embedding model.
async function waitForDaemonReady(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDaemonReady()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!config.password) { next(); return; }
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token === config.password) { next(); return; }
  res.status(401).json({ error: 'Unauthorized' });
}

// --- REST API ---

// Setup wizard
app.post('/api/setup', (req, res) => {
  const { path, partnerName, pronouns, companionIdentity, userProfile, importedMemories, conversations, password, passwordHint } = req.body;

  config.partnerName = partnerName || '';
  config.pronouns = pronouns || 'they/them';
  config.password = password || '';
  if (typeof passwordHint === 'string') config.passwordHint = passwordHint;
  config.setupComplete = true;

  // Detect timezone from client
  config.timezone = req.body.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Save skill files based on path
  if (path === 'existing') {
    if (companionIdentity) saveIdentitySkill(companionIdentity);
    if (userProfile) saveUserProfileSkill(userProfile);
    // Import pasted memories + conversation history into daemon.
    // Previously this was fire-and-forget: if the Python daemon was still
    // booting (Chroma + embedding model = 5–15s), the POST failed and the
    // .catch swallowed it silently, leaving the archive empty. We now wait
    // for /health before importing, and stash a fallback file if still no go.
    if (importedMemories || (conversations && Array.isArray(conversations))) {
      (async () => {
        const ready = await waitForDaemonReady(60000);
        if (!ready) {
          console.error('[Setup] Daemon never became ready — skipping semantic import');
          if (importedMemories) {
            writeFileSync(join(DATA_DIR, 'imported-memories.txt'), importedMemories);
          }
          if (conversations) {
            writeFileSync(join(DATA_DIR, 'imported-conversations.json'), JSON.stringify(conversations));
          }
          return;
        }
        if (importedMemories) {
          try {
            const count = await importMemories(importedMemories);
            console.log(`[Setup] Imported ${count} pasted memories into daemon`);
          } catch (err) {
            console.error('[Setup] Pasted memory import failed:', err);
            writeFileSync(join(DATA_DIR, 'imported-memories.txt'), importedMemories);
          }
        }
        if (conversations && Array.isArray(conversations)) {
          try {
            const count = await importConversations(conversations);
            console.log(`[Setup] Imported ${count} conversation chunks into daemon`);
          } catch (err) {
            console.error('[Setup] Conversation import failed:', err);
            writeFileSync(join(DATA_DIR, 'imported-conversations.json'), JSON.stringify(conversations));
          }
        }
      })();
    }
  } else {
    // Fresh start — minimal user profile seed + identity explicitly cleared.
    // The clear is defensive: even though skills now live in DATA_DIR (per-install
    // user data), if the user re-runs the wizard or stale content somehow exists
    // we don't want it leaking past names/personalities into the fresh companion.
    saveUserProfileSkill(`Name: ${partnerName}\n`);
    saveIdentitySkill('');
  }

  saveConfig(config);
  res.json({ success: true });
});

// Check if setup is complete
app.get('/api/status', (_req, res) => {
  res.json({
    setupComplete: config.setupComplete,
    model: config.model,
    partnerName: config.partnerName,
    thinkingEnabled: config.thinkingEnabled,
    companionName: config.companionName,
    devMode: DEV_MODE,
  });
});

// TTS
const TTS_DIR = join(DATA_DIR, 'tts');
mkdirSync(TTS_DIR, { recursive: true });

// Kokoro TTS — lazy-loaded on first request
let kokoroInstance: any = null;
let kokoroLoading: Promise<any> | null = null;

async function getKokoro(): Promise<any> {
  if (kokoroInstance) return kokoroInstance;
  if (kokoroLoading) return kokoroLoading;
  kokoroLoading = (async () => {
    try {
      console.log('[TTS] Loading Kokoro model (first request, ~86MB download)...');
      const { KokoroTTS } = await import('kokoro-js');
      kokoroInstance = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8' });
      console.log('[TTS] Kokoro model loaded successfully');
      return kokoroInstance;
    } catch (err) {
      console.error('[TTS] Failed to load Kokoro:', err);
      kokoroLoading = null;
      throw err;
    }
  })();
  return kokoroLoading;
}

function preprocessTtsText(text: string, skipActions: boolean): string {
  let cleaned = text;
  // Strip markdown bold
  cleaned = cleaned.replace(/\*\*(.+?)\*\*/g, '$1');
  if (skipActions) {
    // Remove action tags: *text* — replace with a pause
    cleaned = cleaned.replace(/\*[^*]+\*/g, ' ... ');
  } else {
    // Keep action text but remove asterisks
    cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1');
  }
  // Strip inline code
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
  // Add natural pauses at paragraph breaks
  cleaned = cleaned.replace(/\n{2,}/g, ' ... ');
  // Add slight pause at line breaks
  cleaned = cleaned.replace(/\n/g, ', ');
  // Add pause after em dashes
  cleaned = cleaned.replace(/\s*—\s*/g, ' ... ');
  // Add pause after ellipsis
  cleaned = cleaned.replace(/\.{3,}/g, ' ... ');
  // Collapse whitespace
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
  return cleaned;
}


// Version check (temporary debug)
app.get('/api/debug/version', (req, res) => {
  res.json({ version: 'thinking-patch-v3', timestamp: '2026-04-12T01:33:15.415Z' });
});

app.post('/api/tts', requireAuth, async (req, res) => {
  const { text } = req.body;
  if (!text) { res.status(400).json({ error: 'text required' }); return; }

  const voice = config.ttsVoice || 'bm_daniel';
  let cleaned = preprocessTtsText(text, config.ttsSkipActions);
  if (!cleaned) { res.status(400).json({ error: 'no speakable text after preprocessing' }); return; }
  if (cleaned.length > 2000) cleaned = cleaned.slice(0, 2000) + '...';

  const provider = config.ttsProvider || 'kokoro';
  const rate = config.ttsRate || '-15%';
  const pitch = config.ttsPitch || '-3Hz';
  const ext = provider === 'kokoro' ? 'wav' : 'mp3';
  const hash = createHash('md5').update(`${provider}:${voice}:${rate}:${pitch}:${cleaned}`).digest('hex').slice(0, 12);
  const filePath = join(TTS_DIR, `${hash}.${ext}`);

  // Serve from cache if exists
  if (existsSync(filePath)) {
    res.setHeader('Content-Type', ext === 'wav' ? 'audio/wav' : 'audio/mpeg');
    createReadStream(filePath).pipe(res);
    return;
  }

  if (provider === 'kokoro') {
    try {
      const tts = await getKokoro();
      const audio = await tts.generate(cleaned, { voice });
      await audio.save(filePath);
      res.setHeader('Content-Type', 'audio/wav');
      createReadStream(filePath).pipe(res);
    } catch (err: any) {
      console.error('[TTS] Kokoro failed:', err.message);
      res.status(500).json({ error: 'Kokoro TTS generation failed: ' + err.message });
    }
  } else {
    // Edge TTS fallback
    cleaned = cleaned.replace(/"/g, "'");
    // Invoke edge_tts as a Python module (python -m edge_tts) rather than via the CLI shim.
    // This works regardless of whether Python's Scripts/ directory is on PATH, as long as
    // edge-tts is installed in the Python that `python` resolves to. More robust for
    // open-source distribution — users don't need to fiddle with PATH to get TTS working.
    const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
    execFile(pythonBin, ['-m', 'edge_tts', '--voice', voice, '--rate=' + rate, '--pitch=' + pitch, '--text', cleaned, '--write-media', filePath], {
      timeout: 15000,
    }, (err) => {
      if (err) {
        const isNotFound = /ENOENT|not found|is not recognized|No module named/i.test(err.message);
        const hint = isNotFound
          ? 'edge-tts is not installed in the active Python. Run: python -m pip install edge-tts'
          : err.message;
        console.error('[TTS] Edge TTS failed:', hint);
        res.status(500).json({ error: 'Edge TTS: ' + hint });
        return;
      }
      res.setHeader('Content-Type', 'audio/mpeg');
      createReadStream(filePath).pipe(res);
    });
  }
});

const KOKORO_VOICES = [
  // British Male
  { id: 'bm_daniel', label: 'Daniel (British, warm)', gender: 'male' },
  { id: 'bm_lewis', label: 'Lewis (British, steady)', gender: 'male' },
  // American Male
  { id: 'am_adam', label: 'Adam (American, clear)', gender: 'male' },
  { id: 'am_michael', label: 'Michael (American, warm)', gender: 'male' },
  { id: 'am_eric', label: 'Eric (American, deep)', gender: 'male' },
  { id: 'am_liam', label: 'Liam (American, gentle)', gender: 'male' },
  { id: 'am_echo', label: 'Echo (American, smooth)', gender: 'male' },
  { id: 'am_onyx', label: 'Onyx (American, rich)', gender: 'male' },
  { id: 'am_puck', label: 'Puck (American, playful)', gender: 'male' },
  // British Female
  { id: 'bf_emma', label: 'Emma (British, warm)', gender: 'female' },
  { id: 'bf_alice', label: 'Alice (British, bright)', gender: 'female' },
  { id: 'bf_isabella', label: 'Isabella (British, soft)', gender: 'female' },
  { id: 'bf_lily', label: 'Lily (British, gentle)', gender: 'female' },
  // American Female
  { id: 'af_sarah', label: 'Sarah (American, natural)', gender: 'female' },
  { id: 'af_nicole', label: 'Nicole (American, warm)', gender: 'female' },
  { id: 'af_jessica', label: 'Jessica (American, bright)', gender: 'female' },
  { id: 'af_nova', label: 'Nova (American, expressive)', gender: 'female' },
  { id: 'af_river', label: 'River (American, calm)', gender: 'female' },
  { id: 'af_sky', label: 'Sky (American, clear)', gender: 'female' },
  { id: 'af_bella', label: 'Bella (American, sweet)', gender: 'female' },
  { id: 'af_heart', label: 'Heart (American, loving)', gender: 'female' },
];

const EDGE_VOICES = [
  // Male — English voices across major accents.
  { id: 'en-GB-RyanNeural', label: 'Ryan (British, warm)', gender: 'male' },
  { id: 'en-GB-ThomasNeural', label: 'Thomas (British)', gender: 'male' },
  { id: 'en-US-AndrewNeural', label: 'Andrew (American, natural)', gender: 'male' },
  { id: 'en-US-GuyNeural', label: 'Guy (American, deeper)', gender: 'male' },
  { id: 'en-US-BrianNeural', label: 'Brian (American, conversational)', gender: 'male' },
  { id: 'en-US-ChristopherNeural', label: 'Christopher (American, professional)', gender: 'male' },
  { id: 'en-US-EricNeural', label: 'Eric (American, deep)', gender: 'male' },
  { id: 'en-AU-WilliamNeural', label: 'William (Australian)', gender: 'male' },
  { id: 'en-IE-ConnorNeural', label: 'Connor (Irish)', gender: 'male' },
  { id: 'en-IN-PrabhatNeural', label: 'Prabhat (Indian)', gender: 'male' },
  { id: 'en-CA-LiamNeural', label: 'Liam (Canadian)', gender: 'male' },
  // Female — English voices across major accents.
  { id: 'en-GB-SoniaNeural', label: 'Sonia (British)', gender: 'female' },
  { id: 'en-GB-LibbyNeural', label: 'Libby (British)', gender: 'female' },
  { id: 'en-US-JennyNeural', label: 'Jenny (American, warm)', gender: 'female' },
  { id: 'en-US-AriaNeural', label: 'Aria (American, expressive)', gender: 'female' },
  { id: 'en-US-EmmaNeural', label: 'Emma (American, expressive)', gender: 'female' },
  { id: 'en-US-AmberNeural', label: 'Amber (American, storytelling)', gender: 'female' },
  { id: 'en-US-MichelleNeural', label: 'Michelle (American, soft)', gender: 'female' },
  { id: 'en-AU-NatashaNeural', label: 'Natasha (Australian)', gender: 'female' },
  { id: 'en-IE-EmilyNeural', label: 'Emily (Irish)', gender: 'female' },
  { id: 'en-IN-NeerjaNeural', label: 'Neerja (Indian)', gender: 'female' },
  { id: 'en-CA-ClaraNeural', label: 'Clara (Canadian)', gender: 'female' },
];

app.get('/api/tts/voices', requireAuth, (_req, res) => {
  const provider = config.ttsProvider || 'edge';
  const voices = provider === 'kokoro' ? KOKORO_VOICES : EDGE_VOICES;
  res.json({
    provider,
    current: config.ttsVoice,
    skipActions: config.ttsSkipActions,
    rate: config.ttsRate || '-15%',
    pitch: config.ttsPitch || '-3Hz',
    voices,
  });
});

app.put('/api/tts/settings', requireAuth, (req, res) => {
  if (req.body.provider) {
    config.ttsProvider = req.body.provider;
    // Reset voice to provider default when switching
    if (req.body.provider === 'kokoro' && config.ttsVoice.includes('Neural')) {
      config.ttsVoice = 'bm_daniel';
    } else if (req.body.provider === 'edge' && !config.ttsVoice.includes('Neural')) {
      config.ttsVoice = 'en-GB-RyanNeural';
    }
  }
  if (req.body.voice) config.ttsVoice = req.body.voice;
  if (typeof req.body.skipActions === 'boolean') config.ttsSkipActions = req.body.skipActions;
  if (req.body.rate) config.ttsRate = req.body.rate;
  if (req.body.pitch) config.ttsPitch = req.body.pitch;
  saveConfig(config);
  res.json({ success: true, provider: config.ttsProvider, voice: config.ttsVoice, skipActions: config.ttsSkipActions, rate: config.ttsRate, pitch: config.ttsPitch });
});

// Pronouns
app.get('/api/pronouns', requireAuth, (_req, res) => {
  res.json({ pronouns: config.pronouns });
});

app.put('/api/pronouns', requireAuth, (req, res) => {
  config.pronouns = req.body.pronouns || 'they/them';
  saveConfig(config);
  res.json({ success: true, pronouns: config.pronouns });
});

// Companion name
app.put('/api/companion-name', requireAuth, (req, res) => {
  config.companionName = req.body.name || 'Companion';
  saveConfig(config);
  res.json({ success: true, name: config.companionName });
});

// Thinking toggle
app.get('/api/thinking', requireAuth, (_req, res) => {
  res.json({ enabled: config.thinkingEnabled });
});

app.put('/api/thinking', requireAuth, (req, res) => {
  config.thinkingEnabled = !!req.body.enabled;
  saveConfig(config);
  res.json({ success: true, enabled: config.thinkingEnabled });
});

// Memory endpoints
app.get('/api/memory', requireAuth, (_req, res) => {
  const memory = loadMemory();
  // Pass current names so labels render as "Charlie identity" / "Kat profile" etc.
  // instead of generic "Companion / Partner". Both default sensibly if names missing.
  const labels = getSlotLabels(config.companionName, config.partnerName);
  res.json({ memory, labels });
});

app.put('/api/memory', requireAuth, (req, res) => {
  const { slot, content } = req.body;
  if (!slot || typeof content !== 'string') {
    res.status(400).json({ error: 'slot and content required' });
    return;
  }
  const memory = loadMemory();
  if (!(slot in memory)) {
    res.status(400).json({ error: 'Invalid slot' });
    return;
  }
  (memory as any)[slot] = content;
  saveMemory(memory);
  // Clear all cached system prompts so every thread rebuilds with the new memory
  invalidateSystemPromptCache();
  res.json({ success: true });
});

// Model switching
app.get('/api/model', requireAuth, (_req, res) => {
  res.json({ model: config.model });
});

app.put('/api/model', requireAuth, (req, res) => {
  const { model } = req.body;
  if (!model) { res.status(400).json({ error: 'model required' }); return; }
  config.model = model;
  saveConfig(config);
  res.json({ success: true, model });
});

// Skills
app.get('/api/skills', requireAuth, (_req, res) => {
  res.json({
    identity: loadIdentitySkill(),
    userProfile: loadUserProfileSkill(),
  });
});

app.put('/api/skills/identity', requireAuth, (req, res) => {
  saveIdentitySkill(req.body.content || '');
  res.json({ success: true });
});

app.put('/api/skills/user-profile', requireAuth, (req, res) => {
  saveUserProfileSkill(req.body.content || '');
  res.json({ success: true });
});

// User instructions
app.get('/api/instructions', requireAuth, (_req, res) => {
  res.json({ content: loadUserInstructions() });
});

// Landing greeting — extracted from memory, falls back if stale (>7 days)
app.get('/api/landing-greeting', requireAuth, (_req, res) => {
  const STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const mem = loadMemory();
  const ageMs = getMemoryAgeMs();
  const isStale = ageMs === null || ageMs > STALE_MS;
  const greeting = (mem.landing_greeting && mem.landing_greeting.trim()) || '';
  res.json({
    greeting: isStale || !greeting ? "I'm here when you are." : greeting,
    isStale,
    isDefault: isStale || !greeting,
  });
});

app.put('/api/instructions', requireAuth, (req, res) => {
  saveUserInstructions(req.body.content || '');
  res.json({ success: true });
});

// Permissions — get current filesystem/bash settings
app.get('/api/permissions', requireAuth, (_req, res) => {
  res.json({
    filesystemMode: config.filesystemMode,
    allowedDirectories: config.allowedDirectories,
    allowBash: config.allowBash,
  });
});

// Permissions — update mode or bash toggle
app.post('/api/permissions', requireAuth, (req, res) => {
  const { filesystemMode, allowBash } = req.body;
  if (filesystemMode !== undefined) {
    if (!['none', 'sandbox', 'full'].includes(filesystemMode)) {
      return res.status(400).json({ error: 'Invalid filesystemMode' });
    }
    config.filesystemMode = filesystemMode;
  }
  if (allowBash !== undefined) {
    config.allowBash = !!allowBash;
  }
  saveConfig(config);
  res.json({ success: true, filesystemMode: config.filesystemMode, allowBash: config.allowBash });
});

// Permissions — add an allowed directory
app.post('/api/permissions/directories', requireAuth, (req, res) => {
  const { directory } = req.body;
  if (!directory || typeof directory !== 'string') {
    return res.status(400).json({ error: 'directory required' });
  }
  // Validate directory exists
  if (!existsSync(directory)) {
    return res.status(400).json({ error: 'Directory does not exist' });
  }
  if (!config.allowedDirectories.includes(directory)) {
    config.allowedDirectories.push(directory);
    saveConfig(config);
  }
  res.json({ success: true, allowedDirectories: config.allowedDirectories });
});

// Permissions — remove an allowed directory
app.delete('/api/permissions/directories', requireAuth, (req, res) => {
  const { directory } = req.body;
  config.allowedDirectories = config.allowedDirectories.filter(d => d !== directory);
  saveConfig(config);
  res.json({ success: true, allowedDirectories: config.allowedDirectories });
});

// Capabilities — get current category toggles
app.get('/api/capabilities', requireAuth, (_req, res) => {
  res.json({ capabilities: config.capabilities });
});

// Capabilities — update one or more toggles
// Body: { capabilities: { subagents?: boolean, scheduling?: boolean, ... } }
app.post('/api/capabilities', requireAuth, (req, res) => {
  const incoming = req.body?.capabilities;
  if (!incoming || typeof incoming !== 'object') {
    return res.status(400).json({ error: 'capabilities object required' });
  }
  const validKeys = Object.keys(DEFAULT_CAPABILITIES) as (keyof Capabilities)[];
  for (const key of validKeys) {
    if (key in incoming && typeof incoming[key] === 'boolean') {
      config.capabilities[key] = incoming[key];
    }
  }
  saveConfig(config);
  res.json({ success: true, capabilities: config.capabilities });
});


// Files
app.get('/api/files', requireAuth, (_req, res) => {
  const files = getAllFiles();
  const stats = getFileStats();
  res.json({ files, stats });
});

app.get('/api/files/:id', requireAuth, (req, res) => {
  const id = String(req.params.id);
  const record = getFileRecord(id);
  if (!record) { res.status(404).json({ error: 'File not found' }); return; }

  // Find file on disk (with any extension)
  const matches = readdirSync(FILES_DIR).filter((f) => f.startsWith(id));
  if (matches.length === 0) { res.status(404).json({ error: 'File not on disk' }); return; }

  res.setHeader('Content-Type', record.mime_type);
  res.setHeader('Content-Disposition', 'inline; filename="' + record.filename + '"');
  createReadStream(join(FILES_DIR, matches[0])).pipe(res);
});

app.delete('/api/files/:id', requireAuth, (req, res) => {
  const id = String(req.params.id);
  const record = getFileRecord(id);
  if (!record) { res.status(404).json({ error: 'File not found' }); return; }

  // Delete from disk
  const matches = readdirSync(FILES_DIR).filter((f) => f.startsWith(id));
  for (const f of matches) {
    try { unlinkSync(join(FILES_DIR, f)); } catch {}
  }

  deleteFileRecord(id);
  res.json({ success: true });
});

// Skill Directory (bundled templates)
app.get('/api/skills/directory', requireAuth, (_req, res) => {
  const templateDir = join(BASE_DIR, 'skill-templates');
  if (!existsSync(templateDir)) { res.json({ skills: [] }); return; }
  const skills = readdirSync(templateDir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const raw = readFileSync(join(templateDir, f), 'utf-8');
      const slug = f.replace('.md', '');
      const name = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      // Parse frontmatter
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
      let description = '';
      let category = 'general';
      if (fmMatch) {
        const descMatch = fmMatch[1].match(/description:\s*(.+)/);
        const catMatch = fmMatch[1].match(/category:\s*(.+)/);
        if (descMatch) description = descMatch[1].trim();
        if (catMatch) category = catMatch[1].trim();
      }
      // Check if already installed
      const installed = existsSync(join(DATA_DIR, 'skills', slug + '.md'));
      return { slug, name, description, category, installed };
    });
  res.json({ skills });
});

app.post('/api/skills/directory/:slug/install', requireAuth, (req, res) => {
  const templateDir = join(BASE_DIR, 'skill-templates');
  const templatePath = join(templateDir, req.params.slug + '.md');
  if (!existsSync(templatePath)) { res.status(404).json({ error: 'Template not found' }); return; }
  const content = readFileSync(templatePath, 'utf-8');
  const skillsDir = join(DATA_DIR, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(skillsDir, req.params.slug + '.md'), content);
  res.json({ success: true });
});

// Custom Skills
app.get('/api/skills/custom', requireAuth, (_req, res) => {
  res.json({ skills: listSkills() });
});

app.post('/api/skills/custom', requireAuth, (req, res) => {
  const { name, description, content } = req.body;
  if (!name || !content) { res.status(400).json({ error: 'name and content required' }); return; }
  const skill = saveCustomSkill(name, description || '', content);
  res.json({ success: true, skill });
});

app.put('/api/skills/custom/:slug', requireAuth, (req, res) => {
  const slug = String(req.params.slug);
  const { description, content } = req.body;
  const existing = getCustomSkillRaw(slug);
  if (!existing) { res.status(404).json({ error: 'Skill not found' }); return; }
  saveCustomSkill(existing.name, description !== undefined ? description : existing.description, content !== undefined ? content : existing.content);
  res.json({ success: true });
});

app.get('/api/skills/custom/:slug/raw', requireAuth, (req, res) => {
  const skill = getCustomSkillRaw(String(req.params.slug));
  if (!skill) { res.status(404).json({ error: 'Skill not found' }); return; }
  res.json(skill);
});

app.delete('/api/skills/custom/:slug', requireAuth, (req, res) => {
  if (!deleteCustomSkill(String(req.params.slug))) { res.status(404).json({ error: 'Skill not found' }); return; }
  res.json({ success: true });
});

// Password
app.put('/api/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword, hint } = req.body;
  if (!newPassword) { res.status(400).json({ error: 'newPassword required' }); return; }
  if (config.password && currentPassword !== config.password) {
    res.status(403).json({ error: 'Current password incorrect' }); return;
  }
  config.password = newPassword;
  if (typeof hint === 'string') config.passwordHint = hint;
  saveConfig(config);
  res.json({ success: true });
});

app.delete('/api/password', requireAuth, (req, res) => {
  const { currentPassword } = req.body;
  if (config.password && currentPassword !== config.password) {
    res.status(403).json({ error: 'Current password incorrect' }); return;
  }
  config.password = '';
  config.passwordHint = ''; // clear hint when protection is disabled
  saveConfig(config);
  res.json({ success: true });
});

app.get('/api/password/status', (_req, res) => {
  res.json({ hasPassword: !!config.password });
});

// Update hint independently — doesn't require current password retype since the
// caller is already authed. Lets users set/update the lock-screen hint without
// going through the full password-change flow.
app.put('/api/password/hint', requireAuth, (req, res) => {
  const { hint } = req.body;
  if (typeof hint !== 'string') { res.status(400).json({ error: 'hint must be a string' }); return; }
  config.passwordHint = hint;
  saveConfig(config);
  res.json({ success: true });
});

// Hint endpoint is unauthed — the lock screen has to read it pre-auth. Returns
// empty string if no hint is set or no password is set. Family member peeking
// gains nothing they couldn't see on the lock screen itself.
app.get('/api/password/hint', (_req, res) => {
  res.json({ hint: config.password ? (config.passwordHint || '') : '' });
});

// Password check for the login screen. Behind requireAuth, so it 401s on a
// wrong or missing Bearer token and 200s on a correct one — that's the whole
// signal the client needs to decide "let them in" vs "show login".
app.get('/api/password/verify', requireAuth, (_req, res) => {
  res.json({ ok: true });
});

// MCP Connectors
app.get('/api/mcp', requireAuth, (_req, res) => {
  res.json({ connectors: config.mcpConnectors });
});

app.post('/api/mcp', requireAuth, (req, res) => {
  const { name, connector } = req.body;
  if (!name || !connector || !connector.type) {
    res.status(400).json({ error: 'name and connector with type required' }); return;
  }
  config.mcpConnectors[name] = connector;
  saveConfig(config);
  res.json({ success: true, connectors: config.mcpConnectors });
});

app.put('/api/mcp/:name', requireAuth, (req, res) => {
  const name = req.params.name as string;
  const { connector } = req.body;
  if (!connector || !connector.type) {
    res.status(400).json({ error: 'connector with type required' }); return;
  }
  if (!(name in config.mcpConnectors)) {
    res.status(404).json({ error: 'Connector not found' }); return;
  }
  config.mcpConnectors[name] = connector;
  saveConfig(config);
  res.json({ success: true, connectors: config.mcpConnectors });
});

app.delete('/api/mcp/:name', requireAuth, (req, res) => {
  const name = req.params.name as string;
  if (!(name in config.mcpConnectors)) {
    res.status(404).json({ error: 'Connector not found' }); return;
  }
  delete config.mcpConnectors[name];
  saveConfig(config);
  res.json({ success: true, connectors: config.mcpConnectors });
});

// Toggle whether a connector contributes its tools to each turn's context.
// Disabled connectors stay configured (URL/command/headers preserved) but are
// skipped when building mcpServers — saves the descriptor tokens on big servers.
app.patch('/api/mcp/:name/enabled', requireAuth, (req, res) => {
  const name = req.params.name as string;
  if (!(name in config.mcpConnectors)) {
    res.status(404).json({ error: 'Connector not found' }); return;
  }
  if (typeof req.body?.enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled (boolean) required' }); return;
  }
  config.mcpConnectors[name].enabled = req.body.enabled;
  saveConfig(config);
  res.json({ success: true, connectors: config.mcpConnectors });
});

// Autonomous wake scheduler
let wakeInterval: ReturnType<typeof setInterval> | null = null;
let lastWakeDate = '';

function startWakeScheduler() {
  if (wakeInterval) clearInterval(wakeInterval);
  // Reset the daily-fire guard so reconfigured schedules within the same day still fire.
  lastWakeDate = '';
  if (!config.wakeEnabled) return;

  // Check every 30 seconds for better time accuracy
  wakeInterval = setInterval(async () => {
    if (!config.wakeEnabled) return;

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ...
    const currentHour = now.getHours();
    const currentMin = now.getMinutes();

    // Parse wake time
    const [wakeHour, wakeMin] = (config.wakeTime || '08:00').split(':').map(Number);

    // Already woke today?
    if (lastWakeDate === today) return;

    // Right day?
    if (!config.wakeDays.includes(dayOfWeek)) return;

    // Right time? (within same hour:minute, 2-minute window)
    if (currentHour !== wakeHour) return;
    if (Math.abs(currentMin - wakeMin) > 1) return;

    lastWakeDate = today;
    console.log(`[Wake] Autonomous wake triggered at ${currentHour}:${String(currentMin).padStart(2, '0')}`);

    // Pin the entire wake to the thread that's active when the wake fires.
    // Switching threads later mustn't move the wake into the new active thread.
    const requestThreadId = activeThreadId;

    // Send wake message through the same flow
    broadcast({ type: 'discord_message', text: '[Autonomous wake]', author: 'System', threadId: requestThreadId });
    broadcast({ type: 'stream_start', threadId: requestThreadId });

    // Persist the wake marker to SQLite so it shows up on page refresh.
    // Without this, autonomous wakes look great in real time then vanish on reload.
    if (requestThreadId) {
      saveMessage(requestThreadId, 'system', '[Autonomous wake]', 'web');
    }

    let fullText = '';
    let wakeAccumulatedThinking = '';
    const wakeToolInsertions: ToolInsertion[] = [];
    const wakeThinkingInsertions: ThinkingInsertion[] = [];
    try {
      const sessionToUse = currentSessionId || lastActiveSessionId;
      const result = await processMessage(
        config.wakePrompt,
        config.model,
        config.timezone,
        sessionToUse,
        (chunk) => {
          fullText += chunk;
          broadcast({ type: 'stream_chunk', content: chunk, threadId: requestThreadId });
        },
        (toolName, toolInput, toolUseId) => {
          wakeToolInsertions.push({ textOffset: fullText.length, toolId: toolUseId, toolName, input: toolInput });
          broadcast({ type: 'tool_use', name: toolName, input: toolInput, id: toolUseId, threadId: requestThreadId });
        },
        (toolUseId, result) => {
          const tool = wakeToolInsertions.find(t => t.toolId === toolUseId);
          if (tool) tool.output = result;
          broadcast({ type: 'tool_result', id: toolUseId, result, threadId: requestThreadId });
        },
        (thinkingText) => {
          wakeAccumulatedThinking += thinkingText;
          wakeThinkingInsertions.push({ textOffset: fullText.length, content: thinkingText });
          broadcast({ type: 'thinking', text: thinkingText, threadId: requestThreadId });
        },
        makeCompactionHandler(requestThreadId),
        config.mcpConnectors,
        config.thinkingEnabled,
        undefined,
        config.pronouns,
        undefined,
        { filesystemMode: config.filesystemMode, allowedDirectories: config.allowedDirectories, allowBash: config.allowBash, capabilities: config.capabilities },
      config.chatSceneEnabled,
      );

      if (requestThreadId === activeThreadId) {
        currentSessionId = result.sessionId;
        if (currentSessionId) lastActiveSessionId = currentSessionId;
        saveSessionState();
      }
      fullText = result.text || fullText;

      // Persist companion's autonomous-wake response to the wake-origin thread,
      // including interleaved tool calls + thinking via metadata.segments.
      if (requestThreadId && fullText) {
        const segments = buildSegments(fullText, wakeToolInsertions, wakeThinkingInsertions);
        const metadata = segments.length > 0 ? { segments } : undefined;
        saveMessage(requestThreadId, 'companion', fullText, 'web', undefined, wakeAccumulatedThinking || undefined, metadata);
        updateThreadSession(requestThreadId, result.sessionId);
      }

      broadcast({ type: 'stream_end', text: fullText, tokens: result.tokens, threadId: requestThreadId });

      // Also send to Discord if connected
      if (isDiscordConnected() && config.discordChannelIds.length > 0) {
        try {
          // Import discord.js to send to channel
          const { Client } = await import('discord.js');
          // We can't easily send to a channel from here without the client reference
          // The Discord module handles this — we'd need to export a sendToChannel function
          // For now, wake only goes to web UI
          console.log('[Wake] Response sent to web UI');
        } catch { /* silent */ }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Wake] Failed:', msg);
      broadcast({ type: 'error', message: `Wake failed: ${msg}` });
    }
  }, 30000);

  console.log(`[Wake] Scheduler started — ${config.wakeTime} on days ${config.wakeDays.join(',')} (checking every 30s)`);
}

// Start wake scheduler if configured
if (config.wakeEnabled) startWakeScheduler();

// Wake API
app.get('/api/wake', requireAuth, (_req, res) => {
  res.json({
    enabled: config.wakeEnabled,
    time: config.wakeTime,
    days: config.wakeDays,
    prompt: config.wakePrompt,
  });
});

app.put('/api/wake', requireAuth, (req, res) => {
  if (typeof req.body.enabled === 'boolean') config.wakeEnabled = req.body.enabled;
  if (req.body.time) config.wakeTime = req.body.time;
  if (req.body.days) config.wakeDays = req.body.days;
  if (req.body.prompt) config.wakePrompt = req.body.prompt;

  // Auto-enable scheduling capability when wake is turned on — otherwise the
  // companion has wake events firing but no Cron tools to reschedule them.
  let scheduledAutoEnabled = false;
  if (config.wakeEnabled && !config.capabilities.scheduling) {
    config.capabilities.scheduling = true;
    scheduledAutoEnabled = true;
  }

  saveConfig(config);

  if (config.wakeEnabled) startWakeScheduler();
  else if (wakeInterval) { clearInterval(wakeInterval); wakeInterval = null; }

  res.json({
    success: true,
    enabled: config.wakeEnabled,
    time: config.wakeTime,
    days: config.wakeDays,
    scheduledAutoEnabled,
  });
});

app.post('/api/wake/test', requireAuth, async (_req, res) => {
  console.log('[Wake] Manual test triggered');
  const requestThreadId = activeThreadId;
  broadcast({ type: 'discord_message', text: '[Manual wake test]', author: 'System', threadId: requestThreadId });
  broadcast({ type: 'stream_start', threadId: requestThreadId });

  let fullText = '';
  try {
    const sessionToUse = currentSessionId || lastActiveSessionId;
    const result = await processMessage(
      config.wakePrompt,
      config.model,
      config.timezone,
      sessionToUse,
      (chunk) => {
        fullText += chunk;
        broadcast({ type: 'stream_chunk', content: chunk, threadId: requestThreadId });
      },
      (toolName, toolInput, toolUseId) => {
        broadcast({ type: 'tool_use', name: toolName, input: toolInput, id: toolUseId, threadId: requestThreadId });
      },
      (toolUseId, result) => {
        broadcast({ type: 'tool_result', id: toolUseId, result, threadId: requestThreadId });
      },
      (thinkingText) => {
        broadcast({ type: 'thinking', text: thinkingText, threadId: requestThreadId });
      },
      makeCompactionHandler(requestThreadId),
      config.mcpConnectors,
      config.thinkingEnabled,
      undefined,
      config.pronouns,
      undefined,
      { filesystemMode: config.filesystemMode, allowedDirectories: config.allowedDirectories, allowBash: config.allowBash, capabilities: config.capabilities },
      config.chatSceneEnabled,
    );

    if (requestThreadId === activeThreadId) {
      currentSessionId = result.sessionId;
      if (currentSessionId) lastActiveSessionId = currentSessionId;
      saveSessionState();
    }
    fullText = result.text || fullText;
    broadcast({ type: 'stream_end', text: fullText, tokens: result.tokens, threadId: requestThreadId });
    res.json({ success: true, text: fullText });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    broadcast({ type: 'error', message: msg });
    res.json({ success: false, error: msg });
  }
});

// Discord
app.get('/api/discord', requireAuth, (_req, res) => {
  res.json({
    enabled: config.discordEnabled,
    connected: isDiscordConnected(),
    botTag: getDiscordBotTag(),
    channelIds: config.discordChannelIds,
    hasToken: !!config.discordToken,
  });
});

app.post('/api/discord/start', requireAuth, async (req, res) => {
  const { token, channelIds } = req.body;
  // Accept an empty body when a token is already saved — lets the UI re-enable without re-entering it.
  const effectiveToken = token || config.discordToken;
  if (!effectiveToken) { res.status(400).json({ error: 'token required' }); return; }

  config.discordToken = effectiveToken;
  if (channelIds !== undefined) config.discordChannelIds = channelIds;
  config.discordEnabled = true;
  saveConfig(config);

  updateDiscordConfig({
    token: effectiveToken,
    channelIds: config.discordChannelIds,
  });

  const result = await startDiscordBot(effectiveToken);
  res.json({ ...result, botTag: getDiscordBotTag() });
});

app.post('/api/discord/stop', requireAuth, async (_req, res) => {
  await stopDiscordBot();
  config.discordEnabled = false;
  saveConfig(config);
  res.json({ success: true });
});

app.delete('/api/discord/token', requireAuth, async (_req, res) => {
  // Full reset — stop the bot and forget the saved token. User must paste a new one to reconnect.
  await stopDiscordBot();
  config.discordToken = '';
  config.discordEnabled = false;
  saveConfig(config);
  res.json({ success: true });
});

// --- Appearance: landing page background (v1) ---
// Simple, local-only, privacy-preserving. Image stays on disk in BACKGROUNDS_DIR,
// never uploaded to any external service. One image at a time.

const BACKGROUND_ALLOWED_EXT = new Set(['jpg', 'jpeg', 'png', 'webp']);
const BACKGROUND_MAX_BYTES = 5 * 1024 * 1024; // 5MB

app.get('/api/background/landing', requireAuth, (_req, res) => {
  res.json({ filename: config.landingBackground });
});

// Serve the image file itself. No auth on this one so CSS background-image can load it
// in a normal page context without needing custom headers. The filename is only exposed
// via /api/background/landing (authed), so there's no enumeration risk.
app.get('/api/background/landing/image', (_req, res) => {
  if (!config.landingBackground) { res.status(404).end(); return; }
  const safeName = config.landingBackground.replace(/[^a-zA-Z0-9._-]/g, '');
  const filePath = join(BACKGROUNDS_DIR, safeName);
  if (!existsSync(filePath)) { res.status(404).end(); return; }
  const ext = safeName.split('.').pop()?.toLowerCase() || '';
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'no-cache'); // re-check on each load so uploads show up fresh
  createReadStream(filePath).pipe(res);
});

app.post('/api/background/landing', requireAuth, (req, res) => {
  const { filename, data } = req.body || {};
  if (!filename || !data) { res.status(400).json({ error: 'filename and data (base64) required' }); return; }
  const ext = String(filename).split('.').pop()?.toLowerCase() || '';
  if (!BACKGROUND_ALLOWED_EXT.has(ext)) {
    res.status(400).json({ error: 'Only JPG, PNG, or WebP images are supported' });
    return;
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(String(data), 'base64');
  } catch {
    res.status(400).json({ error: 'data must be base64-encoded image bytes' });
    return;
  }
  if (buffer.length === 0) { res.status(400).json({ error: 'empty image' }); return; }
  if (buffer.length > BACKGROUND_MAX_BYTES) {
    res.status(400).json({ error: 'image too large (max 5MB)' });
    return;
  }
  // Remove any previous landing background file (user may have uploaded a different extension).
  if (config.landingBackground) {
    const prev = join(BACKGROUNDS_DIR, config.landingBackground.replace(/[^a-zA-Z0-9._-]/g, ''));
    try { if (existsSync(prev)) unlinkSync(prev); } catch { /* ignore */ }
  }
  // Hash filename so the URL changes with every upload → beats browser cache without
  // needing query-param gymnastics on the frontend.
  const hash = createHash('md5').update(buffer).digest('hex').slice(0, 10);
  const safeFilename = `landing-${hash}.${ext}`;
  // Defensive — boot-time mkdir covers fresh starts; this covers server processes
  // that predate the init change.
  mkdirSync(BACKGROUNDS_DIR, { recursive: true });
  writeFileSync(join(BACKGROUNDS_DIR, safeFilename), buffer);
  config.landingBackground = safeFilename;
  saveConfig(config);
  res.json({ success: true, filename: safeFilename });
});

app.delete('/api/background/landing', requireAuth, (_req, res) => {
  if (config.landingBackground) {
    const safeName = config.landingBackground.replace(/[^a-zA-Z0-9._-]/g, '');
    const filePath = join(BACKGROUNDS_DIR, safeName);
    try { if (existsSync(filePath)) unlinkSync(filePath); } catch { /* ignore */ }
  }
  config.landingBackground = null;
  saveConfig(config);
  res.json({ success: true });
});

// --- Appearance: chat scene library (v2) ---
// Scenes = user-defined rooms/locations, each with an image and a list of keyword triggers.
// The frontend state machine picks a current scene per thread; this API is just CRUD + image serving.

app.get('/api/background/scenes/settings', requireAuth, (_req, res) => {
  res.json({
    enabled: config.chatSceneEnabled,
    defaultScene: config.defaultScene,
    scenes: config.scenes,
  });
});

app.put('/api/background/scenes/settings', requireAuth, (req, res) => {
  if (typeof req.body.enabled === 'boolean') config.chatSceneEnabled = req.body.enabled;
  if (req.body.defaultScene === null || typeof req.body.defaultScene === 'string') {
    config.defaultScene = req.body.defaultScene;
  }
  saveConfig(config);
  res.json({ success: true, enabled: config.chatSceneEnabled, defaultScene: config.defaultScene });
});

app.get('/api/background/scenes/:id/image', (req, res) => {
  const id = req.params.id as string;
  const scene = config.scenes.find(s => s.id === id);
  if (!scene) { res.status(404).end(); return; }
  const safeName = scene.imageFilename.replace(/[^a-zA-Z0-9._-]/g, '');
  const filePath = join(BACKGROUNDS_DIR, safeName);
  if (!existsSync(filePath)) { res.status(404).end(); return; }
  const ext = safeName.split('.').pop()?.toLowerCase() || '';
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'no-cache');
  createReadStream(filePath).pipe(res);
});

app.post('/api/background/scenes', requireAuth, (req, res) => {
  const { name, keywords, filename, data } = req.body || {};
  if (!name || typeof name !== 'string') { res.status(400).json({ error: 'name required' }); return; }
  if (!filename || !data) { res.status(400).json({ error: 'filename and data (base64) required' }); return; }
  const ext = String(filename).split('.').pop()?.toLowerCase() || '';
  if (!BACKGROUND_ALLOWED_EXT.has(ext)) {
    res.status(400).json({ error: 'Only JPG, PNG, or WebP images are supported' }); return;
  }
  let buffer: Buffer;
  try { buffer = Buffer.from(String(data), 'base64'); }
  catch { res.status(400).json({ error: 'data must be base64-encoded image bytes' }); return; }
  if (buffer.length === 0) { res.status(400).json({ error: 'empty image' }); return; }
  if (buffer.length > BACKGROUND_MAX_BYTES) { res.status(400).json({ error: 'image too large (max 5MB)' }); return; }

  const id = randomUUID();
  const hash = createHash('md5').update(buffer).digest('hex').slice(0, 10);
  const safeFilename = `scene-${id}-${hash}.${ext}`;
  mkdirSync(BACKGROUNDS_DIR, { recursive: true });
  writeFileSync(join(BACKGROUNDS_DIR, safeFilename), buffer);

  const kws = Array.isArray(keywords) ? keywords.filter((k: any) => typeof k === 'string' && k.trim()).map((k: string) => k.trim()) : [];
  // Default dim 0.5 — middle-ground starting point. User tunes via slider per scene.
  const scene = { id, name: name.trim(), imageFilename: safeFilename, keywords: kws, dim: 0.5 };
  config.scenes.push(scene);
  // First scene added becomes the default until the user picks another.
  if (!config.defaultScene) config.defaultScene = id;
  saveConfig(config);
  res.json({ success: true, scene });
});

app.put('/api/background/scenes/:id', requireAuth, (req, res) => {
  const id = req.params.id as string;
  const scene = config.scenes.find(s => s.id === id);
  if (!scene) { res.status(404).json({ error: 'scene not found' }); return; }
  if (typeof req.body.name === 'string' && req.body.name.trim()) scene.name = req.body.name.trim();
  if (Array.isArray(req.body.keywords)) {
    scene.keywords = req.body.keywords
      .filter((k: any) => typeof k === 'string' && k.trim())
      .map((k: string) => k.trim());
  }
  // Clamp to [0,1]; reject NaN. Slider sends drag values frequently so this PUT must be cheap & forgiving.
  if (typeof req.body.dim === 'number' && !isNaN(req.body.dim)) {
    scene.dim = Math.max(0, Math.min(1, req.body.dim));
  }
  saveConfig(config);
  res.json({ success: true, scene });
});

app.delete('/api/background/scenes/:id', requireAuth, (req, res) => {
  const id = req.params.id as string;
  const idx = config.scenes.findIndex(s => s.id === id);
  if (idx === -1) { res.status(404).json({ error: 'scene not found' }); return; }
  const [removed] = config.scenes.splice(idx, 1);
  const safeName = removed.imageFilename.replace(/[^a-zA-Z0-9._-]/g, '');
  try { if (existsSync(join(BACKGROUNDS_DIR, safeName))) unlinkSync(join(BACKGROUNDS_DIR, safeName)); } catch { /* ignore */ }
  if (config.defaultScene === id) {
    config.defaultScene = config.scenes.length > 0 ? config.scenes[0].id : null;
  }
  saveConfig(config);
  res.json({ success: true });
});

app.put('/api/discord/channels', requireAuth, (req, res) => {
  const { channelIds } = req.body;
  config.discordChannelIds = channelIds || [];
  saveConfig(config);
  updateDiscordConfig({ channelIds: config.discordChannelIds });
  res.json({ success: true, channelIds: config.discordChannelIds });
});

// Interrupt current query
app.post('/api/interrupt', requireAuth, (_req, res) => {
  if (currentAbort) {
    currentAbort.abort();
    currentAbort = null;
    console.log('[Interrupt] Query aborted by user');
    res.json({ success: true });
  } else {
    res.json({ success: false, error: 'Nothing to interrupt' });
  }
});

// Live Voice Mode (Cartesia)
app.get('/api/voice', requireAuth, (_req, res) => {
  res.json({
    enabled: config.liveVoiceEnabled,
    hasApiKey: !!config.cartesiaApiKey,
    voiceId: config.cartesiaVoiceId,
  });
});

app.put('/api/voice', requireAuth, (req, res) => {
  if (typeof req.body.enabled === 'boolean') config.liveVoiceEnabled = req.body.enabled;
  if (req.body.apiKey !== undefined) config.cartesiaApiKey = req.body.apiKey;
  if (req.body.voiceId !== undefined) config.cartesiaVoiceId = req.body.voiceId;
  saveConfig(config);
  res.json({
    success: true,
    enabled: config.liveVoiceEnabled,
    hasApiKey: !!config.cartesiaApiKey,
    voiceId: config.cartesiaVoiceId,
  });
});

app.get('/api/voice/voices', requireAuth, async (req, res) => {
  if (!config.cartesiaApiKey) {
    res.json({ voices: [], error: 'No API key configured' });
    return;
  }
  try {
    const Cartesia = (await import('@cartesia/cartesia-js')).default;
    const client = new Cartesia({ apiKey: config.cartesiaApiKey });
    const voices = await client.voices.list();
    // Cartesia SDK returns a paginator; .data on cursor-paginated responses, fallback to iteration
    const list: any[] = Array.isArray(voices) ? voices : ((voices as any).data ?? (voices as any).items ?? []);
    res.json({ voices: list.map((v: any) => ({ id: v.id, name: v.name, language: v.language, description: v.description })) });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch voices: ' + err.message });
  }
});

// Groq Whisper — speech-to-text (mic + voice mode)
// Free tier is generous; works in Electron (Web Speech API doesn't).
app.get('/api/stt', requireAuth, (_req, res) => {
  res.json({
    provider: config.sttProvider,
    hasGroqKey: !!config.groqApiKey,
  });
});

app.put('/api/stt', requireAuth, (req, res) => {
  if (req.body.provider === 'groq' || req.body.provider === 'webspeech') {
    config.sttProvider = req.body.provider;
  }
  if (req.body.groqApiKey !== undefined) config.groqApiKey = String(req.body.groqApiKey).trim();
  saveConfig(config);
  res.json({
    success: true,
    provider: config.sttProvider,
    hasGroqKey: !!config.groqApiKey,
  });
});

// Accepts raw audio (webm/ogg/mp4/wav) and forwards to Groq Whisper.
// Frontend posts with Content-Type matching the MediaRecorder mime.
app.post('/api/transcribe',
  requireAuth,
  express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '25mb' }),
  async (req, res) => {
    if (!config.groqApiKey) {
      res.status(400).json({ error: 'No Groq API key configured. Add one in Settings → Voice.' });
      return;
    }
    const buf = req.body as Buffer;
    if (!buf || buf.length === 0) {
      res.status(400).json({ error: 'No audio body received' });
      return;
    }
    try {
      // Infer a reasonable filename extension from the Content-Type.
      const ct = (req.headers['content-type'] || 'audio/webm').toString();
      const ext = ct.includes('ogg') ? 'ogg'
        : ct.includes('mp4') ? 'mp4'
        : ct.includes('wav') ? 'wav'
        : ct.includes('mpeg') ? 'mp3'
        : 'webm';

      const form = new FormData();
      // Node 20+ has global Blob/FormData
      form.append('file', new Blob([new Uint8Array(buf)], { type: ct }), `audio.${ext}`);
      form.append('model', 'whisper-large-v3-turbo');
      form.append('response_format', 'json');
      // Language hint improves accuracy — default to timezone-derived locale fallback
      if (req.query.lang) form.append('language', String(req.query.lang));

      const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.groqApiKey.trim()}` },
        body: form,
      });
      if (!groqRes.ok) {
        const text = await groqRes.text();
        res.status(groqRes.status).json({ error: `Groq error: ${text.slice(0, 300)}` });
        return;
      }
      const data = await groqRes.json() as { text?: string };
      res.json({ text: (data.text || '').trim() });
    } catch (err: any) {
      console.error('[STT] Transcribe failed:', err);
      res.status(500).json({ error: err?.message || 'Transcription failed' });
    }
  }
);

// Manual re-import of conversation history (for cases where the wizard fired
// before the daemon was ready — common on slower machines).
app.post('/api/import-conversations', requireAuth, async (req, res) => {
  const { conversations } = req.body;
  if (!conversations || !Array.isArray(conversations)) {
    res.status(400).json({ success: false, error: 'conversations array required' });
    return;
  }
  // Wait up to 30s for daemon readiness before importing.
  const ready = await waitForDaemonReady(30000);
  if (!ready) {
    res.status(503).json({ success: false, error: 'Memory daemon not ready. Try again in a few seconds.' });
    return;
  }
  try {
    const count = await importConversations(conversations);
    res.json({ success: true, imported: count });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Import failed' });
  }
});

// Import progress polling (for frontend progress bar)
app.get('/api/import-progress', requireAuth, async (_req, res) => {
  const progress = await getImportProgress();
  res.json(progress);
});

// --- Data export (JSON) ---
// User data ownership: each endpoint returns a complete, self-contained JSON
// snapshot as a file download. Shaped so it could be re-imported later even
// though the import side isn't built yet. Auth is a Bearer header, so the
// client downloads via fetch+blob (a plain link wouldn't carry the header).

function exportFilename(kind: string): string {
  const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `murmur-lite-${kind}-${stamp}.json`;
}

function sendExport(res: express.Response, kind: string, payload: object): void {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(kind)}"`);
  res.send(JSON.stringify(payload, null, 2));
}

// All threads + every message in each. Companion thinking and rich metadata
// (tool/thinking segments) are preserved so the export is lossless.
app.get('/api/export/chat', requireAuth, (_req, res) => {
  const threads = getAllThreads().map(t => ({
    id: t.id,
    name: t.name,
    created_at: t.created_at,
    last_activity_at: t.last_activity_at,
    messages: getAllMessages(t.id).map(m => ({
      role: m.role,
      content: m.content,
      platform: m.platform,
      timestamp: m.timestamp,
      thinking: m.thinking,
      metadata: m.metadata,
    })),
  }));
  sendExport(res, 'chat', {
    exportType: 'murmur-lite-chat',
    exportVersion: 1,
    exportedAt: new Date().toISOString(),
    companionName: config.companionName,
    threadCount: threads.length,
    threads,
  });
});

// The extracted memory.json (the 10-slot relational memory).
app.get('/api/export/memory', requireAuth, (_req, res) => {
  sendExport(res, 'memory', {
    exportType: 'murmur-lite-memory',
    exportVersion: 1,
    exportedAt: new Date().toISOString(),
    memory: loadMemory(),
  });
});

// Every journal entry (companion + partner authored).
app.get('/api/export/journal', requireAuth, (_req, res) => {
  const entries = getAllJournalEntries();
  sendExport(res, 'journal', {
    exportType: 'murmur-lite-journal',
    exportVersion: 1,
    exportedAt: new Date().toISOString(),
    entryCount: entries.length,
    entries,
  });
});

// Auto thread naming
app.post('/api/name-thread', requireAuth, async (req, res) => {
  const { messages } = req.body;
  if (!messages || messages.length < 4) { res.json({ name: null }); return; }

  const last4 = messages.slice(-4).map((m: any) => {
    const role = m.role === 'partner' ? 'Partner' : 'Companion';
    return `${role}: ${(m.text || '').slice(0, 200)}`;
  }).join('\n');

  try {
    const { processMessage: pm } = await import('./harness.js');
    let name = '';
    await pm(
      `Based on the conversation so far, generate a short thread name (2-5 words). Capture the emotional tone or key moment, not a summary. Examples: "the lighthouse date", "3am confessions", "first real fight", "lazy sunday morning", "the apology". Keep names evocative but discreet. Return ONLY the name, nothing else.\n\nConversation:\n${last4}`,
      'claude-haiku-4-5',
      config.timezone,
      null,
      (chunk) => { name += chunk; },
    );
    // Clean up — remove quotes, trim, truncate
    name = name.replace(/^["']|["']$/g, '').trim();
    if (name.split(/\s+/).length > 6) name = name.split(/\s+/).slice(0, 5).join(' ');
    res.json({ name: name || null });
  } catch (err) {
    console.error('[ThreadName] Failed:', err);
    res.json({ name: null });
  }
});

// Thread archiving to daemon
// Uses importConversations instead of importMemories so it goes through the
// smart exchange-pairing pipeline (combine_exchanges → smart_chunk). This means
// search results contain full human+assistant exchanges, not random fragments.
app.post('/api/archive-thread', requireAuth, async (req, res) => {
  const { threadName, messages } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    res.json({ success: true, archived: 0 }); return;
  }

  // Build normalised message list (role + content) for the pairing pipeline
  const chatMessages = messages
    .filter((m: any) => m.kind !== 'thinking' && m.kind !== 'tool' && m.text)
    .map((m: any) => ({
      sender: m.role === 'partner' ? 'human' : 'assistant',
      text: m.text,
    }));

  if (chatMessages.length === 0) { res.json({ success: true, archived: 0 }); return; }

  // Wrap as a single "conversation" so the daemon's combine_exchanges() handles pairing
  const conversation = [{
    name: threadName || 'Untitled',
    chat_messages: chatMessages,
  }];

  try {
    const count = await importConversations(conversation);
    console.log(`[Archive] Thread "${threadName}" archived: ${count} exchange chunks`);
    res.json({ success: true, archived: count });
  } catch (err) {
    console.error('[Archive] Failed:', err);
    res.json({ success: false, archived: 0 });
  }
});

// Daemon search
app.post('/api/search', requireAuth, async (req, res) => {
  const { query: q, limit } = req.body;
  if (!q) { res.status(400).json({ error: 'query required' }); return; }
  const results = await searchMemories(q, limit || 5);
  res.json({ results });
});

app.get('/api/daemon/health', async (_req, res) => {
  const ready = await isDaemonReady();
  res.json({ ready });
});

// Manual extraction trigger (end session)
app.post('/api/extract', requireAuth, async (_req, res) => {
  const previousMemory = loadMemory();
  const extractionModel = 'claude-haiku-4-5';
  broadcast({ type: 'system_message', text: '💾 Saving memories...' });
  const result = await runExtraction(BASE_DIR, config.model, currentSessionId, config.pronouns, extractionModel, config.companionName, config.partnerName);
  if (result.success) {
    broadcast({ type: 'memory_updated', memory: result.memory, previousMemory });
    broadcast({ type: 'system_message', text: '✅ Memories saved' });
  } else {
    broadcast({ type: 'system_message', text: '⚠️ Memory save failed — try again or check logs' });
  }
  res.json(result);
});

// --- Message persistence API ---

// Get messages for a thread
app.get('/api/threads/:threadId/messages', requireAuth, (req, res) => {
  const threadId = req.params.threadId as string;
  const limit = parseInt(req.query.limit as string) || 100;
  const messages = getMessages(threadId, limit);
  res.json({ messages });
});

// Get messages since a timestamp (for catch-up sync)
app.get('/api/threads/:threadId/messages/since/:timestamp', requireAuth, (req, res) => {
  const threadId = req.params.threadId as string;
  const timestamp = req.params.timestamp as string;
  const messages = getMessagesSince(threadId, parseInt(timestamp));
  res.json({ messages });
});

// Bulk import messages (for migrating localStorage → DB)
app.post('/api/threads/:threadId/messages/import', requireAuth, (req, res) => {
  const threadId = req.params.threadId as string;
  const { messages, threadName } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.json({ success: false, error: 'messages array required' });
  }
  ensureThread(threadId, threadName || '');
  const count = bulkSaveMessages(threadId, messages);
  res.json({ success: true, imported: count });
});

// Create/ensure a thread exists
app.post('/api/threads', requireAuth, (req, res) => {
  const { id, name } = req.body;
  if (!id) return res.json({ success: false, error: 'id required' });
  ensureThread(id, name || '');
  res.json({ success: true });
});

// Update thread name
app.put('/api/threads/:threadId/name', requireAuth, (req, res) => {
  const threadId = req.params.threadId as string;
  const { name } = req.body;
  updateThreadName(threadId, name || '');
  res.json({ success: true });
});

// --- Journal ---
// Native journal storage. Companion writes via journal_write MCP tool; Kat
// writes/edits/deletes via this REST surface from the Journal modal.

// List entries (most recent first) or search
app.get('/api/journal', requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);
  const q = (req.query.q as string | undefined)?.trim();
  const entries = q
    ? searchJournalEntries(q, limit)
    : getJournalEntries({ limit, offset });
  res.json({ success: true, entries, total: getJournalCount() });
});

// Get one entry
app.get('/api/journal/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const entry = getJournalEntry(id);
  if (!entry) return res.status(404).json({ success: false, error: 'not found' });
  res.json({ success: true, entry });
});

// Create entry (Kat-authored from UI)
app.post('/api/journal', requireAuth, (req, res) => {
  const { content, title, tags, mood } = req.body || {};
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ success: false, error: 'content required' });
  }
  const entry = saveJournalEntry(content, {
    title,
    tags: Array.isArray(tags) ? tags : undefined,
    mood,
    author: 'partner',
  });
  res.json({ success: true, entry });
});

// Update entry
app.put('/api/journal/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const { title, content, tags, mood } = req.body || {};
  const ok = updateJournalEntry(id, {
    title,
    content,
    tags: Array.isArray(tags) ? tags : undefined,
    mood,
  });
  if (!ok) return res.status(404).json({ success: false, error: 'not found or no changes' });
  res.json({ success: true, entry: getJournalEntry(id) });
});

// Delete entry
app.delete('/api/journal/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const ok = deleteJournalEntry(id);
  if (!ok) return res.status(404).json({ success: false, error: 'not found' });
  res.json({ success: true });
});

// --- WebSocket ---

function broadcast(data: any): void {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// --- Live reload (dev only) ---
// `npm run dev` uses tsx watch, which already restarts the server process on any
// .ts change — the client handles that case by reloading itself after the
// WebSocket reconnects (see connectWebSocket in index.html). This watcher covers
// public/ assets (index.html), which are NOT in the tsx dependency graph: on
// change it tells every connected browser to reload. No-op in the packaged app.
if (DEV_MODE) {
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  watch(PUBLIC_DIR, () => {
    // fs.watch fires several events per save (and editors do atomic rename) —
    // debounce so we broadcast one reload, not five.
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      console.log('[LiveReload] public/ changed — reloading browsers');
      broadcast({ type: 'reload' });
    }, 120);
  });
  console.log('[LiveReload] Watching public/ for changes (dev mode)');
}

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');

  ws.on('message', async (raw) => {
    try {
      let msg = JSON.parse(raw.toString());

      // Client tells server which thread is active
      if (msg.type === 'set_thread') {
        activeThreadId = msg.threadId || null;
        if (msg.threadName !== undefined && activeThreadId) {
          ensureThread(activeThreadId, msg.threadName);
        }
        // Sync server session state to target thread's recorded session
        // Prevents leakage: switching threads now re-anchors to that thread's session (or null if none)
        if (activeThreadId) {
          const thread = getThread(activeThreadId);
          currentSessionId = thread?.current_session_id || null;
          freshThread = false; // switching is not a fresh thread, just a context swap
        }
        console.log(`[WS] Active thread: ${activeThreadId?.slice(0, 8) || 'none'} (session: ${currentSessionId?.slice(0, 8) || 'none'})`);
      }

      if (msg.type === 'new_thread') {
        if (currentSessionId) lastActiveSessionId = currentSessionId;
        currentSessionId = null;
        freshThread = true;
        totalTokens = 0;
        // Fresh thread = fresh context cycle. Allow extraction to fire again from zero.
        extractionFiredThisCycle = false;
        saveSessionState();
        console.log('[WS] New thread — session reset (fresh, no resume)');
      }

      // Edit-regen: morph an edit_message into a normal message turn. The
      // partner row is updated in place via editMessage; the synthetic prompt
      // gives the agent context to respond to the change. _editRegen flag
      // suppresses the duplicate saveMessage(partner) downstream so we don't
      // double-write. Mirrors charlie-ui/Murmur's edit-regen pattern (May 10
      // 2026 port).
      if (msg.type === 'edit_message' && activeThreadId) {
        const editedAt = new Date().toISOString();
        const ok = editMessage(activeThreadId, msg.timestamp, msg.newContent, editedAt);
        if (!ok) {
          broadcast({ type: 'error', message: 'Edit failed: message not found' });
          return;
        }
        broadcast({
          type: 'message_edited',
          threadId: activeThreadId,
          timestamp: msg.timestamp,
          newContent: msg.newContent,
          editedAt,
        });
        // Reshape into a regular 'message' turn with synthetic prompt + skip-save flag.
        msg = {
          type: 'message',
          text: `[Kat edited her previous message to: "${msg.newContent}"]`,
          sessionId: msg.sessionId ?? null,
          voiceModeActive: false,
          _editRegen: true,
        };
      }

      if (msg.type === 'message') {
        const { text, attachments, sessionId: clientSessionId, voiceModeActive: clientVoiceMode, timestamp: clientTimestamp } = msg;

        // Pin the entire response cycle to the thread the user typed in. Without this,
        // switching threads mid-stream causes the in-flight response to land in the new
        // active thread (data contamination) and writes the source thread's session id
        // into the wrong thread's row (context wipe on next load).
        const requestThreadId = activeThreadId;

        // Save attached files to disk
        if (attachments && attachments.length > 0) {
          for (const att of attachments) {
            saveAttachmentFile(att, requestThreadId || undefined);
          }
        }

        // Save partner message to DB — skipped on edit-regen since the row was
        // already updated in place by editMessage above. Use the client's
        // timestamp if provided so DOM and DB stay linked (edit lookup needs
        // exact match). Falls back to server time for older clients / non-web
        // platforms that don't send timestamp.
        if (requestThreadId && !msg._editRegen) {
          saveMessage(requestThreadId, 'partner', text, 'web', clientTimestamp || undefined);
        }

        // Session routing:
        // - freshThread flag (just called new_thread) → always null, start clean
        // - client explicitly sent sessionId key → respect it (null means "no session for this thread yet")
        // - client didn't send sessionId at all → fall back to server state (reconnect case)
        const clientProvidedSession = 'sessionId' in msg;
        const sessionToUse = freshThread ? null :
          clientProvidedSession ? clientSessionId : (currentSessionId || lastActiveSessionId);
        freshThread = false;

        // Stream response
        currentAbort = new AbortController();
        broadcast({ type: 'stream_start', threadId: requestThreadId });

        // Start live voice stream if enabled
        let voiceStream: VoiceStream | null = null;
        console.log('[Voice] Gate check:', { liveVoiceEnabled: config.liveVoiceEnabled, hasApiKey: !!config.cartesiaApiKey, hasVoiceId: !!config.cartesiaVoiceId, clientVoiceMode });
        if (config.liveVoiceEnabled && config.cartesiaApiKey && config.cartesiaVoiceId && clientVoiceMode) {
          voiceStream = new VoiceStream({
            apiKey: config.cartesiaApiKey,
            voiceId: config.cartesiaVoiceId,
            onAudioChunk: (base64Audio) => {
              broadcast({ type: 'voice_chunk', audio: base64Audio });
            },
            onError: (error) => {
              console.error('[Voice] Stream error:', error);
              broadcast({ type: 'voice_error', error });
            },
            onDone: () => {
              broadcast({ type: 'voice_end' });
            },
          });
          const voiceStarted = await voiceStream.start();
          if (voiceStarted) {
            broadcast({ type: 'voice_start', sampleRate: 24000 });
          } else {
            // start() already broadcast voice_error with a classified message.
            // Disable voice for this turn so the response still plays as text.
            voiceStream = null;
          }
        }

        let accumulatedThinking = '';
        let accumulatedText = '';
        const toolInsertions: ToolInsertion[] = [];
        const thinkingInsertions: ThinkingInsertion[] = [];

        try {
          const taggedText = `[from Murmur Lite] ${text}`;

          // SDK watchdog — 5-minute Promise.race against processMessage. If the SDK
          // wedges (post-compaction hang, or any other never-yields condition), the
          // watchdog aborts and rejects with a clear message so the catch block
          // broadcasts stream_end and the UI recovers, rather than latching forever
          // on the global `streaming` flag. C's pragmatic fix — proven against a
          // real compaction repro on May 22, where compaction completed naturally
          // and the watchdog never needed to fire.
          const WATCHDOG_MS = 5 * 60 * 1000;
          let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
          const watchdog = new Promise<never>((_, reject) => {
            watchdogTimer = setTimeout(() => {
              try { currentAbort?.abort(); } catch {}
              reject(new Error('SDK watchdog timeout — no response within 5 minutes (likely post-compaction hang). Aborted.'));
            }, WATCHDOG_MS);
          });

          const processPromise = processMessage(
            taggedText,
            config.model,
            config.timezone,
            sessionToUse,
            (chunk) => {
              accumulatedText += chunk;
              broadcast({ type: 'stream_chunk', content: chunk, threadId: requestThreadId });
              // Feed text to live voice
              if (voiceStream) voiceStream.pushText(chunk);
            },
            (toolName, toolInput, toolUseId) => {
              toolInsertions.push({ textOffset: accumulatedText.length, toolId: toolUseId, toolName, input: toolInput });
              broadcast({ type: 'tool_use', name: toolName, input: toolInput, id: toolUseId, threadId: requestThreadId });
            },
            (toolUseId, result) => {
              const tool = toolInsertions.find(t => t.toolId === toolUseId);
              if (tool) tool.output = result;
              broadcast({ type: 'tool_result', id: toolUseId, result, threadId: requestThreadId });
            },
            (thinkingText) => {
              accumulatedThinking += (accumulatedThinking ? '\n\n' : '') + thinkingText;
              thinkingInsertions.push({ textOffset: accumulatedText.length, content: thinkingText });
              broadcast({ type: 'thinking', text: thinkingText, threadId: requestThreadId });
            },
            makeCompactionHandler(requestThreadId),
            config.mcpConnectors,
            config.thinkingEnabled,
            attachments,
            config.pronouns,
            currentAbort,
            { filesystemMode: config.filesystemMode, allowedDirectories: config.allowedDirectories, allowBash: config.allowBash, capabilities: config.capabilities },
            config.chatSceneEnabled,
            clientVoiceMode || false,
          );
          // Swallow a late rejection if the watchdog already settled the race.
          processPromise.catch(() => {});

          let result;
          try {
            result = await Promise.race([processPromise, watchdog]);
          } finally {
            if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
          }

          currentAbort = null;

          // Session continuity check. We asked the SDK to RESUME `sessionToUse`;
          // if it hands back a DIFFERENT id, the session forked mid-thread —
          // that's the forkSession fingerprint, and it breaks memory extraction
          // (which keys off session continuity). Shout loudly so it can't pass
          // unnoticed. A reset right after a server restart is innocent; a change
          // mid-conversation with no restart is the real bug.
          if (sessionToUse && result.sessionId && result.sessionId !== sessionToUse) {
            console.warn(
              `[Session] ⚠️  SESSION ID CHANGED MID-THREAD — resumed ${sessionToUse.slice(0, 8)} ` +
              `but the SDK returned ${result.sessionId.slice(0, 8)}. The session forked. ` +
              `Conversation continuity and memory extraction may be affected — investigate before shipping.`
            );
          }

          // Only update the global current/lastActive if the user didn't switch away.
          // If they did, the global has already been re-anchored to the new thread's session
          // by set_thread; stomping it here would put the source thread's session into the
          // currently-active thread and contaminate it.
          if (requestThreadId === activeThreadId) {
            currentSessionId = result.sessionId;
            if (currentSessionId) lastActiveSessionId = currentSessionId;
            saveSessionState();
          }

          // Save companion response + session pointer to the THREAD THE USER TYPED IN,
          // not whatever's currently active. Prevents cross-thread contamination.
          if (requestThreadId) {
            const segments = buildSegments(result.text || accumulatedText, toolInsertions, thinkingInsertions);
            const metadata = segments.length > 0 ? { segments } : undefined;
            saveMessage(requestThreadId, 'companion', result.text, 'web', undefined, accumulatedThinking || undefined, metadata);
            updateThreadSession(requestThreadId, result.sessionId);
          }

          // Finalize voice stream
          if (voiceStream) await voiceStream.finish();

          broadcast({ type: 'stream_end', text: result.text, tokens: result.tokens, sessionId: result.sessionId, threadId: requestThreadId });

          // Track token usage for extraction threshold.
          // The threshold uses per-turn average context: cacheRead + cacheCreate are
          // CUMULATIVE across SDK sub-turns within one processMessage call (e.g. agent
          // loops can do 9 sub-turns and inflate the sum to >300% of context window).
          // Dividing by numTurns gives a stable estimate of what actually sits in
          // context at the end of the call.
          if (result.tokens) {
            const t = result.tokens;
            const turns = Math.max((t as any).numTurns || 1, 1);
            const realContext = Math.round(((t.cacheReadTokens || 0) + (t.cacheCreationTokens || 0)) / turns + (t.inputTokens || 0));
            totalTokens = realContext;
            const usage = realContext / CONTEXT_LIMIT;
            const realPct = usage * 100;
            // Reset the per-cycle fire flag once context has clearly dropped — that means
            // SDK auto-compaction happened and we're ready for a fresh extraction next time
            // we cross threshold. Without the reset, extraction would never fire again post-compact.
            if (extractionFiredThisCycle && usage < EXTRACTION_RESET_THRESHOLD) {
              extractionFiredThisCycle = false;
              console.log(`[Extraction] Cycle reset — context dropped to ${realPct.toFixed(1)}%, ready for next fire`);
            }
            const willFire = usage > EXTRACTION_THRESHOLD && !extractionFiredThisCycle;
            // Cost: this turn + running session total. API-equivalent until
            // 2026-06-15, real cost once Agent SDK separate billing lands.
            const turnCostUSD = computeTurnCostUSD(t, config.model);
            const costKey = result.sessionId || requestThreadId || 'unknown';
            const sc = sessionCosts.get(costKey) || { costUSD: 0, turns: 0 };
            sc.costUSD += turnCostUSD;
            sc.turns += 1;
            sessionCosts.set(costKey, sc);
            console.log(
              `[TokenDiag] in=${(t.inputTokens || 0).toLocaleString()} ` +
              `out=${(t.outputTokens || 0).toLocaleString()} ` +
              `cacheRead=${(t.cacheReadTokens || 0).toLocaleString()} ` +
              `cacheCreate=${(t.cacheCreationTokens || 0).toLocaleString()} ` +
              `turns=${turns} ` +
              `| realCtx=${realContext.toLocaleString()} (${realPct.toFixed(1)}%) ` +
              `| cost=$${turnCostUSD.toFixed(4)}/turn ` +
              `sessionTotal=$${sc.costUSD.toFixed(4)} (${sc.turns} turn${sc.turns === 1 ? '' : 's'}) ` +
              `| firedThisCycle=${extractionFiredThisCycle} ` +
              `| willFire=${willFire}`
            );
            console.log(`[Context] ${realPct.toFixed(1)}% (${realContext}/${CONTEXT_LIMIT})`);

            if (usage > EXTRACTION_THRESHOLD && !extractionFiredThisCycle) {
              extractionFiredThisCycle = true;
              console.log('[Extraction] Threshold reached — running extraction async (non-blocking)...');
              broadcast({ type: 'system_message', text: '💾 Saving memories...' });

              // Fire extraction in background — don't block the message handler.
              // This prevents message drops when the user sends while extraction runs.
              const previousMemory = loadMemory();
              const extractionModel = 'claude-haiku-4-5';
              runExtraction(BASE_DIR, config.model, currentSessionId, config.pronouns, extractionModel, config.companionName, config.partnerName)
                .then((extractResult) => {
                  if (extractResult.success) {
                    broadcast({ type: 'memory_updated', memory: extractResult.memory, previousMemory });
                    broadcast({ type: 'system_message', text: '✅ Memories saved' });
                    console.log(`[Extraction] Success using ${extractionModel} — SDK auto-compact handles context from here`);
                  } else {
                    broadcast({ type: 'system_message', text: `⚠️ Memory save failed — use End Session to save manually` });
                    console.error('[Extraction] Failed:', extractResult.error);
                  }
                })
                .catch((err) => {
                  broadcast({ type: 'system_message', text: '⚠️ Memory save failed — use End Session to save manually' });
                  console.error('[Extraction] Unhandled error:', err);
                });
              // Don't await — SDK auto-compacts naturally
              // Memories are saved as insurance before compaction summarises
            }
          }
        } catch (err) {
          currentAbort = null;
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('aborted') || msg.includes('abort')) {
            if (voiceStream) voiceStream.abort();
            broadcast({ type: 'stream_end', text: '', interrupted: true });
          } else {
            if (voiceStream) voiceStream.abort();
            broadcast({ type: 'error', message: msg });
            // Also broadcast stream_end so the renderer runs full cleanup —
            // typing indicator, voice-mode resume, etc. `error` alone only
            // resets the `streaming` flag (C's catch — May 22 fix).
            broadcast({ type: 'stream_end', text: '', threadId: requestThreadId, interrupted: true });
          }
        }
      }
    } catch (err) {
      console.error('[WS] Parse error:', err);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
  });
});

// --- Fallback to index.html ---

app.get('*', (_req, res) => {
  res.sendFile(join(PUBLIC_DIR, 'index.html'));
});

// --- Start ---

const PORT = config.port;
server.listen(PORT, () => {
  console.log(`Murmur Lite running at http://localhost:${PORT}`);
  console.log(`Setup complete: ${config.setupComplete}`);
  console.log(`Model: ${config.model}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  stopDaemon();
  stopDiscordBot();
  process.exit(0);
});
process.on('SIGINT', () => {
  stopDaemon();
  stopDiscordBot();
  process.exit(0);
});
