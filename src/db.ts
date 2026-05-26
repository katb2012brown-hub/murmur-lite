/**
 * SQLite message persistence for Murmur Lite
 * Single source of truth for all messages (web + Discord)
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

let db: Database.Database | null = null;

export function initDb(dataDir: string): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const dbPath = join(dataDir, 'murmur-lite.db');
  db = new Database(dbPath);

  // WAL mode for better concurrent read/write
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      current_session_id TEXT,
      last_activity_at TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('partner', 'companion', 'system')),
      content TEXT NOT NULL,
      platform TEXT DEFAULT 'web',
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES threads(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_thread_seq
      ON messages(thread_id, sequence);
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      thread_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_files_created
      ON files(created_at);

    CREATE INDEX IF NOT EXISTS idx_messages_thread_ts
      ON messages(thread_id, timestamp);

    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      tags TEXT,
      mood TEXT,
      author TEXT NOT NULL CHECK(author IN ('companion', 'partner')) DEFAULT 'companion',
      created_at TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_journal_timestamp
      ON journal_entries(timestamp);
  `);

  // Migration: add thinking column if not exists
  try {
    db.exec('ALTER TABLE messages ADD COLUMN thinking TEXT');
    console.log('[DB] Added thinking column');
  } catch {
    // Column already exists — ignore
  }

  // Migration: add metadata column for rich segments (tool calls, ordered text/thinking).
  // Mirrors charlie-ui's metadata.segments approach so refresh restores tool blocks.
  try {
    db.exec('ALTER TABLE messages ADD COLUMN metadata TEXT');
    console.log('[DB] Added metadata column');
  } catch {
    // Column already exists — ignore
  }

  // Migration: add edited_at column for edit-regen flow (May 10 2026).
  // Stored as ISO string when a partner message is edited; null otherwise.
  try {
    db.exec('ALTER TABLE messages ADD COLUMN edited_at TEXT');
    console.log('[DB] Added edited_at column');
  } catch {
    // Column already exists — ignore
  }

  // Migration: add current_session_model to threads table (May 13 2026).
  // Tracks which model created the current SDK session, so we can fork when switching models.
  // Fixes session-binding bug where thinking config from first model leaks to subsequent models.
  try {
    db.exec('ALTER TABLE threads ADD COLUMN current_session_model TEXT');
    console.log('[DB] Added current_session_model column');
  } catch {
    // Column already exists — ignore
  }

  console.log('[DB] SQLite initialized at', dbPath);
}

function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized — call initDb first');
  return db;
}

// --- Threads ---

export function createThread(id: string, name: string, createdAt?: string): void {
  const now = createdAt || new Date().toISOString();
  getDb().prepare(`
    INSERT OR IGNORE INTO threads (id, name, created_at, last_activity_at)
    VALUES (?, ?, ?, ?)
  `).run(id, name, now, now);
}

export function ensureThread(id: string, name?: string): void {
  const existing = getDb().prepare('SELECT id FROM threads WHERE id = ?').get(id);
  if (!existing) {
    createThread(id, name || '');
  }
}

export function getThread(id: string): { id: string; name: string; current_session_id: string | null; current_session_model: string | null } | null {
  return getDb().prepare('SELECT id, name, current_session_id, current_session_model FROM threads WHERE id = ?').get(id) as any || null;
}

export function updateThreadSession(threadId: string, sessionId: string | null, model?: string): void {
  getDb().prepare('UPDATE threads SET current_session_id = ?, current_session_model = ?, last_activity_at = ? WHERE id = ?')
    .run(sessionId, model || null, new Date().toISOString(), threadId);
}

export function updateThreadName(threadId: string, name: string): void {
  getDb().prepare('UPDATE threads SET name = ? WHERE id = ?').run(name, threadId);
}

// --- Messages ---

function getNextSequence(threadId: string): number {
  const row = getDb().prepare('SELECT MAX(sequence) as max_seq FROM messages WHERE thread_id = ?')
    .get(threadId) as { max_seq: number | null };
  return (row.max_seq || 0) + 1;
}

export interface StoredMessage {
  id: number;
  thread_id: string;
  sequence: number;
  role: 'partner' | 'companion' | 'system';
  content: string;
  platform: string;
  timestamp: number;
  thinking: string | null;
  metadata: Record<string, unknown> | null;
}

export function saveMessage(
  threadId: string,
  role: 'partner' | 'companion' | 'system',
  content: string,
  platform: string = 'web',
  timestamp?: number,
  thinking?: string,
  metadata?: Record<string, unknown>,
): StoredMessage {
  ensureThread(threadId);
  const seq = getNextSequence(threadId);
  const ts = timestamp || Date.now();

  let metadataJson: string | null = null;
  if (metadata) {
    try { metadataJson = JSON.stringify(metadata); }
    catch (err) { console.error('[DB] Failed to stringify metadata, dropping:', err); }
  }

  getDb().prepare(`
    INSERT INTO messages (thread_id, sequence, role, content, platform, timestamp, thinking, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(threadId, seq, role, content, platform, ts, thinking || null, metadataJson);

  // Update thread activity
  getDb().prepare('UPDATE threads SET last_activity_at = ? WHERE id = ?')
    .run(new Date().toISOString(), threadId);

  return { id: seq, thread_id: threadId, sequence: seq, role, content, platform, timestamp: ts, thinking: thinking || null, metadata: metadata || null };
}

/**
 * Edit a previously-saved partner message in place.
 * Identifies the row by (thread_id, timestamp, role='partner') — DOM tracks
 * timestamp on every message div so the client can request an edit without
 * needing the auto-increment seq. Millisecond timestamps are unique enough
 * within a single thread for our purposes.
 *
 * Returns true if a row was updated, false if no match found.
 */
