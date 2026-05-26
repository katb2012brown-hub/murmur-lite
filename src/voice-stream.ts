/**
 * Live Voice Mode — Cartesia Sonic 3 WebSocket streaming
 * Receives text chunks from LLM, streams audio back in real-time
 */

import Cartesia from '@cartesia/cartesia-js';

// Translate raw Cartesia/SDK error messages into something a user can act on.
// Cartesia surfaces "Payment Required" / "402" for out-of-credits, which means
// nothing to someone who doesn't know what HTTP status codes are.
function classifyVoiceError(err: any): string {
  const msg = String(err?.message || err?.code || err);
  if (/402|insufficient|credit|payment.required|payment_required|quota/i.test(msg)) {
    return 'Cartesia voice credits exhausted. Top up at cartesia.ai/account, or disable Live Voice in Settings → Voice.';
  }
  if (/401|unauthor|invalid.api.?key|forbidden|invalid.?token/i.test(msg)) {
    return 'Cartesia API key invalid or missing. Check Settings → Voice.';
  }
  if (/429|rate.?limit|too.many.requests/i.test(msg)) {
    return 'Cartesia rate limited. Wait a moment and retry.';
  }
  if (/voice.*not.*found|invalid.voice|voice.id/i.test(msg)) {
    return 'Selected Cartesia voice not found. Pick another in Settings → Voice.';
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network|fetch.failed/i.test(msg)) {
    return 'Network error reaching Cartesia. Check your connection.';
  }
  return 'Voice mode failed: ' + msg;
}

interface VoiceStreamConfig {
  apiKey: string;
  voiceId: string;
  speed?: number;
  emotion?: string;
  onAudioChunk: (base64Audio: string) => void;
  onError: (error: string) => void;
  onDone: () => void;
}

export class VoiceStream {
  private client: any;
  private ws: any;
  private ctx: any;
  private config: VoiceStreamConfig;
  private buffer: string = '';
  private active: boolean = false;
  private receiving: boolean = false;

  constructor(config: VoiceStreamConfig) {
    this.config = config;
    this.client = new Cartesia({ apiKey: config.apiKey });
  }

  // Returns true on success, false on failure. Callers MUST check the return value
  // before broadcasting voice_start — failing silently here is what made out-of-credit
  // errors look like a frozen UI (server broadcast voice_start despite no audio coming).
  async start(): Promise<boolean> {
    try {
      this.ws = await this.client.tts.websocket();

      const voiceConfig: any = {
        mode: 'id',
        id: this.config.voiceId,
      };

      const generationConfig: any = {
        speed: this.config.speed ?? 1.0,
      };
      if (this.config.emotion) {
        generationConfig.emotion = this.config.emotion;
      }

      this.ctx = this.ws.context({
        model_id: 'sonic-3',
        voice: voiceConfig,
        output_format: {
          container: 'raw',
          encoding: 'pcm_f32le',
          sample_rate: 24000,
        },
        generation_config: generationConfig,
      });

      this.active = true;
      this.buffer = '';

      // Start receiving audio in background
      this.receiving = true;
      this.receiveAudio().catch((err) => {
        if (this.active) {
          console.error('[Voice] Receive error:', err.message);
          this.config.onError(classifyVoiceError(err));
        }
      });

      console.log('[Voice] Stream started');
      return true;
    } catch (err: any) {
      console.error('[Voice] Failed to start:', err.message);
      this.config.onError(classifyVoiceError(err));
      this.active = false;
      return false;
    }
  }

  private async receiveAudio(): Promise<void> {
    try {
      for await (const event of this.ctx.receive()) {
        if (!this.active) break;
        if (event.type === 'chunk' && (event as any).audio) {
          const b64 = Buffer.from((event as any).audio).toString("base64");
          this.config.onAudioChunk(b64);
        } else if ((event as any).type === 'error') {
          // Only log Cartesia error events — these are rare and worth surfacing.
          console.error('[Voice][CartesiaError]', JSON.stringify(event));
        }
      }
    } catch (err: any) {
      if (this.active) {
        console.error('[Voice] Receive error:', err.message);
      }
    } finally {
      this.receiving = false;
      this.config.onDone();
    }
  }

