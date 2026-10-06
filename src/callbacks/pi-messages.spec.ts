import {
  assistantMessageOf,
  extractAssistantText,
  toolCallsOf,
} from './pi-messages.js';
import {
  agentSettled,
  assistantMessage,
  assistantText,
  assistantToolCall,
  messageEnd,
  messageUpdate,
  toolResult,
} from './handlers/__tests__/pi-event.fixtures.js';

describe('pi-messages', () => {
  describe('assistantMessageOf', () => {
    it('should return the assistant message from message_end', () => {
      expect(assistantMessageOf(assistantText('hi'))).toMatchObject({
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
      });
    });

    it('should ignore non-assistant messages', () => {
      expect(assistantMessageOf(toolResult('tc-1', 'out'))).toBeUndefined();
      expect(
        assistantMessageOf(
          messageEnd({ role: 'user', content: 'hello', timestamp: 0 }),
        ),
      ).toBeUndefined();
    });

    it('should ignore events other than message_end', () => {
      expect(assistantMessageOf(messageUpdate())).toBeUndefined();
      expect(assistantMessageOf(agentSettled())).toBeUndefined();
    });
  });

  describe('extractAssistantText', () => {
    it('should join text blocks with newlines and skip other blocks', () => {
      const message = assistantMessage([
        { type: 'text', text: 'first' },
        { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: {} },
        { type: 'text', text: 'second' },
      ]);

      expect(extractAssistantText(message)).toBe('first\nsecond');
    });

    it('should return undefined when there are no text blocks', () => {
      const message = assistantMessage([
        { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: {} },
      ]);

      expect(extractAssistantText(message)).toBeUndefined();
    });

    it('should return undefined for empty content', () => {
      expect(extractAssistantText(assistantMessage([]))).toBeUndefined();
    });
  });

  describe('toolCallsOf', () => {
    it('should return only tool call blocks', () => {
      const message = assistantMessageOf(
        assistantToolCall('read', { path: '/a.ts' }, 'tc-9'),
      )!;

      expect(toolCallsOf(message)).toEqual([
        {
          type: 'toolCall',
          id: 'tc-9',
          name: 'read',
          arguments: { path: '/a.ts' },
        },
      ]);
    });

    it('should return an empty array when there are no tool calls', () => {
      expect(
        toolCallsOf(assistantMessage([{ type: 'text', text: 'hi' }])),
      ).toEqual([]);
    });
  });
});
