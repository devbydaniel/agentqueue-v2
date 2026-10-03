import { Injectable, Logger } from '@nestjs/common';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RunEventHandler } from '../callbacks/run-event-handler.interface.js';
import { extractAssistantText } from '../callbacks/extract-assistant-text.js';
import { TriggerConfigService } from '../config/trigger-config.service.js';
import { MatrixService, type MatrixTarget } from './matrix.service.js';
import {
  editOf,
  inThread,
  parseSessionKey,
  renderMessage,
  splitOversized,
} from './matrix-content.js';

const UPDATE_INTERVAL_MS = 1000;

/**
 * Streams a run's assistant text into Matrix: the first update posts a
 * message, later ones edit it in place (`m.replace`). Text that outgrows one
 * event is frozen and continued in a fresh message.
 */
export class MatrixStreamingCallbackHandler implements RunEventHandler {
  readonly name = 'matrix-streaming';
  private readonly logger = new Logger(MatrixStreamingCallbackHandler.name);
  private buffer = '';
  /** Offset into `buffer` of text already frozen in earlier messages. */
  private frozenUpTo = 0;
  private currentEventId: string | null = null;
  private currentText = '';
  private lastAssistantText = '';
  private timer: NodeJS.Timeout | null = null;
  // Updates are chained so a slow send can't race the next edit.
  private updateChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly matrixService: MatrixService,
    private readonly target: MatrixTarget,
    private readonly sessionKey: string,
  ) {}

  onMessage(message: SDKMessage): void {
    if (message.type !== 'assistant' || message.parent_tool_use_id) return;
    const text = extractAssistantText(message);
    if (!text) return;
    this.lastAssistantText = text;
    this.buffer = this.buffer ? `${this.buffer}\n\n${text}` : text;
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.queueUpdate();
    }, UPDATE_INTERVAL_MS);
  }

  async finalize(): Promise<void> {
    this.buffer ||= 'Completed.';
    await this.settle();
    if (
      await this.matrixService.isVoiceEnabled(
        this.target.botName,
        this.target.roomId,
      )
    ) {
      await this.matrixService.sendVoiceNote(
        this.target,
        this.lastAssistantText || this.buffer,
      );
    }
  }

  async emitError(errorMessage: string): Promise<void> {
    const notice = `⚠️ ${errorMessage}`;
    this.buffer = this.buffer ? `${this.buffer}\n\n${notice}` : notice;
    await this.settle();
  }

  private async settle(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.queueUpdate();
    this.matrixService.stopTyping(this.sessionKey);
  }

  private queueUpdate(): Promise<void> {
    this.updateChain = this.updateChain.then(() => this.update());
    return this.updateChain;
  }

  private async update(): Promise<void> {
    const client = this.matrixService.getClient(this.target.botName);
    if (!client) return;
    try {
      let pending = this.buffer.slice(this.frozenUpTo);
      let [head, rest] = splitOversized(pending);
      while (rest) {
        await this.write(head);
        this.frozenUpTo = this.buffer.length - rest.length;
        this.currentEventId = null;
        this.currentText = '';
        pending = rest;
        [head, rest] = splitOversized(pending);
      }
      await this.write(head);
    } catch (error) {
      this.logger.error('Matrix streaming update failed', {
        error: error as Error,
        roomId: this.target.roomId,
      });
    }
  }

  private async write(text: string): Promise<void> {
    if (!text || text === this.currentText) return;
    const client = this.matrixService.getClient(this.target.botName)!;
    const rendered = renderMessage(text);
    if (this.currentEventId === null) {
      this.currentEventId = await client.sendMessage(
        this.target.roomId,
        inThread(rendered, this.target.threadRootId),
      );
    } else {
      await client.sendMessage(
        this.target.roomId,
        editOf(this.currentEventId, rendered),
      );
    }
    this.currentText = text;
  }
}

@Injectable()
export class MatrixStreamingCallbackHandlerFactory {
  constructor(
    private readonly triggerConfigService: TriggerConfigService,
    private readonly matrixService: MatrixService,
  ) {}

  createForRun(
    triggerName: string,
    sessionKey: string,
  ): MatrixStreamingCallbackHandler | undefined {
    if (!this.triggerConfigService.getMatrixTrigger(triggerName)) {
      return undefined;
    }
    const parsed = parseSessionKey(sessionKey);
    if (!parsed) return undefined;
    return new MatrixStreamingCallbackHandler(
      this.matrixService,
      parsed,
      sessionKey,
    );
  }
}
