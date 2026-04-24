import { Injectable, Logger } from '@nestjs/common';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RunEventHandler } from '../callbacks/run-event-handler.interface.js';
import { extractAssistantText } from '../callbacks/extract-assistant-text.js';
import { SlackService, parseSlackSessionKey } from './slack.service.js';
import { TriggerConfigService } from '../config/trigger-config.service.js';

const FLUSH_INTERVAL_MS = 1000;

export class SlackStreamingCallbackHandler implements RunEventHandler {
  readonly name = 'slack-streaming';
  private readonly logger = new Logger(SlackStreamingCallbackHandler.name);
  private messageTs: string | null = null;
  private buffer = '';
  private lastSentText = '';
  private flushTimer: NodeJS.Timeout | null = null;
  // Tail of the serialized flush chain. All flushes link onto this to prevent
  // concurrent chat.postMessage calls from racing and posting duplicate messages.
  private flushChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly slackService: SlackService,
    private readonly botName: string,
    private readonly channelId: string,
    private readonly threadTs: string | undefined,
  ) {}

  onMessage(message: SDKMessage): void {
    if (message.type !== 'assistant') return;
    if (message.parent_tool_use_id) return;

    const text = extractAssistantText(message);
    if (!text) return;

    this.buffer = this.buffer ? this.buffer + '\n\n' + text : text;
    this.scheduleFlush();
  }

  async finalize(): Promise<void> {
    this.cancelTimer();
    await this.flushNow();
    await this.clearStatus();
  }

  async emitError(errorMessage: string): Promise<void> {
    this.cancelTimer();
    const suffix = `:warning: ${errorMessage}`;
    this.buffer = this.buffer ? this.buffer + '\n\n' + suffix : suffix;
    await this.flushNow();
    await this.clearStatus();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, FLUSH_INTERVAL_MS);
  }

  private cancelTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private flushNow(): Promise<void> {
    this.flushChain = this.flushChain.then(() => this.doFlush());
    return this.flushChain;
  }

  private async doFlush(): Promise<void> {
    if (!this.buffer || this.buffer === this.lastSentText) return;

    const client = this.slackService.getClient(this.botName);
    if (!client) {
      this.logger.warn(
        `No Slack WebClient registered for bot "${this.botName}"`,
      );
      return;
    }

    const snapshot = this.buffer;
    try {
      if (this.messageTs === null) {
        const result = await client.chat.postMessage({
          channel: this.channelId,
          text: snapshot,
          ...(this.threadTs ? { thread_ts: this.threadTs } : {}),
        });
        if (result.ts) {
          this.messageTs = result.ts;
        }
      } else {
        await client.chat.update({
          channel: this.channelId,
          ts: this.messageTs,
          text: snapshot,
        });
      }
      this.lastSentText = snapshot;
    } catch (error) {
      this.logger.error('Slack streaming flush failed', {
        error: error as Error,
        botName: this.botName,
        channelId: this.channelId,
      });
    }
  }

  private async clearStatus(): Promise<void> {
    if (!this.threadTs) return;
    await this.slackService.setStatus({
      botName: this.botName,
      channelId: this.channelId,
      threadTs: this.threadTs,
      status: '',
    });
  }
}

@Injectable()
export class SlackStreamingCallbackHandlerFactory {
  constructor(
    private readonly triggerConfigService: TriggerConfigService,
    private readonly slackService: SlackService,
  ) {}

  createForRun(
    triggerName: string,
    sessionKey: string,
  ): SlackStreamingCallbackHandler | undefined {
    const trigger = this.triggerConfigService.getSlackTrigger(triggerName);
    if (!trigger) return undefined;

    const parsed = parseSlackSessionKey(sessionKey);
    if (!parsed) return undefined;

    return new SlackStreamingCallbackHandler(
      this.slackService,
      trigger.bot_name,
      parsed.channelId,
      parsed.threadTs,
    );
  }
}
