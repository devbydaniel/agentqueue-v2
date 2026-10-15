import { Injectable, Logger } from '@nestjs/common';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent' with {
  'resolution-mode': 'import',
};
import type { RunEventHandler } from '../callbacks/run-event-handler.interface.js';
import {
  assistantMessageOf,
  extractAssistantText,
} from '../callbacks/pi-messages.js';
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
 * event is frozen and continued in a fresh message, as is the reply after a
 * message steered into the run, so it reads below that message.
 */
export class MatrixStreamingCallbackHandler implements RunEventHandler {
  readonly name = 'matrix-streaming';
  private readonly logger = new Logger(MatrixStreamingCallbackHandler.name);
  /** The reply text since the last steer; earlier segments are already posted. */
  private segment = newSegment();
  /** Whether any segment was closed by a steer (so text was already posted). */
  private hasClosedSegments = false;
  private lastAssistantText = '';
  private timer: NodeJS.Timeout | null = null;
  // Updates are chained so a slow send can't race the next edit.
  private updateChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly matrixService: MatrixService,
    private readonly target: MatrixTarget,
    private readonly sessionKey: string,
  ) {}

  onEvent(event: AgentSessionEvent): void {
    if (isSteeredUserMessage(event)) {
      this.closeSegment();
      return;
    }
    const message = assistantMessageOf(event);
    if (!message) return;
    const text = extractAssistantText(message);
    if (!text) return;
    this.lastAssistantText = text;
    const segment = this.segment;
    segment.buffer = segment.buffer ? `${segment.buffer}\n\n${text}` : text;
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.queueUpdate();
    }, UPDATE_INTERVAL_MS);
  }

  /**
   * A message was steered into the run: post what was written so far and
   * continue the reply in a new message, below the user's message.
   */
  private closeSegment(): void {
    if (!this.segment.buffer) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.queueUpdate();
    this.segment = newSegment();
    this.hasClosedSegments = true;
  }

  async finalize(): Promise<void> {
    if (!this.hasClosedSegments) this.segment.buffer ||= 'Completed.';
    await this.settle();
    if (
      await this.matrixService.isVoiceEnabled(
        this.target.botName,
        this.target.roomId,
      )
    ) {
      await this.matrixService.sendVoiceNote(
        this.target,
        this.lastAssistantText || this.segment.buffer,
      );
    }
  }

  async emitError(errorMessage: string): Promise<void> {
    const notice = `⚠️ ${errorMessage}`;
    const segment = this.segment;
    segment.buffer = segment.buffer ? `${segment.buffer}\n\n${notice}` : notice;
    await this.settle();
  }

  private async settle(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.queueUpdate();
    this.matrixService.stopTyping(this.sessionKey);
  }

  private queueUpdate(): Promise<void> {
    // Bind the segment now: a steer may replace it before the update runs.
    const segment = this.segment;
    this.updateChain = this.updateChain.then(() => this.update(segment));
    return this.updateChain;
  }

  private async update(segment: Segment): Promise<void> {
    const client = this.matrixService.getClient(this.target.botName);
    if (!client) return;
    try {
      let pending = segment.buffer.slice(segment.frozenUpTo);
      let [head, rest] = splitOversized(pending);
      while (rest) {
        await this.write(segment, head);
        segment.frozenUpTo = segment.buffer.length - rest.length;
        segment.currentEventId = null;
        segment.currentText = '';
        pending = rest;
        [head, rest] = splitOversized(pending);
      }
      await this.write(segment, head);
    } catch (error) {
      this.logger.error('Matrix streaming update failed', {
        error: error as Error,
        roomId: this.target.roomId,
      });
    }
  }

  private async write(segment: Segment, text: string): Promise<void> {
    if (!text || text === segment.currentText) return;
    const client = this.matrixService.getClient(this.target.botName)!;
    const rendered = renderMessage(text);
    if (segment.currentEventId === null) {
      segment.currentEventId = await client.sendMessage(
        this.target.roomId,
        inThread(rendered, this.target.threadRootId),
      );
    } else {
      await client.sendMessage(
        this.target.roomId,
        editOf(segment.currentEventId, rendered),
      );
    }
    segment.currentText = text;
  }
}

/** The part of a reply between two steers, posted as one or more messages. */
interface Segment {
  buffer: string;
  /** Offset into `buffer` of text already frozen in earlier messages. */
  frozenUpTo: number;
  currentEventId: string | null;
  currentText: string;
}

function newSegment(): Segment {
  return { buffer: '', frozenUpTo: 0, currentEventId: null, currentText: '' };
}

/**
 * A user message placed mid-run. The run's own prompt is placed before any
 * reply text, so closeSegment() ignores it.
 */
function isSteeredUserMessage(event: AgentSessionEvent): boolean {
  return event.type === 'message_end' && event.message.role === 'user';
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
