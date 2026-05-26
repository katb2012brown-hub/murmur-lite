/**
 * Filesystem permissions for Murmur Lite
 *
 * Three modes:
 *   'full'     — no restrictions (current default, used by trusted installs)
 *   'sandbox'  — Read/Write/Edit/Glob/Grep validated against allowedDirectories
 *                via realpath (blocks symlink escape). Bash requires separate toggle.
 *   'none'     — all filesystem + bash tools blocked entirely via disallowedTools
 */

import { realpathSync } from 'fs';
import { resolve, isAbsolute, normalize } from 'path';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';

export type FilesystemMode = 'none' | 'sandbox' | 'full';

/**
 * Capability toggles — gate categories of SDK/preset tools that most
 * partner-chat users never need. Each toggle off → that category's tools
 * are pushed into disallowedTools and never appear in prompt context.
 *
 * Default for new installs: all false. User opts in per category.
 * See CAPABILITY_TOOLS for the mapping.
 */
export interface Capabilities {
  subagents: boolean;   // Agent tool (subagent spawning)
  scheduling: boolean;  // CronCreate/Delete/List (auto-on when wake enabled)
  research: boolean;    // WebFetch, WebSearch
  planning: boolean;    // EnterPlanMode, ExitPlanMode, TodoWrite
  worktrees: boolean;   // EnterWorktree, ExitWorktree
  notebooks: boolean;   // NotebookEdit (Jupyter)
  tasks: boolean;       // TaskOutput, TaskStop, Monitor, RemoteTrigger
  askUser: boolean;     // AskUserQuestion
  devSkills: boolean;   // Skill tool (strips preset dev skills: update-config, keybindings-help, simplify, loop, claude-api)
}

export const DEFAULT_CAPABILITIES: Capabilities = {
  subagents: false,
  scheduling: false,
  research: false,
  planning: false,
  worktrees: false,
  notebooks: false,
  tasks: false,
  askUser: false,
  devSkills: false,
};

/**
 * Mapping of capability → SDK/preset tool names to strip when that
 * capability is disabled. NotebookEdit is handled here AND via filesystem
 * mode (Write-like tools); disabling `notebooks` alone strips it even
 * when filesystem access is allowed.
 */
const CAPABILITY_TOOLS: Record<keyof Capabilities, readonly string[]> = {
  subagents: ['Agent'],
  scheduling: ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup'],
  research: ['WebFetch', 'WebSearch'],
  planning: ['EnterPlanMode', 'ExitPlanMode', 'TodoWrite'],
  worktrees: ['EnterWorktree', 'ExitWorktree'],
  notebooks: ['NotebookEdit'],
  tasks: ['TaskOutput', 'TaskStop', 'Monitor', 'RemoteTrigger'],
  askUser: ['AskUserQuestion'],
  devSkills: ['Skill'],
};

// Tools we gate for filesystem access
const FS_READ_TOOLS = ['Read', 'Glob', 'Grep'] as const;
const FS_WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit'] as const;
const FS_ALL_TOOLS = [...FS_READ_TOOLS, ...FS_WRITE_TOOLS];
const BASH_TOOLS = ['Bash', 'BashOutput', 'KillShell'] as const;

/**
 * Extract the target filesystem path from a tool's input, if any.
 * Returns null for tools that don't operate on a specific path.
 */
function extractToolPath(toolName: string, input: Record<string, unknown>): string | null {
  // Read, Write, Edit, NotebookEdit all use file_path
  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    const p = input.file_path;
    return typeof p === 'string' ? p : null;
  }
  // Glob, Grep use optional `path` (defaults to cwd if absent)
  if (toolName === 'Glob' || toolName === 'Grep') {
    const p = input.path;
    return typeof p === 'string' ? p : null;
  }
  return null;
}

/**
 * Canonicalize a path: resolve to absolute, then resolve symlinks.
 * If the path doesn't exist yet (e.g. Write to new file), resolve the parent dir instead.
 * Returns null if the path can't be resolved (invalid path etc).
 */
