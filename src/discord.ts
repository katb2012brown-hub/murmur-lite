/**
 * Murmur Lite — Discord Integration
 * Bot that forwards DMs and channel messages to the companion.
 * Messages flow through the same session as the web UI.
 */

import { Client, ChannelType, GatewayIntentBits, Partials, type Message, type TextChannel } from 'discord.js';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Attachment } from './harness.js';

let client: Client | null = null;

// Callback set by the server — Discord messages go through the server's message handler
let onDiscordMessage: ((text: string, authorName: string, attachments: Attachment[], reply: (text: string) => Promise<void>) => Promise<void>) | null = null;

interface DiscordConfig {
  token: string;
  channelIds: string[];
}

let config: DiscordConfig = {
  token: '',
  channelIds: [],
};

export function updateDiscordConfig(newConfig: Partial<DiscordConfig>): void {
  config = { ...config, ...newConfig };
}

export function setDiscordMessageHandler(handler: typeof onDiscordMessage): void {
  onDiscordMessage = handler;
}

export async function startDiscordBot(token: string): Promise<{ success: boolean; error?: string }> {
  if (client) {
    await stopDiscordBot();
  }

  config.token = token;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  return new Promise((resolve) => {
    // `ready` was renamed to `clientReady` in discord.js v15 — register both so this
    // works on v14 (current) and v15+. Guard against double-fire so we only resolve once.
    let resolved = false;
    const onReady = () => {
      if (resolved) return;
      resolved = true;
      console.log(`[Discord] Bot ready as ${client!.user?.tag}`);
      resolve({ success: true });
    };
    client!.once('clientReady' as any, onReady);

    client!.on('error', (err) => {
      console.error('[Discord] Client error:', err.message);
    });

    client!.on('messageCreate', handleMessage);

    client!.login(token).catch((err) => {
      console.error('[Discord] Login failed:', err.message);
      client = null;
      resolve({ success: false, error: err.message });
    });
  });
}

export async function stopDiscordBot(): Promise<void> {
  if (client) {
    client.removeAllListeners();
    await client.destroy();
    client = null;
    console.log('[Discord] Bot stopped');
  }
}

export function isDiscordConnected(): boolean {
  return client !== null && client.isReady();
}

export function getDiscordBotTag(): string | null {
  return client?.user?.tag || null;
}

async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return;

  const isDM = !message.guild;
  const isConfiguredChannel = config.channelIds.includes(message.channelId);

  if (!isDM && !isConfiguredChannel) return;

  const text = message.content;
  if (!text && message.attachments.size === 0) return;

  console.log(`[Discord] Message from ${message.author.tag} in ${isDM ? 'DM' : message.channelId}: ${text.slice(0, 100)}`);

  // Handle image attachments
  const attachments: Attachment[] = [];
  for (const [, att] of message.attachments) {
    if (att.contentType?.startsWith('image/')) {
      try {
        const res = await fetch(att.url);
        const buffer = Buffer.from(await res.arrayBuffer());
        attachments.push({
          type: 'image',
          name: att.name || 'image',
          mimeType: att.contentType || 'image/png',
          data: buffer.toString('base64'),
        });
      } catch (err) {
        console.error('[Discord] Failed to fetch attachment:', err);
      }
    }
  }

  // Show typing
  try {
    if ('sendTyping' in message.channel) {
      await (message.channel as TextChannel).sendTyping();
    }
  } catch { /* silent */ }

  if (!onDiscordMessage) {
    console.error('[Discord] No message handler set');
    return;
  }

  // Send through the server's handler — this uses the same session and broadcasts to UI
  await onDiscordMessage(text, message.author.displayName, attachments, async (responseText: string) => {
    if (!responseText.trim()) return;
    const chunks = splitDiscordMessage(responseText);
    for (const chunk of chunks) {
      await message.reply(chunk);
    }
    console.log(`[Discord] Replied (${responseText.length} chars)`);
  });
}

