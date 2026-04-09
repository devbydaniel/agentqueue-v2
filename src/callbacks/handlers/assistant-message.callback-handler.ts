import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { CallbackHandler } from '../callback-handler.interface.js';

export class AssistantMessageCallbackHandler implements CallbackHandler {
  readonly name = 'assistant-message';
  private lastAssistantMessage: string | undefined;

  getLastAssistantMessage(): string | undefined {
    return this.lastAssistantMessage;
  }

  onEvent(event: AgentSessionEvent): void {
    if (event.type !== 'message_end') {
      return;
    }

    const msg = event.message as
      | { role?: string; content?: Array<{ type: string; text?: string }> }
      | undefined;
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) {
      return;
    }

    const text = msg.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n');

    if (text) {
      this.lastAssistantMessage = text;
    }
  }
}
