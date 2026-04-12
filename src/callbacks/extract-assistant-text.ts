import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Extract concatenated text from an assistant message's content blocks.
 * Returns undefined if there are no text blocks.
 */
export function extractAssistantText(
  message: SDKMessage & { type: 'assistant' },
): string | undefined {
  const text = message.message.content
    .filter((c) => c.type === 'text')
    .map((c) => ('text' in c ? c.text : ''))
    .join('\n');
  return text || undefined;
}
