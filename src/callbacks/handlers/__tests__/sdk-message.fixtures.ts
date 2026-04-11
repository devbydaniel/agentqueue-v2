/**
 * Factory functions for SDK message fixtures used across handler tests.
 */
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

const DEFAULT_UUID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_SESSION_ID = 'test-session-id';

/** System init message with defaults. */
export function systemInit(
  overrides: Partial<SDKSystemMessage> = {},
): SDKSystemMessage {
  return {
    type: 'system',
    subtype: 'init',
    model: 'claude-sonnet-4-20250514',
    tools: ['Read', 'Write', 'Bash'],
    mcp_servers: [],
    apiKeySource: 'env_variable' as never,
    claude_code_version: '1.0.0',
    cwd: '/test',
    permissionMode: 'bypassPermissions',
    slash_commands: [],
    output_style: 'text',
    skills: [],
    plugins: [],
    uuid: DEFAULT_UUID as never,
    session_id: DEFAULT_SESSION_ID,
    ...overrides,
  };
}

/** Assistant message with text content. */
export function assistantText(
  text: string,
  overrides: Partial<SDKAssistantMessage> = {},
): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      id: 'msg-1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text, citations: null }],
      model: 'claude-sonnet-4-20250514',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    } as never,
    parent_tool_use_id: null,
    uuid: DEFAULT_UUID as never,
    session_id: DEFAULT_SESSION_ID,
    ...overrides,
  };
}

/** Assistant message with a tool_use block. */
export function assistantToolUse(
  toolName: string,
  input: Record<string, unknown>,
  toolUseId = 'tu-1',
  overrides: Partial<SDKAssistantMessage> = {},
): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      id: 'msg-2',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name: toolName, input }],
      model: 'claude-sonnet-4-20250514',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    } as never,
    parent_tool_use_id: null,
    uuid: DEFAULT_UUID as never,
    session_id: DEFAULT_SESSION_ID,
    ...overrides,
  };
}

/** Assistant message with both text and tool_use blocks. */
export function assistantMixed(
  text: string,
  toolName: string,
  input: Record<string, unknown>,
  toolUseId = 'tu-1',
): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      id: 'msg-3',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text, citations: null },
        { type: 'tool_use', id: toolUseId, name: toolName, input },
      ],
      model: 'claude-sonnet-4-20250514',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    } as never,
    parent_tool_use_id: null,
    uuid: DEFAULT_UUID as never,
    session_id: DEFAULT_SESSION_ID,
  };
}

/** User message with tool result (synthetic). */
export function userToolResult(
  toolUseId: string,
  resultText: string,
  isError = false,
): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: resultText,
          is_error: isError,
        },
      ],
    } as never,
    parent_tool_use_id: null,
    isSynthetic: true,
  };
}

/** Successful result message. */
export function resultSuccess(
  overrides: Partial<Extract<SDKResultMessage, { subtype: 'success' }>> = {},
): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    result: 'Task completed.',
    duration_ms: 5000,
    duration_api_ms: 4000,
    is_error: false,
    num_turns: 3,
    stop_reason: 'end_turn',
    total_cost_usd: 0.05,
    usage: { input_tokens: 100, output_tokens: 200 } as never,
    modelUsage: {},
    permission_denials: [],
    uuid: DEFAULT_UUID as never,
    session_id: DEFAULT_SESSION_ID,
    ...overrides,
  };
}

/** Error result message. */
export function resultError(
  errors: string[] = ['Something failed'],
  subtype:
    | 'error_during_execution'
    | 'error_max_turns' = 'error_during_execution',
): SDKResultMessage {
  return {
    type: 'result',
    subtype,
    errors,
    duration_ms: 3000,
    duration_api_ms: 2000,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0.02,
    usage: { input_tokens: 50, output_tokens: 10 } as never,
    modelUsage: {},
    permission_denials: [],
    uuid: DEFAULT_UUID as never,
    session_id: DEFAULT_SESSION_ID,
  };
}

/** API retry system message. */
export function systemApiRetry(): SDKMessage {
  return {
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 3,
    retry_delay_ms: 1000,
    error_status: 529,
    error: 'rate_limit',
    uuid: DEFAULT_UUID as never,
    session_id: DEFAULT_SESSION_ID,
  } as SDKMessage;
}

/** Compact boundary system message. */
export function systemCompactBoundary(): SDKMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: {
      trigger: 'auto',
      pre_tokens: 50000,
    },
    uuid: DEFAULT_UUID as never,
    session_id: DEFAULT_SESSION_ID,
  } as SDKMessage;
}

/** Status (compacting) system message. */
export function systemStatus(status: string | null = 'compacting'): SDKMessage {
  return {
    type: 'system',
    subtype: 'status',
    status,
    uuid: DEFAULT_UUID as never,
    session_id: DEFAULT_SESSION_ID,
  } as SDKMessage;
}

/** A noisy message type that should be skipped. */
export function streamEvent(): SDKMessage {
  return {
    type: 'stream_event',
    event: {},
    parent_tool_use_id: null,
    uuid: DEFAULT_UUID as never,
    session_id: DEFAULT_SESSION_ID,
  } as unknown as SDKMessage;
}

/** Tool progress message (noisy, should be skipped). */
export function toolProgress(): SDKMessage {
  return {
    type: 'tool_progress',
    tool_use_id: 'tu-1',
    tool_name: 'Bash',
    parent_tool_use_id: null,
    elapsed_time_seconds: 5,
    uuid: DEFAULT_UUID as never,
    session_id: DEFAULT_SESSION_ID,
  } as SDKMessage;
}
