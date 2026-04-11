import { LinearCallbackHandler } from './linear.callback-handler.js';
import {
  assistantText,
  assistantToolUse,
  assistantMixed,
  resultSuccess,
  systemInit,
  userToolResult,
} from './__tests__/sdk-message.fixtures.js';

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

  it('should emit a thought activity for assistant text', async () => {
    await handler.onMessage(assistantText('Working on the issue…'));

    expect(mockCreateAgentActivity).toHaveBeenCalledWith({
      agentSessionId: sessionId,
      content: { type: 'thought', body: 'Working on the issue…' },
      ephemeral: false,
    });
  });

  it('should emit an ephemeral action activity for tool_use', async () => {
    await handler.onMessage(
      assistantToolUse('Read', { file_path: '/src/index.ts' }),
    );

    expect(mockCreateAgentActivity).toHaveBeenCalledWith({
      agentSessionId: sessionId,
      content: {
        type: 'action',
        action: 'Read',
        parameter: '{"file_path":"/src/index.ts"}',
      },
      ephemeral: true,
    });
  });

  it('should emit both thought and action for mixed assistant messages', async () => {
    await handler.onMessage(
      assistantMixed('Let me read that file.', 'Read', {
        file_path: '/test.ts',
      }),
    );

    expect(mockCreateAgentActivity).toHaveBeenCalledTimes(2);
    expect(mockCreateAgentActivity).toHaveBeenNthCalledWith(1, {
      agentSessionId: sessionId,
      content: { type: 'thought', body: 'Let me read that file.' },
      ephemeral: false,
    });
    expect(mockCreateAgentActivity).toHaveBeenNthCalledWith(2, {
      agentSessionId: sessionId,
      content: {
        type: 'action',
        action: 'Read',
        parameter: '{"file_path":"/test.ts"}',
      },
      ephemeral: true,
    });
  });

  it('should capture lastAssistantMessage from text blocks', async () => {
    await handler.onMessage(assistantText('Final answer here'));

    expect(handler.getLastAssistantMessage()).toBe('Final answer here');
  });

  it('should ignore subagent messages (parent_tool_use_id set)', async () => {
    await handler.onMessage(
      assistantText('subagent response', {
        parent_tool_use_id: 'tu-parent',
      }),
    );

    expect(mockCreateAgentActivity).not.toHaveBeenCalled();
  });

  it('should not emit on non-assistant messages', async () => {
    await handler.onMessage(systemInit());
    await handler.onMessage(userToolResult('tu-1', 'result'));
    await handler.onMessage(resultSuccess());

    expect(mockCreateAgentActivity).not.toHaveBeenCalled();
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

    await expect(
      handler.onMessage(assistantText('test')),
    ).resolves.toBeUndefined();
  });

  describe('flush / emitResponse ordering', () => {
    it('should flush pending activities before emitting a response', async () => {
      const callOrder: string[] = [];
      let resolveThought: () => void;
      const thoughtPromise = new Promise<void>((r) => {
        resolveThought = r;
      });

      const mockImpl = async (input: { content: { type: string } }) => {
        if (input.content.type === 'thought') {
          await thoughtPromise;
          callOrder.push('thought');
          return;
        }
        callOrder.push(input.content.type);
      };
      mockCreateAgentActivity.mockImplementation(mockImpl);

      const eventPromise = handler.onMessage(assistantText('Thinking…'));
      const responsePromise = handler.emitResponse('Done!');

      expect(callOrder).toEqual([]);

      resolveThought!();
      await eventPromise;
      await responsePromise;

      expect(callOrder).toEqual(['thought', 'response']);
    });

    it('should not fail emitResponse if a pending activity rejects', async () => {
      mockCreateAgentActivity
        .mockRejectedValueOnce(new Error('API error'))
        .mockResolvedValueOnce({});

      await handler.onMessage(assistantText('test'));

      await expect(handler.emitResponse('Done!')).resolves.toBeUndefined();
    });
  });
});
