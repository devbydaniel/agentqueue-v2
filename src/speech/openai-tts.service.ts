import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';

const OPENAI_SPEECH_ENDPOINT = 'https://api.openai.com/v1/audio/speech';
// OpenAI rejects speech input longer than 4096 characters.
const MAX_INPUT_CHARS = 4096;

/** Sample rate of OpenAI's raw `pcm` output (16-bit signed LE, mono). */
export const OPENAI_PCM_SAMPLE_RATE = 24_000;

@Injectable()
export class OpenaiTtsService {
  private readonly logger = new Logger(OpenaiTtsService.name);

  constructor(private readonly appConfigService: AppConfigService) {}

  isAvailable(): boolean {
    return Boolean(this.appConfigService.openaiApiKey);
  }

  /**
   * Synthesize speech as Ogg/Opus, which Telegram `sendVoice` accepts directly
   * (no transcoding needed). Throws if the API key is missing or the call fails.
   */
  async synthesize(text: string): Promise<Buffer> {
    const response = await this.requestSpeech(text, 'opus');
    const audio = Buffer.from(await response.arrayBuffer());
    this.logger.debug('Synthesized speech', {
      charCount: text.length,
      byteCount: audio.length,
    });
    return audio;
  }

  /**
   * Synthesize speech as raw PCM (OPENAI_PCM_SAMPLE_RATE, 16-bit LE, mono)
   * and yield it as it arrives, so playback can start before the whole
   * utterance is rendered. Every yielded chunk holds whole samples.
   */
  async *streamPcm(text: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
    const response = await this.requestSpeech(text, 'pcm', signal);
    if (!response.body) return;
    let carry: Buffer = Buffer.alloc(0);
    for await (const chunk of response.body) {
      const data = Buffer.concat([carry, chunk]);
      const whole = data.length - (data.length % 2);
      carry = data.subarray(whole);
      if (whole > 0) yield data.subarray(0, whole);
    }
  }

  private async requestSpeech(
    text: string,
    format: 'opus' | 'pcm',
    signal?: AbortSignal,
  ): Promise<Response> {
    const apiKey = this.appConfigService.openaiApiKey;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY not set — cannot synthesize speech');
    }

    const response = await fetch(OPENAI_SPEECH_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.appConfigService.openaiTtsModel,
        voice: this.appConfigService.openaiTtsVoice,
        input: text.slice(0, MAX_INPUT_CHARS),
        response_format: format,
      }),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenAI speech synthesis failed (${response.status}): ${errorText}`,
      );
    }
    return response;
  }
}
