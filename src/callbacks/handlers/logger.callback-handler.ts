import { Injectable, Logger } from '@nestjs/common';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent' with {
  'resolution-mode': 'import',
};
import type {
  RunEventHandler,
  SessionStartInfo,
} from '../run-event-handler.interface.js';
import {
  assistantMessageOf,
  extractAssistantText,
  toolCallsOf,
  type AssistantMessage,
} from '../pi-messages.js';

const MAX_LOG_LENGTH = 500;

function truncate(text: string): string {
  if (text.length <= MAX_LOG_LENGTH) return text;
  return text.slice(0, MAX_LOG_LENGTH) + `… (${text.length} chars total)`;
}

@Injectable()
export class LoggerCallbackHandler implements RunEventHandler {
  readonly name = 'logger';
  private readonly logger = new Logger(LoggerCallbackHandler.name);

  onStart(info: SessionStartInfo): void {
    this.logger.log('Session started', {
      sessionId: info.sessionId,
      model: info.model,
      toolCount: info.tools.length,
    });
  }

  onEvent(event: AgentSessionEvent): void {
    const assistant = assistantMessageOf(event);
    if (assistant) {
      this.handleAssistantMessage(assistant);
      return;
    }

    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- only logging relevant types
    switch (event.type) {
      case 'auto_retry_start':
        this.logger.warn('API retry', {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          error: event.errorMessage,
        });
        break;

      case 'compaction_start':
        this.logger.log('Context compacting', { reason: event.reason });
        break;

      case 'compaction_end':
        this.logger.log('Compaction finished', {
          reason: event.reason,
          aborted: event.aborted,
          error: event.errorMessage,
        });
        break;

      case 'agent_settled':
        this.logger.log('Run settled');
        break;

      default:
        break;
    }
  }

  private handleAssistantMessage(message: AssistantMessage): void {
    const text = extractAssistantText(message);
    if (text) {
      this.logger.log('Assistant message', { text: truncate(text) });
    }

    for (const call of toolCallsOf(message)) {
      this.logger.log(`Tool call: ${call.name}`, {
        args: truncate(JSON.stringify(call.arguments)),
      });
    }

    if (message.stopReason === 'error') {
      this.logger.error('Assistant turn failed', {
        error: message.errorMessage,
      });
    }
  }
}
