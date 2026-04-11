import { Logger } from '@nestjs/common';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { LinearClient } from '@linear/sdk';
import type { RunEventHandler } from '../run-event-handler.interface.js';

const MAX_BODY_LENGTH = 10_000;

function truncate(text: string, max = MAX_BODY_LENGTH): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

/**
 * Per-run callback handler that posts agent activities back to Linear
 * via the Agent Interaction API.
 *
 * NOT a global handler — instantiated per webhook request with session-specific context.
 */
export class LinearCallbackHandler implements RunEventHandler {
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

  async onMessage(message: SDKMessage): Promise<void> {
    if (message.type !== 'assistant') return;

    // Ignore subagent messages to avoid noise in Linear
    if (message.parent_tool_use_id) return;

    const activities = this.mapAssistantToActivities(message);
    for (const activity of activities) {
      const promise = this.postActivity(activity.content, activity.ephemeral);
      this.pendingActivities.push(promise);
      void promise.finally(() => {
        this.pendingActivities = this.pendingActivities.filter(
          (p) => p !== promise,
        );
      });
      await promise;
    }
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

  /**
   * Flush pending activities on session completion.
   * Called by the run processor in a finally block.
   */
  async onComplete(): Promise<void> {
    await this.flush();
  }

  private mapAssistantToActivities(
    message: SDKMessage & { type: 'assistant' },
  ): Array<{ content: Record<string, unknown>; ephemeral: boolean }> {
    const activities: Array<{
      content: Record<string, unknown>;
      ephemeral: boolean;
    }> = [];
    const content = message.message.content;

    // Extract text blocks → thought activity
    const textParts = content
      .filter((c) => c.type === 'text')
      .map((c) => ('text' in c ? c.text : ''));
    const text = textParts.join('\n');

    if (text) {
      this.lastAssistantMessage = text;
      activities.push({
        content: { type: 'thought', body: truncate(text) },
        ephemeral: false,
      });
    }

    // Extract tool_use blocks → action activities (ephemeral)
    for (const block of content) {
      if (block.type === 'tool_use') {
        activities.push({
          content: {
            type: 'action',
            action: block.name,
            parameter: truncate(JSON.stringify(block.input)),
          },
          ephemeral: true,
        });
      }
    }

    return activities;
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
