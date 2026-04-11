import { startObservation } from '@langfuse/tracing';
import {
  LangfuseCallbackHandler,
  LangfuseCallbackHandlerFactory,
  type LangfuseTraceableRun,
  type LangfuseTraceContext,
} from './langfuse.callback-handler.js';
import {
  assistantText,
  assistantToolUse,
  assistantMixed,
  resultSuccess,
  resultError,
  systemInit,
  systemApiRetry,
  systemCompactBoundary,
  userToolResult,
} from './__tests__/sdk-message.fixtures.js';

const mockEnd = jest.fn();
const mockUpdate = jest.fn().mockReturnThis();
const mockToolSpan = { update: jest.fn().mockReturnThis(), end: jest.fn() };
const mockGeneration = { end: jest.fn() };
const mockEvent = { end: jest.fn() };

const mockRootSpan = {
  update: mockUpdate,
  end: mockEnd,
  startObservation: jest.fn(
    (_name: string, _opts?: unknown, extra?: { asType?: string }) => {
      if (extra?.asType === 'tool') return mockToolSpan;
      if (extra?.asType === 'generation') return mockGeneration;
      if (extra?.asType === 'event') return mockEvent;
      return mockEvent;
    },
  ),
};

jest.mock('@langfuse/tracing', () => ({
  startObservation: jest.fn(() => mockRootSpan),
}));

describe('LangfuseCallbackHandler', () => {
  const defaultContext: LangfuseTraceContext = {
    traceName: 'test-run',
    tags: ['source:test'],
    metadata: { runId: 'run-123', source: 'test', repoName: 'my-repo' },
  };

  let handler: LangfuseCallbackHandler;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRootSpan.startObservation.mockClear();
    mockToolSpan.update.mockReturnThis();
    handler = new LangfuseCallbackHandler(defaultContext, true);
  });

  it('should not create spans when disabled', () => {
    const disabled = new LangfuseCallbackHandler(defaultContext, false);
    disabled.onMessage(systemInit());
    expect(startObservation).not.toHaveBeenCalled();
  });

  it('should start root span on system init', () => {
    handler.onMessage(systemInit({ model: 'claude-opus-4-20250514' }));

    expect(startObservation).toHaveBeenCalledWith('test-run', {
      input: { event: 'init' },
      metadata: expect.objectContaining({
        model: 'claude-opus-4-20250514',
        toolCount: 3,
        mcpServerCount: 0,
      }),
    });
  });

  it('should create a generation span for assistant text', () => {
    handler.onMessage(systemInit());
    handler.onMessage(assistantText('Hello world'));

    expect(mockRootSpan.startObservation).toHaveBeenCalledWith(
      'assistant-message',
      expect.objectContaining({ output: 'Hello world' }),
      { asType: 'generation' },
    );
    expect(mockGeneration.end).toHaveBeenCalled();
  });

  it('should open a tool span for tool_use blocks', () => {
    handler.onMessage(systemInit());
    handler.onMessage(
      assistantToolUse('Read', { file_path: '/test.ts' }, 'tu-1'),
    );

    expect(mockRootSpan.startObservation).toHaveBeenCalledWith(
      'Read',
      expect.objectContaining({
        input: '{"file_path":"/test.ts"}',
      }),
      { asType: 'tool' },
    );
  });

  it('should close tool span when matching user tool_result arrives', () => {
    handler.onMessage(systemInit());
    handler.onMessage(
      assistantToolUse('Read', { file_path: '/test.ts' }, 'tu-1'),
    );
    handler.onMessage(userToolResult('tu-1', 'file contents'));

    expect(mockToolSpan.update).toHaveBeenCalledWith({
      output: 'file contents',
      metadata: { isError: false },
    });
    expect(mockToolSpan.end).toHaveBeenCalled();
  });

  it('should record compact_boundary as an event', () => {
    handler.onMessage(systemInit());
    handler.onMessage(systemCompactBoundary());

    expect(mockRootSpan.startObservation).toHaveBeenCalledWith(
      'compaction',
      expect.objectContaining({
        metadata: { trigger: 'auto', preTokens: 50000 },
      }),
      { asType: 'event' },
    );
    expect(mockEvent.end).toHaveBeenCalled();
  });

  it('should record api_retry as an event', () => {
    handler.onMessage(systemInit());
    handler.onMessage(systemApiRetry());

    expect(mockRootSpan.startObservation).toHaveBeenCalledWith(
      'api-retry',
      expect.objectContaining({
        metadata: expect.objectContaining({
          attempt: 1,
          maxRetries: 3,
        }),
      }),
      { asType: 'event' },
    );
  });

  it('should close root span on success result', () => {
    handler.onMessage(systemInit());
    handler.onMessage(resultSuccess());

    expect(mockUpdate).toHaveBeenCalledWith({
      output: expect.objectContaining({
        subtype: 'success',
        costUsd: 0.05,
        numTurns: 3,
      }),
    });
    expect(mockEnd).toHaveBeenCalled();
  });

  it('should close root span on error result with errors array', () => {
    handler.onMessage(systemInit());
    handler.onMessage(resultError(['Task failed']));

    expect(mockUpdate).toHaveBeenCalledWith({
      output: expect.objectContaining({
        subtype: 'error_during_execution',
        errors: ['Task failed'],
      }),
    });
    expect(mockEnd).toHaveBeenCalled();
  });

  it('should handle mixed assistant messages (text + tool_use)', () => {
    handler.onMessage(systemInit());
    handler.onMessage(
      assistantMixed('Let me check…', 'Read', { file_path: '/a.ts' }),
    );

    // generation + tool
    expect(mockRootSpan.startObservation).toHaveBeenCalledWith(
      'assistant-message',
      expect.any(Object),
      { asType: 'generation' },
    );
    expect(mockRootSpan.startObservation).toHaveBeenCalledWith(
      'Read',
      expect.any(Object),
      { asType: 'tool' },
    );
  });

  describe('onComplete safety net', () => {
    it('should close root span if still open', () => {
      handler.onMessage(systemInit());
      // Skip result message — simulate error path
      handler.onComplete(resultSuccess());

      expect(mockUpdate).toHaveBeenCalledWith({
        output: expect.objectContaining({ subtype: 'success' }),
      });
      expect(mockEnd).toHaveBeenCalled();
    });

    it('should close root span with aborted output when result is undefined', () => {
      handler.onMessage(systemInit());
      handler.onComplete(undefined);

      expect(mockUpdate).toHaveBeenCalledWith({
        output: { aborted: true },
      });
      expect(mockEnd).toHaveBeenCalled();
    });

    it('should close orphaned tool spans on abort', () => {
      handler.onMessage(systemInit());
      handler.onMessage(
        assistantToolUse('Bash', { command: 'ls' }, 'tu-orphan'),
      );
      // No user tool_result arrives — session aborted mid-tool
      handler.onComplete(undefined);

      expect(mockToolSpan.update).toHaveBeenCalledWith({
        metadata: { aborted: true },
      });
      expect(mockToolSpan.end).toHaveBeenCalled();
    });

    it('should not fail if root span already closed', () => {
      handler.onMessage(systemInit());
      handler.onMessage(resultSuccess()); // closes root span
      mockUpdate.mockClear();
      mockEnd.mockClear();

      // Should not throw or double-close
      expect(() => handler.onComplete(resultSuccess())).not.toThrow();
      expect(mockEnd).not.toHaveBeenCalled();
    });
  });
});

