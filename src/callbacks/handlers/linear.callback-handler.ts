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

  constructor(
    private readonly agentSessionId: string,
    private readonly linearClient: LinearClient,
  ) {}

  async onEvent(event: AgentSessionEvent): Promise<void> {
    const activity = this.mapEventToActivity(event);
    if (!activity) return;
    await this.postActivity(activity.content, activity.ephemeral);
  }

  /**
   * Emit an error activity back to Linear.
   * Called by the webhook controller when the run fails.
   */
  async emitError(message: string): Promise<void> {
    await this.postActivity({ type: 'error', body: message });
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
    if (event.type === 'agent_end') {
      return {
        content: { type: 'response', body: 'Completed.' },
        ephemeral: false,
      };
    }
    return null;
  }

  private async postActivity(
    content: Record<string, unknown>,
    ephemeral = false,
  ): Promise<void> {
    try {
      await this.linearClient.createAgentActivity({
        agentSessionId: this.agentSessionId,
        content,
        ephemeral,
      });
    } catch (error) {
      this.logger.error('Failed to post activity to Linear', {
        error: error as Error,
        contentType: content['type'],
      });
    }
  }
}
