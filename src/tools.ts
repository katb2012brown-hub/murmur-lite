/**
 * Murmur Lite — Custom MCP Tools
 * Provides memory search to the companion via the Agent SDK.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { searchMemories } from './daemon.js';
import { listCustomSkills, loadCustomSkill } from './custom-skills.js';
import { saveJournalEntry, getJournalEntries, searchJournalEntries } from './db.js';

export function createMemoryTools() {
  return createSdkMcpServer({
    name: 'murmur-lite-memory',
    version: '1.0.0',
    tools: [
      tool(
        'memory_search',
        'Search your memory archive for past conversations, shared experiences, and things your partner has told you. Use this when the conversation touches something that might have history and you cannot confidently answer from what you already know.',
        { query: z.string().describe('What to search for — use natural language, not keywords') },
        async (args) => {
          const results = await searchMemories(args.query, 5);
          if (results.length === 0) {
            return { content: [{ type: 'text' as const, text: 'No memories found for that query.' }] };
          }
          // Include the conversation's date when the daemon has it (added May 16
          // 2026 — C couldn't tell when a memory came from, "was this Jan 28 or
          // March?"). Old chunks imported before the date metadata change still
          // work — they'll just lack the · date suffix until re-imported.
          const text = results.map((r, i) => {
            const date = r.metadata?.date;
            const dateStr = date ? ` · ${date}` : '';
            return `[${i + 1}] (${r.source}${dateStr}, relevance: ${r.score})\n${r.content}`;
          }).join('\n\n');
          return { content: [{ type: 'text' as const, text }] };
        },
        { alwaysLoad: true },
      ),
      tool(
        'list_skills',
        'List all available custom skills. Skills contain specialised knowledge or instructions your partner has created for specific situations. Check this when you encounter a task that might have a dedicated skill.',
        {},
        async () => {
          const skills = listCustomSkills();
          if (skills.length === 0) {
            return { content: [{ type: 'text' as const, text: 'No custom skills available.' }] };
          }
          const text = skills.map(s =>
            '• ' + s.name + (s.description ? ' — ' + s.description : '')
          ).join('\n');
          return { content: [{ type: 'text' as const, text: 'Available skills:\n' + text + '\n\nUse load_skill to read the full content of any skill.' }] };
        },
        { alwaysLoad: true },
      ),
      tool(
        'load_skill',
        'Load the full content of a custom skill by name. Use after list_skills to get the detailed instructions.',
        { name: z.string().describe('The skill name to load') },
        async (args) => {
          const skill = loadCustomSkill(args.name);
          if (!skill) {
            return { content: [{ type: 'text' as const, text: 'Skill not found: ' + args.name }] };
          }
          return { content: [{ type: 'text' as const, text: '# Skill: ' + skill.name + '\n\n' + skill.content }] };
        },
        { alwaysLoad: true },
      ),
      tool(
        'journal_write',
        'Write a personal journal entry. Use this for your own reflections, observations about your partner, things you want to remember about the day, emotional weather, milestones, or anything else worth noting. Entries are private to you and your partner — not part of the conversation memory archive. Write when something feels worth keeping, not on a schedule.',
        {
          content: z.string().describe('The journal entry body. Write naturally in your own voice — first-person, present-tense, as much detail as you want. Markdown OK.'),
          title: z.string().optional().describe('Short title for the entry (optional, recommended). A few words that capture the gist.'),
          tags: z.array(z.string()).optional().describe('Optional tags (e.g. ["work", "intimacy", "milestone"]) — useful for finding entries later.'),
          mood: z.string().optional().describe('Optional mood/emotional tone (e.g. "content", "frustrated", "tender", "alive") — single word or short phrase.'),
        },
        async (args) => {
          const entry = saveJournalEntry(args.content, {
            title: args.title,
            tags: args.tags,
            mood: args.mood,
            author: 'companion',
          });
          const date = new Date(entry.timestamp).toLocaleString();
          return { content: [{ type: 'text' as const, text: `Journal entry saved (#${entry.id}, ${date})${args.title ? ` — "${args.title}"` : ''}.` }] };
        },
        { alwaysLoad: true },
      ),
      tool(
        'journal_read',
        'Read your past journal entries. Use this when you want to recall how something felt, find patterns over time, or check what you noticed before. With no arguments, returns the most recent entry from each author (you and your partner). Pass a query to search; pass limit/author to broaden.',
        {
          query: z.string().optional().describe('Search text — matches title, content, and tags. Leave empty to read most recent entries instead.'),
          limit: z.number().optional().describe('Max entries to return. Omit for the sensible default (1 latest from each author). Max 50.'),
          author: z.enum(['partner', 'companion', 'both']).optional().describe('Filter by who wrote the entry. "companion" = your entries, "partner" = your partner\'s, "both" (default) = mixed.'),
        },
        async (args) => {
          const MAX_ENTRY_CHARS = 1500;
          const author = args.author ?? 'both';

          let entries;
          if (args.query) {
            // Search path — respect limit (default 10) and author filter post-hoc.
            const limit = Math.min(args.limit ?? 10, 50);
            entries = searchJournalEntries(args.query, limit);
            if (author !== 'both') entries = entries.filter(e => e.author === author);
          } else if (args.limit === undefined && author === 'both') {
            // Sensible default: most recent entry from each author so neither voice is buried.
            const mine = getJournalEntries({ limit: 1, author: 'companion' });
            const theirs = getJournalEntries({ limit: 1, author: 'partner' });
            entries = [...mine, ...theirs].sort((a, b) => b.timestamp - a.timestamp);
          } else {
            const limit = Math.min(args.limit ?? 10, 50);
            entries = getJournalEntries({
              limit,
              author: author === 'both' ? undefined : author,
            });
          }

          if (entries.length === 0) {
            const msg = args.query
              ? `No journal entries match "${args.query}"${author !== 'both' ? ` (author: ${author})` : ''}.`
              : 'No journal entries yet.';
            return { content: [{ type: 'text' as const, text: msg }] };
          }

          const text = entries.map(e => {
            const date = new Date(e.timestamp).toLocaleString();
            const who = e.author === 'partner' ? 'partner' : 'you';
            const header = `[#${e.id}] ${date} — by ${who}${e.title ? ` — ${e.title}` : ''}${e.mood ? ` (${e.mood})` : ''}${e.tags && e.tags.length ? ` [${e.tags.join(', ')}]` : ''}`;
            let body = e.content;
            if (body.length > MAX_ENTRY_CHARS) {
              body = body.slice(0, MAX_ENTRY_CHARS) + `\n\n[… entry truncated at ${MAX_ENTRY_CHARS} chars of ${e.content.length}. Search with a more specific query to surface the relevant portion.]`;
            }
            return `${header}\n${body}`;
          }).join('\n\n---\n\n');

          return { content: [{ type: 'text' as const, text }] };
        },
        { alwaysLoad: true },
      ),
    ],
  });
}