describe('LangfuseCallbackHandlerFactory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function makeRun(
    overrides: Partial<LangfuseTraceableRun> = {},
  ): LangfuseTraceableRun {
    return {
      id: 'run-123',
      source: 'manual',
      triggerName: null,
      parentFlowRunId: null,
      cwd: '/home/user/dev/my-repo',
      externalSessionId: null,
      ...overrides,
    };
  }

  it('should build source and trigger tags for linear runs with shared session ids', () => {
    const factory = new LangfuseCallbackHandlerFactory({
      langfuseEnabled: true,
    } as never);

    const context = factory.buildTraceContext(
      makeRun({
        source: 'linear',
        triggerName: 'triage-agent',
        externalSessionId: 'linear-session-1',
      }),
    );

    expect(context).toEqual({
      traceName: 'linear-run',
      tags: ['source:linear', 'trigger:triage-agent', 'session:shared'],
      metadata: {
        runId: 'run-123',
        source: 'linear',
        repoName: 'my-repo',
        triggerName: 'triage-agent',
        externalSessionId: 'linear-session-1',
      },
      sessionId: 'linear-session-1',
    });
  });

  it('should group flow child runs by parentFlowRunId', () => {
    const factory = new LangfuseCallbackHandlerFactory({
      langfuseEnabled: true,
    } as never);

    const context = factory.buildTraceContext(
      makeRun({
        source: 'flow',
        parentFlowRunId: 'flow-run-99',
      }),
    );

    expect(context).toEqual({
      traceName: 'flow-run',
      tags: ['source:flow', 'flow:child', 'session:shared'],
      metadata: {
        runId: 'run-123',
        source: 'flow',
        repoName: 'my-repo',
        parentFlowRunId: 'flow-run-99',
      },
      sessionId: 'flow-run-99',
    });
  });

  it('should mark manual runs as ephemeral sessions', () => {
    const factory = new LangfuseCallbackHandlerFactory({
      langfuseEnabled: true,
    } as never);

    const context = factory.buildTraceContext(makeRun());

    expect(context).toEqual({
      traceName: 'manual-run',
      tags: ['source:manual', 'session:ephemeral'],
      metadata: {
        runId: 'run-123',
        source: 'manual',
        repoName: 'my-repo',
      },
      sessionId: undefined,
    });
  });

  it('should not create Langfuse spans when tracing is disabled', () => {
    const factory = new LangfuseCallbackHandlerFactory({
      langfuseEnabled: false,
    } as never);

    const { handler } = factory.createForRun(makeRun());
    handler.onMessage(systemInit());

    expect(startObservation).not.toHaveBeenCalled();
  });

  it('should start the root span with the per-run trace name and metadata', () => {
    const factory = new LangfuseCallbackHandlerFactory({
      langfuseEnabled: true,
    } as never);

    const { handler } = factory.createForRun(
      makeRun({
        source: 'telegram',
        triggerName: 'daniel-assistant',
        externalSessionId: 'telegram:bot:123:main',
      }),
    );
    handler.onMessage(systemInit());

    expect(startObservation).toHaveBeenCalledWith('telegram-run', {
      input: { event: 'init' },
      metadata: expect.objectContaining({
        runId: 'run-123',
        source: 'telegram',
        repoName: 'my-repo',
        triggerName: 'daniel-assistant',
        externalSessionId: 'telegram:bot:123:main',
      }),
    });
  });
});
