import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';

const OPENAI_SPEECH_ENDPOINT = 'https://api.openai.com/v1/audio/speech';
// OpenAI rejects speech input longer than 4096 characters.
const MAX_INPUT_CHARS = 4096;

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
        response_format: 'opus',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenAI speech synthesis failed (${response.status}): ${errorText}`,
      );
    }

    const audio = Buffer.from(await response.arrayBuffer());
    this.logger.debug('Synthesized speech', {
      charCount: text.length,
      byteCount: audio.length,
    });
    return audio;
  }
}