function canonicalize(inputPath: string): string | null {
  try {
    const abs = isAbsolute(inputPath) ? inputPath : resolve(process.cwd(), inputPath);
    try {
      // Path exists — resolve symlinks fully
      return realpathSync(abs);
    } catch {
      // Path doesn't exist (e.g. Write to new file) — resolve parent instead
      // Walk up until we find an existing ancestor
      let current = normalize(abs);
      const segments: string[] = [];
      while (current !== normalize(resolve(current, '..'))) {
        try {
          const realParent = realpathSync(current);
          return realParent + abs.slice(current.length);
        } catch {
          // Keep walking up
          const parent = normalize(resolve(current, '..'));
          segments.unshift(current.slice(parent.length));
          current = parent;
        }
      }
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Check whether a canonicalized path is inside any of the allowed directories.
 * Each allowed dir is also canonicalized for comparison.
 */
function isPathAllowed(canonical: string, allowedDirs: string[]): boolean {
  const resolvedAllowed = allowedDirs
    .map(d => {
      try { return realpathSync(d); } catch { return null; }
    })
    .filter((d): d is string => d !== null);

  // Normalize separators for comparison (Windows)
  const normalizedCanonical = canonical.replace(/\\/g, '/');
  return resolvedAllowed.some(allowed => {
    const normalizedAllowed = allowed.replace(/\\/g, '/');
    // Must be exactly the dir or a subpath (guard against prefix collision like /foo vs /foobar)
    return normalizedCanonical === normalizedAllowed ||
      normalizedCanonical.startsWith(normalizedAllowed + '/');
  });
}

/**
 * Build a canUseTool callback for the given filesystem mode.
 * Returns undefined for 'full' mode (no gating needed, SDK runs bypass).
 */
export function createCanUseTool(
  mode: FilesystemMode,
  allowedDirectories: string[],
  allowBash: boolean,
): CanUseTool | undefined {
  if (mode === 'full') return undefined;

  const handler: CanUseTool = async (toolName, input) => {
    // Bash family: only allowed when explicitly toggled on
    if ((BASH_TOOLS as readonly string[]).includes(toolName)) {
      if (allowBash) return { behavior: 'allow', updatedInput: input };
      return {
        behavior: 'deny',
        message: `Bash is disabled. Enable it in Settings → Permissions if you want shell access.`,
      };
    }

    // Filesystem tools: validate path against allowed directories
    if ((FS_ALL_TOOLS as readonly string[]).includes(toolName)) {
      if (mode === 'none') {
        return {
          behavior: 'deny',
          message: `Filesystem access is disabled. Enable sandbox mode in Settings → Permissions to allow reads/writes in specific directories.`,
        };
      }

      // Sandbox mode — validate path
      const rawPath = extractToolPath(toolName, input);
      if (!rawPath) {
        // No path specified (e.g. Glob without path arg uses cwd); allow only if cwd is allowed
        const cwdCanonical = canonicalize(process.cwd());
        if (cwdCanonical && isPathAllowed(cwdCanonical, allowedDirectories)) {
          return { behavior: 'allow', updatedInput: input };
        }
        return {
          behavior: 'deny',
          message: `${toolName} targets current working directory which is not in allowed directories.`,
        };
      }

      const canonical = canonicalize(rawPath);
      if (!canonical) {
        return { behavior: 'deny', message: `Could not resolve path: ${rawPath}` };
      }

      if (isPathAllowed(canonical, allowedDirectories)) {
        return { behavior: 'allow', updatedInput: input };
      }

      return {
        behavior: 'deny',
        message: `Path ${canonical} is outside allowed directories. Add it in Settings → Permissions if you want access.`,
      };
    }

    // Non-filesystem tools (WebFetch, WebSearch, MCP tools, etc.) — allow
    return { behavior: 'allow', updatedInput: input };
  };

  return handler;
}

/**
 * Get the list of tools to block entirely via disallowedTools.
 *
 * Covers three concerns:
 *   1. Filesystem mode='none' → strip Read/Write/Edit/Glob/Grep/NotebookEdit.
 *   2. allowBash=false → strip Bash/BashOutput/KillShell.
 *   3. Capability toggles off → strip that category's tools (Agent, Cron*, etc).
 *   4. No MCP connectors configured → strip ListMcpResourcesTool/ReadMcpResourceTool.
 *
 * Tools in this list don't appear in prompt context at all — that's where
 * the real token savings come from (thousands per turn for default pro
 * user who only chats with their partner).
 */
export function getDisallowedTools(
  mode: FilesystemMode,
  allowBash: boolean,
  capabilities?: Capabilities,
  hasMcpConnectors?: boolean,
): string[] {
  const disallowed: string[] = [];

  // 1. Filesystem
  if (mode === 'none') {
    disallowed.push(...FS_ALL_TOOLS);
  }

  // 2. Bash
  if (!allowBash) {
    disallowed.push(...BASH_TOOLS);
  }

  // 3. Capabilities — any toggle off → strip its tools
  if (capabilities) {
    for (const key of Object.keys(capabilities) as (keyof Capabilities)[]) {
      if (!capabilities[key]) {
        disallowed.push(...CAPABILITY_TOOLS[key]);
      }
    }
  }

  // 4. MCP resource tools — only useful if user has actually configured connectors
  if (!hasMcpConnectors) {
    disallowed.push('ListMcpResourcesTool', 'ReadMcpResourceTool');
  }

  // Dedupe (NotebookEdit can be added by both FS and capability paths)
  return Array.from(new Set(disallowed));
}