export function editMessage(threadId: string, timestamp: number, newContent: string, editedAt: string): boolean {
  const result = getDb().prepare(`
    UPDATE messages
    SET content = ?, edited_at = ?
    WHERE thread_id = ? AND timestamp = ? AND role = 'partner'
  `).run(newContent, editedAt, threadId, timestamp);
  return result.changes > 0;
}

function hydrateRow(row: any): StoredMessage {
  // Metadata is stored as JSON string; parse safely so a corrupt row never crashes thread load.
  if (row && typeof row.metadata === 'string') {
    try { row.metadata = JSON.parse(row.metadata); }
    catch { row.metadata = null; }
  } else if (!row.metadata) {
    row.metadata = null;
  }
  return row as StoredMessage;
}

export function getMessages(threadId: string, limit: number = 100): StoredMessage[] {
  const rows = getDb().prepare(`
    SELECT * FROM messages WHERE thread_id = ?
    ORDER BY sequence DESC LIMIT ?
  `).all(threadId, limit).reverse() as any[];
  return rows.map(hydrateRow);
}

export function getMessagesSince(threadId: string, sinceTimestamp: number): StoredMessage[] {
  const rows = getDb().prepare(`
    SELECT * FROM messages WHERE thread_id = ? AND timestamp > ?
    ORDER BY sequence ASC
  `).all(threadId, sinceTimestamp) as any[];
  return rows.map(hydrateRow);
}

