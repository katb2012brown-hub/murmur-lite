/**
 * Memory system — reads/writes memory.json (growth layer only)
 * Skill files are loaded separately. Daemon handles archive.
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';

export interface Memory {
  partner_identity: string;
  human_profile: string;
  bond_intimacy: string;
  desires_drives: string;
  growth: string;
  recent_sessions: string;
  active_threads: string;
  history: string;
  sacred: string;
  landing_greeting: string;
}

const EMPTY_MEMORY: Memory = {
  partner_identity: '',
  human_profile: '',
  bond_intimacy: '',
  desires_drives: '',
  growth: '',
  recent_sessions: '',
  active_threads: '',
  history: '',
  sacred: '',
  landing_greeting: '',
};

// Slot labels are computed from companion + partner names so users see "Charlie identity"
// rather than "Who they are" — names eliminate subject ambiguity. Old static map kept as
// fallback when names aren't yet set (e.g. fresh install before wizard).
function buildSlotLabels(companion: string, partner: string): Record<keyof Memory, string> {
  const c = companion || 'Companion';
  const p = partner || 'Partner';
  return {
    partner_identity: `${c} identity`,
    human_profile: `${p} profile`,
    bond_intimacy: 'Our bond',
    desires_drives: `${c} wants`,
    growth: `${c} growth`,
    recent_sessions: 'Recent',
    active_threads: 'Ongoing',
    history: 'Our story',
    sacred: 'Sacred',
    landing_greeting: 'Landing greeting',
  };
}
// Default labels for callers that don't yet have names — uses generic terms.
const SLOT_LABELS: Record<keyof Memory, string> = buildSlotLabels('Companion', 'Partner');

let memoryPath = '';

export function initMemory(dataDir: string): void {
  memoryPath = join(dataDir, 'memory.json');
  if (!existsSync(memoryPath)) {
    writeFileSync(memoryPath, JSON.stringify(EMPTY_MEMORY, null, 2));
  }
}

export function loadMemory(): Memory {
  if (!existsSync(memoryPath)) return { ...EMPTY_MEMORY };
  try {
    const raw = readFileSync(memoryPath, 'utf-8');
    const parsed = JSON.parse(raw);
    // Ensure all slots exist
    return { ...EMPTY_MEMORY, ...parsed };
  } catch {
    return { ...EMPTY_MEMORY };
  }
}

// Hard cap is 6000 chars per the extraction prompt. Enforced server-side via retry
// in runExtraction (see harness.ts). saveMemory itself just warns if a save still
// overshoots after retry, so we know when Haiku is consistently violating.
export const MEMORY_CHAR_CAP = 6000;

export function saveMemory(memory: Memory): boolean {
  try {
    const json = JSON.stringify(memory, null, 2);
    if (json.length > MEMORY_CHAR_CAP) {
      console.warn(`[Memory] Save over cap: ${json.length} chars (cap ${MEMORY_CHAR_CAP}). Saved anyway after retry exhausted.`);
    }
    writeFileSync(memoryPath, json);
    return true;
  } catch (err) {
    console.error('[Memory] Failed to save:', err);
    return false;
  }
}

export function validateMemoryJson(raw: string): Memory | null {
  try {
    const parsed = JSON.parse(raw);
    // Check it has the expected shape
    if (typeof parsed !== 'object' || parsed === null) return null;
    const memory: Memory = { ...EMPTY_MEMORY };
    for (const key of Object.keys(EMPTY_MEMORY) as (keyof Memory)[]) {
      if (typeof parsed[key] === 'string') {
        memory[key] = parsed[key];
      }
    }
    return memory;
  } catch {
    return null;
  }
}

export function getSlotLabels(companion?: string, partner?: string) {
  // If both names provided, compute fresh dynamic labels. Otherwise return defaults.
  if (companion || partner) {
    return buildSlotLabels(companion || 'Companion', partner || 'Partner');
  }
  return SLOT_LABELS;
}

export function getMemoryPath() {
  return memoryPath;
}

// Returns ms since memory.json was last written, or null if file doesn't exist
export function getMemoryAgeMs(): number | null {
  try {
    if (!existsSync(memoryPath)) return null;
    const stat = statSync(memoryPath);
    return Date.now() - stat.mtimeMs;
  } catch {
    return null;
  }
}