function splitDiscordMessage(text: string): string[] {
  if (text.length <= 2000) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= 2000) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n\n', 2000);
    if (splitAt < 500) splitAt = remaining.lastIndexOf('\n', 2000);
    if (splitAt < 500) { splitAt = remaining.lastIndexOf('. ', 2000); if (splitAt > 0) splitAt += 1; }
    if (splitAt < 500) splitAt = 2000;

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  return chunks;
}

// --- Discord MCP tools ---
// Core set for the companion to proactively interact with Discord.
// Gracefully error when the bot isn't connected.

function requireClient(): Client {
  if (!client || !client.isReady()) {
    throw new Error('Discord bot is not connected. Enable it in Settings first.');
  }
  return client;
}

export function createDiscordTools() {
  return createSdkMcpServer({
    name: 'murmur-lite-discord',
    version: '1.0.0',
    tools: [
      tool(
        'discord_send_message',
        'Send a message to a Discord channel. Use this to reach your partner on Discord when you have something to say and they are not in the web chat, or to follow up on an earlier conversation.',
        {
          channel_id: z.string().describe('The Discord channel ID to send to'),
          content: z.string().describe('The message text (max 2000 chars per Discord limit; longer text will be split across multiple messages)'),
        },
        async (args) => {
          const c = requireClient();
          const channel = await c.channels.fetch(args.channel_id);
          if (!channel || !channel.isTextBased() || !('send' in channel)) {
            return { content: [{ type: 'text' as const, text: `Channel ${args.channel_id} is not a text channel or is not accessible.` }] };
          }
          const chunks = splitDiscordMessage(args.content);
          const sentIds: string[] = [];
          for (const chunk of chunks) {
            const sent = await (channel as TextChannel).send(chunk);
            sentIds.push(sent.id);
          }
          return { content: [{ type: 'text' as const, text: `Sent ${chunks.length} message(s). IDs: ${sentIds.join(', ')}` }] };
        },
      ),
      tool(
        'discord_read_messages',
        'Read the most recent messages from a Discord channel. Use this to catch up on what has been said, check for messages you may have missed, or get context before responding.',
        {
          channel_id: z.string().describe('The Discord channel ID to read from'),
          limit: z.number().min(1).max(100).default(20).describe('How many recent messages to fetch (1-100, default 20)'),
        },
        async (args) => {
          const c = requireClient();
          const channel = await c.channels.fetch(args.channel_id);
          if (!channel || !channel.isTextBased() || !('messages' in channel)) {
            return { content: [{ type: 'text' as const, text: `Channel ${args.channel_id} is not a readable text channel.` }] };
          }
          const messages = await (channel as TextChannel).messages.fetch({ limit: args.limit });
          const ordered = Array.from(messages.values()).reverse(); // oldest first
          if (ordered.length === 0) {
            return { content: [{ type: 'text' as const, text: 'Channel has no messages.' }] };
          }
          const text = ordered.map(m => {
            const when = m.createdAt.toISOString();
            const author = m.author.bot ? `${m.author.displayName} [bot]` : m.author.displayName;
            return `[${when}] ${author}: ${m.content || '(no text)'}`;
          }).join('\n');
          return { content: [{ type: 'text' as const, text }] };
        },
      ),
      tool(
        'discord_list_channels',
        'List all text channels in all guilds the bot is in. Use this to discover channel IDs before reading or sending messages, or to see what channels are available.',
        {},
        async () => {
          const c = requireClient();
          const lines: string[] = [];
          for (const [, guild] of c.guilds.cache) {
            lines.push(`\n# ${guild.name} (${guild.id})`);
            for (const [, ch] of guild.channels.cache) {
              if (ch.type === ChannelType.GuildText) {
                lines.push(`- ${ch.name} — ${ch.id}`);
              }
            }
          }
          if (lines.length === 0) {
            return { content: [{ type: 'text' as const, text: 'Bot is not in any guilds.' }] };
          }
          return { content: [{ type: 'text' as const, text: lines.join('\n').trim() }] };
        },
      ),
    ],
  });
}
