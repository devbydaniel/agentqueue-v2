import { Injectable, Logger } from '@nestjs/common';
import { WebClient } from '@slack/web-api';

const SLACK_MESSAGE_CHUNK_SIZE = 38_000;

function chunkMessage(text: string): string[] {
  if (text.length <= SLACK_MESSAGE_CHUNK_SIZE) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let next = remaining.slice(0, SLACK_MESSAGE_CHUNK_SIZE);
    if (remaining.length > SLACK_MESSAGE_CHUNK_SIZE) {
      const splitAt = next.lastIndexOf('\n');
      if (splitAt > 0) {
        next = next.slice(0, splitAt);
      }
    }
    chunks.push(next);
    remaining = remaining.slice(next.length).trimStart();
  }
  return chunks;
}

export function parseSlackSessionKey(sessionKey: string): {
  botName: string;
  channelId: string;
  threadTs: string | undefined;
} | null {
  if (!sessionKey.startsWith('slack:')) return null;
  const parts = sessionKey.split(':');
  if (parts.length < 4) return null;
  const [, botName, channelId] = parts;
  const threadTs = parts.slice(3).join(':');
  return {
    botName,
    channelId,
    threadTs: threadTs === 'main' ? undefined : threadTs,
  };
}

@Injectable()
export class SlackService {
  private readonly logger = new Logger(SlackService.name);
  private readonly clients = new Map<string, WebClient>();

  registerClient(botName: string, client: WebClient): void {
    this.clients.set(botName, client);
  }

  getClient(botName: string): WebClient | undefined {
    return this.clients.get(botName);
  }

  async sendDirectMessage(params: {
    botName: string;
    channelId: string;
    text: string;
    threadTs?: string;
  }): Promise<void> {
    const client = this.clients.get(params.botName);
    if (!client) {
      this.logger.warn(
        `No Slack WebClient registered for bot "${params.botName}"`,
      );
      return;
    }

    const chunks = chunkMessage(params.text);
    for (const chunk of chunks) {
      await client.chat.postMessage({
        channel: params.channelId,
        text: chunk,
        ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
      });
    }
  }

  // Slack's setStatus API only accepts calls inside assistant threads; swallow
  // errors so callers that speculatively set status on regular DMs don't fail.
  async setStatus(params: {
    botName: string;
    channelId: string;
    threadTs: string;
    status: string;
  }): Promise<void> {
    const client = this.clients.get(params.botName);
    if (!client) return;

    try {
      await client.assistant.threads.setStatus({
        channel_id: params.channelId,
        thread_ts: params.threadTs,
        status: params.status,
      });
    } catch (error) {
      this.logger.debug('Slack setStatus failed (non-assistant thread?)', {
        error: error as Error,
        botName: params.botName,
      });
    }
  }
}
