import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import { LinearCallbackHandler } from './linear.callback-handler.js';

const mockCreateAgentActivity = jest.fn().mockResolvedValue({});

const mockLinearClient = {
  createAgentActivity: mockCreateAgentActivity,
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- inline mock type
} as unknown as import('@linear/sdk').LinearClient;

describe('LinearCallbackHandler', () => {
  let handler: LinearCallbackHandler;
  const sessionId = 'test-session-123';

  beforeEach(() => {
    jest.clearAllMocks();
    handler = new LinearCallbackHandler(sessionId, mockLinearClient);
  });

  it('should have name "linear"', () => {
    expect(handler.name).toBe('linear');
  });

  it('should emit a thought activity on agent_start', async () => {
    await handler.onEvent({ type: 'agent_start' } as AgentSessionEvent);

    expect(mockCreateAgentActivity).toHaveBeenCalledWith({
      agentSessionId: sessionId,
      content: { type: 'thought', body: 'Starting work…' },
      ephemeral: false,
    });
  });

  it('should emit an ephemeral action activity on tool_execution_start', async () => {
    await handler.onEvent({
      type: 'tool_execution_start',
      toolName: 'read_file',
      toolCallId: 'tc-1',
      args: { path: '/src/index.ts' },
    } as unknown as AgentSessionEvent);

    expect(mockCreateAgentActivity).toHaveBeenCalledWith({
      agentSessionId: sessionId,
      content: {
        type: 'action',
        action: 'read_file',
        parameter: '{"path":"/src/index.ts"}',
      },
      ephemeral: true,
    });
  });

  it('should emit an action activity with result on tool_execution_end', async () => {
    await handler.onEvent({
      type: 'tool_execution_end',
      toolName: 'read_file',
      toolCallId: 'tc-1',
      args: { path: '/src/index.ts' },
      isError: false,
      result: {
        content: [{ type: 'text', text: 'file contents here' }],
      },
    } as unknown as AgentSessionEvent);

    expect(mockCreateAgentActivity).toHaveBeenCalledWith({
      agentSessionId: sessionId,
      content: {
        type: 'action',
        action: 'read_file',
        result: 'file contents here',
      },
      ephemeral: false,
    });
  });

  it('should emit a response activity on agent_end', async () => {
    await handler.onEvent({
      type: 'agent_end',
      messages: [],
    } as unknown as AgentSessionEvent);

    expect(mockCreateAgentActivity).toHaveBeenCalledWith({
      agentSessionId: sessionId,
      content: { type: 'response', body: 'Completed.' },
      ephemeral: false,
    });
  });

  it('should emit an error activity via emitError()', async () => {
    await handler.emitError('Run failed: something went wrong');

    expect(mockCreateAgentActivity).toHaveBeenCalledWith({
      agentSessionId: sessionId,
      content: { type: 'error', body: 'Run failed: something went wrong' },
      ephemeral: false,
    });
  });

  it('should swallow and log Linear API errors without throwing', async () => {
    mockCreateAgentActivity.mockRejectedValueOnce(new Error('API error'));

    // Should not throw
    await expect(
      handler.onEvent({ type: 'agent_start' } as AgentSessionEvent),
    ).resolves.toBeUndefined();
  });

  it('should not trigger API calls for unhandled event types', async () => {
    const ignoredEvents: AgentSessionEvent['type'][] = [
      'turn_start',
      'turn_end',
      'message_start',
      'message_update',
      'message_end',
      'tool_execution_update',
      'compaction_start',
      'compaction_end',
      'auto_retry_start',
      'auto_retry_end',
      'queue_update',
    ];

    for (const eventType of ignoredEvents) {
      await handler.onEvent({ type: eventType } as AgentSessionEvent);
    }

    expect(mockCreateAgentActivity).not.toHaveBeenCalled();
  });

  it('should handle tool_execution_end with no result', async () => {
    await handler.onEvent({
      type: 'tool_execution_end',
      toolName: 'bash',
      toolCallId: 'tc-2',
      args: { command: 'ls' },
      isError: false,
      result: undefined,
    } as unknown as AgentSessionEvent);

    expect(mockCreateAgentActivity).toHaveBeenCalledWith({
      agentSessionId: sessionId,
      content: {
        type: 'action',
        action: 'bash',
        result: '',
      },
      ephemeral: false,
    });
  });
});
