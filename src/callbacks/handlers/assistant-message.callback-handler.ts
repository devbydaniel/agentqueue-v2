import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RunEventHandler } from '../run-event-handler.interface.js';
import { extractAssistantText } from '../extract-assistant-text.js';

export class AssistantMessageCallbackHandler implements RunEventHandler {
  readonly name = 'assistant-message';
  private lastAssistantMessage: string | undefined;

  getLastAssistantMessage(): string | undefined {
    return this.lastAssistantMessage;
  }

  onMessage(message: SDKMessage): void {
    if (message.type !== 'assistant') return;

    const text = extractAssistantText(message);
    if (text) {
      this.lastAssistantMessage = text;
    }
  }
}
