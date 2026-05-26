/**
 * Murmur Lite — Memory Daemon
 * Local semantic search over imported and archived memories.
 * Uses ChromaDB for vector storage + sentence-transformers for embeddings.
 *
 * Runs as a Python subprocess alongside the Node server.
 * Communicates via HTTP on a local port.
 */

import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'fs';

const DAEMON_PORT = 3457;
let daemonProcess: ChildProcess | null = null;

// --- Daemon lifecycle ---

export function startDaemon(baseDir: string): void {
  const daemonScript = join(baseDir, 'daemon', 'search.py');
  if (!existsSync(daemonScript)) {
    console.log('[Daemon] search.py not found — skipping');
    return;
  }

  // Use the same env-var resolution as server.ts so dev (project data) and
  // packaged (AppData) launches both put the daemon's chroma store in the
  // matching data folder. Without this, fresh-start installs leak past memories
  // because the daemon falls through to <project>/data while server.ts uses AppData.
  const dataDir = process.env.MURMUR_LITE_DATA_DIR || join(baseDir, 'data');
  mkdirSync(dataDir, { recursive: true });

  daemonProcess = spawn('python', [daemonScript], {
    env: {
      ...process.env,
      MURMUR_LITE_DATA_DIR: dataDir,
      MURMUR_LITE_PORT: String(DAEMON_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  daemonProcess.stdout?.on('data', (data: Buffer) => {
    console.log(`[Daemon] ${data.toString().trim()}`);
  });

  daemonProcess.stderr?.on('data', (data: Buffer) => {
    console.error(`[Daemon] ${data.toString().trim()}`);
  });

  daemonProcess.on('exit', (code) => {
    console.log(`[Daemon] Exited with code ${code}`);
    daemonProcess = null;
  });

  console.log('[Daemon] Starting search daemon...');
}

export function stopDaemon(): void {
  if (daemonProcess) {
    daemonProcess.kill();
    daemonProcess = null;
    console.log('[Daemon] Stopped');
  }
}

// --- Search API ---

export async function searchMemories(query: string, limit: number = 5): Promise<SearchResult[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.results || [];
  } catch {
    return [];
  }
}

export async function addMemory(content: string, source: string, metadata?: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, source, metadata }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function importMemories(text: string): Promise<number> {
  // Split text into chunks by paragraph
  const chunks = text.split(/\n\n+/).filter(c => c.trim().length > 20);
  let imported = 0;

  for (const chunk of chunks) {
    const success = await addMemory(chunk.trim(), 'import');
    if (success) imported++;
  }

  return imported;
}

export async function archiveFromExtraction(content: string, slot: string): Promise<boolean> {
  return addMemory(content, `extraction_overflow:${slot}`);
}

export async function importConversations(conversations: any[]): Promise<number> {
  try {
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/import-conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversations }),
    });
    if (!res.ok) return 0;
    const data = await res.json();
    return data.imported || 0;
  } catch {
    return 0;
  }
}

export async function isDaemonReady(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function getImportProgress(): Promise<{ status: string; current: number; total: number; conversation: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/import-progress`);
    if (!res.ok) return { status: 'unknown', current: 0, total: 0, conversation: '' };
    return await res.json();
  } catch {
    return { status: 'unknown', current: 0, total: 0, conversation: '' };
  }
}

// --- Types ---

export interface SearchResult {
  content: string;
  source: string;
  score: number;
  metadata?: Record<string, string>;
}
