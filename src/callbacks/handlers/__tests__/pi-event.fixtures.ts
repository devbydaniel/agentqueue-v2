/**
 * Factory functions for pi session event fixtures used across handler tests.
 */
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent' with {
  'resolution-mode': 'import',
};
import type { SessionStartInfo } from '../../run-event-handler.interface.js';
import type {
  AgentMessage,
  AssistantMessage,
  ToolCall,
} from '../../pi-messages.js';

const DEFAULT_TIMESTAMP = 1_700_000_000_000;

/** Session facts passed to RunEventHandler.onStart. */
export function sessionStart(
  overrides: Partial<SessionStartInfo> = {},
): SessionStartInfo {
  return {
    sessionId: 'test-session-id',
    model: 'anthropic/claude-opus-5-5',
    tools: ['read', 'bash', 'edit', 'write'],
    ...overrides,
  };
}

/** A completed assistant message. */
export function assistantMessage(
  content: AssistantMessage['content'],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: DEFAULT_TIMESTAMP,
    ...overrides,
  };
}

/** `message_end` event wrapping any message. */
export function messageEnd(message: AgentMessage): AgentSessionEvent {
  return { type: 'message_end', message };
}

/** `message_end` for an assistant message with one text block. */
export function assistantText(
  text: string,
  overrides: Partial<AssistantMessage> = {},
): AgentSessionEvent {
  return messageEnd(assistantMessage([{ type: 'text', text }], overrides));
}

/** `message_end` for an assistant message with one tool call. */
export function assistantToolCall(
  name: string,
  args: ToolCall['arguments'],
  id = 'tc-1',
): AgentSessionEvent {
  return messageEnd(
    assistantMessage([{ type: 'toolCall', id, name, arguments: args }], {
      stopReason: 'toolUse',
    }),
  );
}

/** `message_end` for an assistant message with text and a tool call. */
export function assistantMixed(
  text: string,
  name: string,
  args: ToolCall['arguments'],
  id = 'tc-1',
): AgentSessionEvent {
  return messageEnd(
    assistantMessage(
      [
        { type: 'text', text },
        { type: 'toolCall', id, name, arguments: args },
      ],
      { stopReason: 'toolUse' },
    ),
  );
}

/** `message_end` for an assistant turn that failed at the provider. */
export function assistantError(errorMessage: string): AgentSessionEvent {
  return messageEnd(
    assistantMessage([], { stopReason: 'error', errorMessage }),
  );
}

/** `message_end` for a tool result. */
export function toolResult(
  toolCallId: string,
  text: string,
  isError = false,
): AgentSessionEvent {
  return messageEnd({
    role: 'toolResult',
    toolCallId,
    toolName: 'bash',
    content: [{ type: 'text', text }],
    isError,
    timestamp: DEFAULT_TIMESTAMP,
  } as AgentMessage);
}

export function autoRetryStart(): AgentSessionEvent {
  return {
    type: 'auto_retry_start',
    attempt: 1,
    maxAttempts: 3,
    delayMs: 1000,
    errorMessage: 'overloaded',
  };
}

export function compactionStart(): AgentSessionEvent {
  return { type: 'compaction_start', reason: 'threshold' };
}

/** A streaming partial — noisy, should be skipped by persistence. */
export function messageUpdate(): AgentSessionEvent {
  return {
    type: 'message_update',
    message: assistantMessage([{ type: 'text', text: 'partial' }], {
      stopReason: 'pending',
    }),
    assistantMessageEvent: { type: 'text_delta' },
  } as unknown as AgentSessionEvent;
}

export function agentSettled(): AgentSessionEvent {
  return { type: 'agent_settled' };
}
