import { Injectable, Logger } from '@nestjs/common';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RunEventHandler } from '../run-event-handler.interface.js';

const MAX_LOG_LENGTH = 500;

function truncate(text: string): string {
  if (text.length <= MAX_LOG_LENGTH) return text;
  return text.slice(0, MAX_LOG_LENGTH) + `… (${text.length} chars total)`;
}

@Injectable()
export class LoggerCallbackHandler implements RunEventHandler {
  readonly name = 'logger';
  private readonly logger = new Logger(LoggerCallbackHandler.name);

  onMessage(message: SDKMessage): void {
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- only logging relevant types
    switch (message.type) {
      case 'system':
        this.handleSystemMessage(message);
        break;

      case 'assistant':
        this.handleAssistantMessage(message);
        break;

      case 'result':
        this.logger.log('Run completed', {
          subtype: message.subtype,
          durationMs: message.duration_ms,
          costUsd: message.total_cost_usd,
          numTurns: message.num_turns,
          isError: message.is_error,
        });
        break;

      // All other types: skip silently
      default:
        break;
    }
  }

  private handleSystemMessage(message: SDKMessage & { type: 'system' }): void {
    if (!('subtype' in message)) return;

    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- only logging relevant subtypes
    switch (message.subtype) {
      case 'init':
        this.logger.log('Session started', {
          model: message.model,
          toolCount: message.tools.length,
          mcpServerCount: message.mcp_servers.length,
          agents: message.agents,
        });
        break;

      case 'api_retry':
        this.logger.warn('API retry', {
          attempt: message.attempt,
          maxRetries: message.max_retries,
          retryDelayMs: message.retry_delay_ms,
          error: message.error,
        });
        break;

      case 'status':
        if (message.status === 'compacting') {
          this.logger.log('Context compacting');
        }
        break;

      case 'compact_boundary':
        this.logger.log('Compaction boundary', {
          trigger: message.compact_metadata.trigger,
          preTokens: message.compact_metadata.pre_tokens,
        });
        break;

      default:
        break;
    }
  }

  private handleAssistantMessage(
    message: SDKMessage & { type: 'assistant' },
  ): void {
    const content = message.message.content;

    const textParts = content
      .filter((c) => c.type === 'text')
      .map((c) => ('text' in c ? c.text : ''));
    const text = textParts.join('\n');

    if (text) {
      this.logger.log('Assistant message', { text: truncate(text) });
    }

    for (const block of content) {
      if (block.type === 'tool_use') {
        this.logger.log(`Tool call: ${block.name}`, {
          args: truncate(JSON.stringify(block.input)),
        });
      }
    }
  }
}