export function bulkSaveMessages(
  threadId: string,
  messages: { role: 'partner' | 'companion' | 'system'; content: string; platform?: string; timestamp?: number }[],
): number {
  ensureThread(threadId);
  const insert = getDb().prepare(`
    INSERT INTO messages (thread_id, sequence, role, content, platform, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  const txn = getDb().transaction(() => {
    for (const msg of messages) {
      const seq = getNextSequence(threadId);
      insert.run(threadId, seq, msg.role, msg.content, msg.platform || 'web', msg.timestamp || Date.now());
      count++;
    }
  });
  txn();

  if (count > 0) {
    getDb().prepare('UPDATE threads SET last_activity_at = ? WHERE id = ?')
      .run(new Date().toISOString(), threadId);
  }

  return count;
}

export function getThreadMessageCount(threadId: string): number {
  const row = getDb().prepare('SELECT COUNT(*) as count FROM messages WHERE thread_id = ?')
    .get(threadId) as { count: number };
  return row.count;
}


// --- Files ---

export interface StoredFile {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  thread_id: string | null;
  created_at: string;
}

export function saveFileRecord(id: string, filename: string, mimeType: string, size: number, threadId?: string): StoredFile {
  const now = new Date().toISOString();
  getDb().prepare(
    'INSERT INTO files (id, filename, mime_type, size, thread_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, filename, mimeType, size, threadId || null, now);
  return { id, filename, mime_type: mimeType, size, thread_id: threadId || null, created_at: now };
}

export function getFileRecord(id: string): StoredFile | null {
  return getDb().prepare('SELECT * FROM files WHERE id = ?').get(id) as StoredFile || null;
}

export function getAllFiles(): StoredFile[] {
  return getDb().prepare('SELECT * FROM files ORDER BY created_at DESC').all() as StoredFile[];
}

export function deleteFileRecord(id: string): boolean {
  const result = getDb().prepare('DELETE FROM files WHERE id = ?').run(id);
  return result.changes > 0;
}

export function getFileStats(): { totalFiles: number; totalSize: number } {
  const row = getDb().prepare('SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as total_size FROM files').get() as any;
  return { totalFiles: row.count, totalSize: row.total_size };
}

// --- Journal ---

export interface JournalEntry {
  id: number;
  timestamp: number;
  title: string;
  content: string;
  tags: string[] | null;
  mood: string | null;
  author: 'companion' | 'partner';
  created_at: string;
  updated_at: string | null;
}

function hydrateJournalRow(row: any): JournalEntry {
  // tags stored as JSON array string; parse safely
  let tags: string[] | null = null;
  if (row.tags) {
    try { tags = JSON.parse(row.tags); }
    catch { tags = null; }
  }
  return {
    id: row.id,
    timestamp: row.timestamp,
    title: row.title || '',
    content: row.content,
    tags,
    mood: row.mood || null,
    author: row.author,
    created_at: row.created_at,
    updated_at: row.updated_at || null,
  };
}

export function saveJournalEntry(
  content: string,
  options: {
    title?: string;
    tags?: string[];
    mood?: string;
    author?: 'companion' | 'partner';
    timestamp?: number;
  } = {},
): JournalEntry {
  const ts = options.timestamp || Date.now();
  const now = new Date().toISOString();
  const tagsJson = options.tags && options.tags.length > 0 ? JSON.stringify(options.tags) : null;

  const result = getDb().prepare(`
    INSERT INTO journal_entries (timestamp, title, content, tags, mood, author, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(ts, options.title || '', content, tagsJson, options.mood || null, options.author || 'companion', now);

  return {
    id: Number(result.lastInsertRowid),
    timestamp: ts,
    title: options.title || '',
    content,
    tags: options.tags || null,
    mood: options.mood || null,
    author: options.author || 'companion',
    created_at: now,
    updated_at: null,
  };
}

export function getJournalEntries(options: {
  limit?: number;
  offset?: number;
  before?: number;
  after?: number;
  author?: 'partner' | 'companion';
} = {}): JournalEntry[] {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  let sql = 'SELECT * FROM journal_entries WHERE 1=1';
  const params: any[] = [];
  if (options.before) { sql += ' AND timestamp < ?'; params.push(options.before); }
  if (options.after) { sql += ' AND timestamp > ?'; params.push(options.after); }
  if (options.author) { sql += ' AND author = ?'; params.push(options.author); }
  sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = getDb().prepare(sql).all(...params) as any[];
  return rows.map(hydrateJournalRow);
}

export function searchJournalEntries(query: string, limit: number = 20): JournalEntry[] {
  // Simple LIKE search across title + content + tags. ChromaDB daemon would be
  // overkill for journal (typically <1k entries); LIKE is fast enough and
  // doesn't need the daemon running.
  const pattern = `%${query}%`;
  const rows = getDb().prepare(`
    SELECT * FROM journal_entries
    WHERE title LIKE ? OR content LIKE ? OR tags LIKE ?
    ORDER BY timestamp DESC LIMIT ?
  `).all(pattern, pattern, pattern, limit) as any[];
  return rows.map(hydrateJournalRow);
}

export function getJournalEntry(id: number): JournalEntry | null {
  const row = getDb().prepare('SELECT * FROM journal_entries WHERE id = ?').get(id) as any;
  return row ? hydrateJournalRow(row) : null;
}

export function updateJournalEntry(
  id: number,
  updates: { title?: string; content?: string; tags?: string[]; mood?: string },
): boolean {
  const fields: string[] = [];
  const params: any[] = [];
  if (updates.title !== undefined) { fields.push('title = ?'); params.push(updates.title); }
  if (updates.content !== undefined) { fields.push('content = ?'); params.push(updates.content); }
  if (updates.tags !== undefined) {
    fields.push('tags = ?');
    params.push(updates.tags.length > 0 ? JSON.stringify(updates.tags) : null);
  }
  if (updates.mood !== undefined) { fields.push('mood = ?'); params.push(updates.mood || null); }
  if (fields.length === 0) return false;

  fields.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);

  const result = getDb().prepare(
    `UPDATE journal_entries SET ${fields.join(', ')} WHERE id = ?`
  ).run(...params);
  return result.changes > 0;
}

export function deleteJournalEntry(id: number): boolean {
  const result = getDb().prepare('DELETE FROM journal_entries WHERE id = ?').run(id);
  return result.changes > 0;
}

export function getJournalCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) as count FROM journal_entries').get() as { count: number };
  return row.count;
}

// --- Export ---
// Unbounded reads for the data-export feature. The normal getters are paginated
// (getMessages/getJournalEntries cap by limit) because the UI never needs
// everything at once — but an export does.

export interface ThreadRow {
  id: string;
  name: string;
  created_at: string;
  current_session_id: string | null;
  last_activity_at: string | null;
}

export function getAllThreads(): ThreadRow[] {
  return getDb().prepare(
    'SELECT id, name, created_at, current_session_id, last_activity_at FROM threads ORDER BY created_at ASC'
  ).all() as ThreadRow[];
}

export function getAllMessages(threadId: string): StoredMessage[] {
  const rows = getDb().prepare(
    'SELECT * FROM messages WHERE thread_id = ? ORDER BY sequence ASC'
  ).all(threadId) as any[];
  return rows.map(hydrateRow);
}

export function getAllJournalEntries(): JournalEntry[] {
  const rows = getDb().prepare(
    'SELECT * FROM journal_entries ORDER BY timestamp ASC'
  ).all() as any[];
  return rows.map(hydrateJournalRow);
}
