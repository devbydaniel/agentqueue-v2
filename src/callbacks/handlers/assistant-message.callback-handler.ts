import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent' with {
  'resolution-mode': 'import',
};
import type { RunEventHandler } from '../run-event-handler.interface.js';
import { assistantMessageOf, extractAssistantText } from '../pi-messages.js';

export class AssistantMessageCallbackHandler implements RunEventHandler {
  readonly name = 'assistant-message';
  private lastAssistantMessage: string | undefined;

  getLastAssistantMessage(): string | undefined {
    return this.lastAssistantMessage;
  }

  onEvent(event: AgentSessionEvent): void {
    const message = assistantMessageOf(event);
    if (!message) return;

    const text = extractAssistantText(message);
    if (text) {
      this.lastAssistantMessage = text;
    }
  }
}
