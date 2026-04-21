import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppConfigService } from '../config/app-config.service.js';

const MISTRAL_AUDIO_ENDPOINT = 'https://api.mistral.ai/v1/audio/transcriptions';

@Injectable()
export class VoxtralTranscriptionService {
  private readonly logger = new Logger(VoxtralTranscriptionService.name);

  constructor(private readonly appConfigService: AppConfigService) {}

  isAvailable(): boolean {
    return Boolean(this.appConfigService.mistralApiKey);
  }

  async transcribe(filePath: string): Promise<string> {
    const apiKey = this.appConfigService.mistralApiKey;
    if (!apiKey) {
      throw new Error(
        'MISTRAL_API_KEY not set — cannot transcribe voice messages',
      );
    }

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path comes from TelegramMediaService which writes into a controlled tmp dir
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    const boundary = `----AgentQueueBoundary${Date.now()}`;
    const parts: Buffer[] = [];

    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nvoxtral-mini-latest\r\n`,
      ),
    );

    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: audio/ogg\r\n\r\n`,
      ),
    );
    parts.push(fileBuffer);
    parts.push(Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const response = await fetch(MISTRAL_AUDIO_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Mistral transcription failed (${response.status}): ${errorText}`,
      );
    }

    const result = (await response.json()) as { text?: string };
    const text = result.text ?? '';
    this.logger.debug('Transcribed audio', {
      filePath,
      charCount: text.length,
    });
    return text;
  }
}
