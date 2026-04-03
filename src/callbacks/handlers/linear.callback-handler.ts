import { Logger } from '@nestjs/common';
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { LinearClient } from '@linear/sdk';
import type { CallbackHandler } from '../callback-handler.interface.js';

const MAX_BODY_LENGTH = 10_000;

function truncate(text: string, max = MAX_BODY_LENGTH): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

function extractToolResult(result: unknown): string {
  const typed = result as
    | { content: Array<{ type: string; text?: string }> }
    | undefined;
  return (
    typed?.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n') ?? ''
  );
}

/**
 * Per-run callback handler that posts agent activities back to Linear
 * via the Agent Interaction API.
 *
 * NOT a global handler — instantiated per webhook request with session-specific context.
 */
export class LinearCallbackHandler implements CallbackHandler {
  readonly name = 'linear';
  private readonly logger = new Logger(LinearCallbackHandler.name);
  private lastAssistantMessage: string | undefined;
  private pendingActivities: Promise<void>[] = [];

  constructor(
    private readonly agentSessionId: string,
    private readonly linearClient: LinearClient,
  ) {}

  /** Returns the last assistant message captured during the run. */
  getLastAssistantMessage(): string | undefined {
    return this.lastAssistantMessage;
  }

  async onEvent(event: AgentSessionEvent): Promise<void> {
    const activity = this.mapEventToActivity(event);
    if (!activity) return;
    const promise = this.postActivity(activity.content, activity.ephemeral);
    this.pendingActivities.push(promise);
    void promise.finally(() => {
      this.pendingActivities = this.pendingActivities.filter(
        (p) => p !== promise,
      );
    });
    await promise;
  }

  /**
   * Emit an error activity back to Linear.
   * Called by the webhook controller when the run fails.
   */
  async emitError(message: string): Promise<void> {
    await this.postActivity({ type: 'error', body: message });
  }

  /**
   * Emit a response activity back to Linear.
   * Called when the agent completes or is stopped.
   *
   * Flushes all pending activities first to prevent a race where a
   * `thought` arriving after the `response` reopens the working state.
   */
  async emitResponse(message: string): Promise<void> {
    await this.flush();
    await this.postActivity({ type: 'response', body: message });
  }

  /**
   * Wait for all in-flight activity posts to complete.
   */
  async flush(): Promise<void> {
    await Promise.allSettled(this.pendingActivities);
  }

  private mapEventToActivity(
    event: AgentSessionEvent,
  ): { content: Record<string, unknown>; ephemeral: boolean } | null {
    if (event.type === 'agent_start') {
      return {
        content: { type: 'thought', body: 'Starting work…' },
        ephemeral: false,
      };
    }
    if (event.type === 'tool_execution_start') {
      return {
        content: {
          type: 'action',
          action: event.toolName,
          parameter: truncate(JSON.stringify(event.args)),
        },
        ephemeral: true,
      };
    }
    if (event.type === 'tool_execution_end') {
      return {
        content: {
          type: 'action',
          action: event.toolName,
          result: truncate(extractToolResult(event.result)),
        },
        ephemeral: false,
      };
    }
    if (event.type === 'message_end') {
      const msg = (event as Record<string, unknown>).message as
        | { role?: string; content?: Array<{ type: string; text?: string }> }
        | undefined;
      if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
        const text = msg.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
        if (text) {
          this.lastAssistantMessage = text;
          return {
            content: { type: 'thought', body: truncate(text) },
            ephemeral: false,
          };
        }
      }
    }
    // agent_end completion is handled by the controller after execute() resolves,
    // so we don't emit a response here to avoid duplicates.
    return null;
  }

  private async postActivity(
    content: Record<string, unknown>,
    ephemeral = false,
  ): Promise<void> {
    try {
      this.logger.debug('Posting activity to Linear', {
        contentType: content['type'],
        ephemeral,
      });
      await this.linearClient.createAgentActivity({
        agentSessionId: this.agentSessionId,
        content,
        ephemeral,
      });
      this.logger.debug('Activity posted to Linear', {
        contentType: content['type'],
      });
    } catch (error) {
      this.logger.error('Failed to post activity to Linear', {
        error: error as Error,
        contentType: content['type'],
      });
    }
  }
}
