import { Injectable, Logger } from '@nestjs/common';
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import { CallbackHandler } from '../callback-handler.interface.js';
import { FILTERED_EVENT_TYPES } from '../callback.constants.js';

const MAX_LOG_LENGTH = 500;

function truncate(text: string): string {
  if (text.length <= MAX_LOG_LENGTH) return text;
  return text.slice(0, MAX_LOG_LENGTH) + `… (${text.length} chars total)`;
}

@Injectable()
export class LoggerCallbackHandler implements CallbackHandler {
  readonly name = 'logger';
  private readonly logger = new Logger(LoggerCallbackHandler.name);

  onEvent(event: AgentSessionEvent): void {
    if (!FILTERED_EVENT_TYPES.has(event.type)) return;

    switch (event.type) {
      case 'agent_start':
        this.logger.log('Agent started');
        break;

      case 'agent_end':
        this.logger.log('Agent ended', {
          messageCount: event.messages.length,
        });
        break;

      case 'turn_start':
        this.logger.debug('Turn started');
        break;

      case 'turn_end':
        this.logger.debug('Turn ended', {
          toolResults: event.toolResults.length,
        });
        break;

      case 'message_end': {
        const msg = event.message;
        if ('role' in msg && msg.role === 'assistant' && 'content' in msg) {
          const content = msg.content as Array<{ type: string; text?: string }>;
          const textParts = content
            .filter(
              (c): c is { type: 'text'; text: string } => c.type === 'text',
            )
            .map((c) => c.text);

          if (textParts.length > 0) {
            this.logger.log('Assistant message', {
              text: truncate(textParts.join('\n')),
            });
          }

          const toolCalls = content.filter(
            (c) => c.type === 'toolCall',
          ) as Array<{
            type: 'toolCall';
            name: string;
            arguments: Record<string, unknown>;
          }>;

          for (const tc of toolCalls) {
            this.logger.log(`Tool call: ${tc.name}`, {
              args: truncate(JSON.stringify(tc.arguments)),
            });
          }
        }
        break;
      }

      case 'tool_execution_start':
        this.logger.log(`Tool started: ${event.toolName}`, {
          toolCallId: event.toolCallId,
          args: truncate(JSON.stringify(event.args)),
        });
        break;

      case 'tool_execution_end': {
        const result = event.result as
          | { content: Array<{ type: string; text?: string }> }
          | undefined;
        const resultText = result?.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('\n');

        this.logger.log(
          `Tool ended: ${event.toolName} (${event.isError ? 'error' : 'ok'})`,
          {
            toolCallId: event.toolCallId,
            result: resultText ? truncate(resultText) : undefined,
          },
        );
        break;
      }

      case 'compaction_start':
        this.logger.log('Compaction started', { reason: event.reason });
        break;

      case 'compaction_end':
        this.logger.log('Compaction ended', {
          reason: event.reason,
          aborted: event.aborted,
        });
        break;

      case 'auto_retry_start':
        this.logger.warn('Auto retry started', {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          error: event.errorMessage,
        });
        break;

      case 'auto_retry_end':
        this.logger.log('Auto retry ended', {
          success: event.success,
          attempt: event.attempt,
        });
        break;

      case 'message_start':
      case 'message_update':
      case 'tool_execution_update':
      case 'queue_update':
        // Filtered out by FILTERED_EVENT_TYPES early return above.
        break;
    }
  }
}