  // Cartesia enforces a per-push transcript cap (~2000 chars). Any single push over
  // that silently truncates, which shows up as "last 2-3 sentences not voiced" when
  // a long unpunctuated buffer gets flushed at finish(). This helper splits at
  // sentence/comma/word boundaries so no single push exceeds the safe limit.
  private async safePush(text: string): Promise<void> {
    if (!this.active || !this.ctx) return;
    const LIMIT = 1800; // leaves headroom under Cartesia's ~2000 cap
    const parts: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= LIMIT) { parts.push(remaining); break; }
      let cut = remaining.lastIndexOf('. ', LIMIT);
      if (cut < 300) cut = remaining.lastIndexOf('! ', LIMIT);
      if (cut < 300) cut = remaining.lastIndexOf('? ', LIMIT);
      if (cut < 300) cut = remaining.lastIndexOf(', ', LIMIT);
      if (cut < 300) cut = remaining.lastIndexOf(' ', LIMIT);
      if (cut < 100) { cut = LIMIT; } else { cut = cut + 1; }
      parts.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    for (const part of parts) {
      if (!part) continue;
      try {
        // flush: true here means "generate audio for what's been pushed so far".
        // Per Cartesia SDK: each push is sent with continue:true (more text coming),
        // and flush:true triggers an immediate flush so audio streams in real time.
        // Removing it (an earlier mistake) caused audio to buffer until no_more_inputs.
        await this.ctx.push({ transcript: part, flush: true });
      } catch (err: any) {
        if (this.active) {
          console.error('[Voice] Push error:', err.message);
        }
      }
    }
  }

  async pushText(text: string): Promise<void> {
    if (!this.active || !this.ctx) return;

    this.buffer += text;

    // Flush on sentence boundaries for natural speech rhythm
    const sentenceEnd = /[.!?]\s*$/;
    const commaBreak = /,\s*$/;

    if (sentenceEnd.test(this.buffer) || (this.buffer.length > 150 && commaBreak.test(this.buffer))) {
      const toSend = this.buffer;
      this.buffer = '';
      await this.safePush(toSend);
    }
  }

  async finish(): Promise<void> {
    if (!this.active || !this.ctx) return;
    // DO NOT set active = false here — the receive loop checks it
    // Let the receive loop end naturally when the iterator completes

    try {
      // Flush any remaining buffered text (safePush splits so we never exceed Cartesia's cap)
      if (this.buffer.trim()) {
        await this.safePush(this.buffer);
        this.buffer = '';
      }
      // Signal no more text — receive loop will end when all audio is delivered
      await this.ctx.no_more_inputs();
    } catch (err: any) {
      console.error('[Voice] Finish error:', err.message);
    }

    // Wait for the receive loop to actually drain. The previous fixed 10s timeout
    // was cutting long responses (30s+ of audio) mid-playback. Poll this.receiving
    // instead — the receive loop's finally block sets it false once Cartesia signals
    // done. Hard cap at 120s as a safety net so we don't leak forever if Cartesia hangs.
    const startedAt = Date.now();
    const HARD_CAP_MS = 120_000;
    while (this.receiving && (Date.now() - startedAt) < HARD_CAP_MS) {
      await new Promise(r => setTimeout(r, 200));
    }
    if (this.receiving) {
      console.warn('[Voice] Receive loop did not complete within 120s — closing anyway');
    }
    this.active = false;
    try { this.ws?.close(); } catch {}
  }

  abort(): void {
    this.active = false;
    this.buffer = '';
    try { this.ws?.close(); } catch {}
  }
}
