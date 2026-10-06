import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent' with {
  'resolution-mode': 'import',
};

type MessageEndEvent = Extract<AgentSessionEvent, { type: 'message_end' }>;
export type AgentMessage = MessageEndEvent['message'];
export type AssistantMessage = Extract<AgentMessage, { role: 'assistant' }>;
export type ToolCall = Extract<
  AssistantMessage['content'][number],
  { type: 'toolCall' }
>;

/**
 * The completed assistant message carried by a `message_end` event, or
 * undefined for every other event. Streaming partials (`message_update`) are
 * ignored — `message_end` holds the authoritative message.
 */
export function assistantMessageOf(
  event: AgentSessionEvent,
): AssistantMessage | undefined {
  if (event.type !== 'message_end') return undefined;
  return event.message.role === 'assistant' ? event.message : undefined;
}

/**
 * Concatenated text from an assistant message's text blocks.
 * Returns undefined if there are no text blocks.
 */
export function extractAssistantText(
  message: AssistantMessage,
): string | undefined {
  const text = message.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  return text || undefined;
}

export function toolCallsOf(message: AssistantMessage): ToolCall[] {
  return message.content.filter((c): c is ToolCall => c.type === 'toolCall');
}
