import { trace } from '@opentelemetry/api';
import {
  TracingEnrichmentHandler,
  TracingEnrichmentHandlerFactory,
} from './tracing-enrichment.callback-handler.js';
import {
  systemInit,
  systemApiRetry,
  systemCompactBoundary,
  resultSuccess,
} from './__tests__/sdk-message.fixtures.js';
import type { TraceContext } from '../build-trace-context.js';

const mockSetAttribute = jest.fn();
const mockAddEvent = jest.fn();
const mockEnd = jest.fn();

const mockSpan = {
  setAttribute: mockSetAttribute,
  addEvent: mockAddEvent,
  end: mockEnd,
};

jest.mock('@opentelemetry/api', () => {
  const actual = jest.requireActual('@opentelemetry/api');
  return {
    ...actual,
    trace: {
      getSpan: jest.fn(() => mockSpan),
      getTracer: jest.fn(() => ({
        startActiveSpan: jest.fn(
          (_name: string, fn: (span: unknown) => unknown) => fn(mockSpan),
        ),
      })),
    },
    context: {
      active: jest.fn(),
    },
  };
});

describe('TracingEnrichmentHandler', () => {
  const defaultContext: TraceContext = {
    traceName: 'test-run',
    tags: ['source:test'],
    metadata: { runId: 'run-123', source: 'test', repoName: 'my-repo' },
  };

  let handler: TracingEnrichmentHandler;

  beforeEach(() => {
    jest.clearAllMocks();
    handler = new TracingEnrichmentHandler(defaultContext, true);
  });

  it('should not enrich when disabled', () => {
    const disabled = new TracingEnrichmentHandler(defaultContext, false);
    disabled.onMessage(systemInit());
    expect(mockSetAttribute).not.toHaveBeenCalled();
  });

  it('should set run attributes on system init', () => {
    handler.onMessage(systemInit({ model: 'claude-opus-4-20250514' }));

    expect(mockSetAttribute).toHaveBeenCalledWith('run.id', 'run-123');
    expect(mockSetAttribute).toHaveBeenCalledWith('run.source', 'test');
    expect(mockSetAttribute).toHaveBeenCalledWith('run.repo_name', 'my-repo');
    expect(mockSetAttribute).toHaveBeenCalledWith('run.trace_name', 'test-run');
    expect(mockSetAttribute).toHaveBeenCalledWith('run.tags', ['source:test']);
    expect(mockSetAttribute).toHaveBeenCalledWith(
      'run.model',
      'claude-opus-4-20250514',
    );
    expect(mockSetAttribute).toHaveBeenCalledWith('run.tool_count', 3);
    expect(mockSetAttribute).toHaveBeenCalledWith('run.mcp_server_count', 0);
  });

  it('should set session_id when present in context', () => {
    const ctxWithSession: TraceContext = {
      ...defaultContext,
      sessionId: 'linear-session-1',
    };
    const h = new TracingEnrichmentHandler(ctxWithSession, true);
    h.onMessage(systemInit());

    expect(mockSetAttribute).toHaveBeenCalledWith(
      'run.session_id',
      'linear-session-1',
    );
  });

  it('should set trigger_name when present in metadata', () => {
    const ctxWithTrigger: TraceContext = {
      ...defaultContext,
      metadata: { ...defaultContext.metadata, triggerName: 'my-trigger' },
    };
    const h = new TracingEnrichmentHandler(ctxWithTrigger, true);
    h.onMessage(systemInit());

    expect(mockSetAttribute).toHaveBeenCalledWith(
      'run.trigger_name',
      'my-trigger',
    );
  });

  it('should add compaction event', () => {
    handler.onMessage(systemInit());
    handler.onMessage(systemCompactBoundary());

    expect(mockAddEvent).toHaveBeenCalledWith('compaction', {
      trigger: 'auto',
      pre_tokens: 50000,
    });
  });

  it('should add api-retry event', () => {
    handler.onMessage(systemInit());
    handler.onMessage(systemApiRetry());

    expect(mockAddEvent).toHaveBeenCalledWith(
      'api-retry',
      expect.objectContaining({
        attempt: 1,
        max_retries: 3,
      }),
    );
  });

  describe('onComplete', () => {
    it('should set result attributes when result is provided', () => {
      handler.onComplete(resultSuccess());

      expect(mockSetAttribute).toHaveBeenCalledWith('run.subtype', 'success');
      expect(mockSetAttribute).toHaveBeenCalledWith('run.cost_usd', 0.05);
    });

    it('should set aborted attribute when result is undefined', () => {
      handler.onComplete(undefined);

      expect(mockSetAttribute).toHaveBeenCalledWith('run.aborted', true);
    });

    it('should not set attributes when disabled', () => {
      const disabled = new TracingEnrichmentHandler(defaultContext, false);
      disabled.onComplete(resultSuccess());

      expect(mockSetAttribute).not.toHaveBeenCalled();
    });
  });
});

describe('TracingEnrichmentHandlerFactory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should create handler with enabled=true when tracing is configured', () => {
    const factory = new TracingEnrichmentHandlerFactory({
      tracingProvider: 'langfuse',
    } as never);

    const { handler, traceContext } = factory.createForRun({
      id: 'run-123',
      source: 'manual',
      triggerName: null,
      parentFlowRunId: null,
      cwd: '/home/user/dev/my-repo',
      externalSessionId: null,
    });

    expect(handler.name).toBe('tracing-enrichment');
    expect(traceContext.traceName).toBe('manual-run');
  });

  it('should create handler with enabled=false when tracing is none', () => {
    const factory = new TracingEnrichmentHandlerFactory({
      tracingProvider: 'none',
    } as never);

    const { handler } = factory.createForRun({
      id: 'run-123',
      source: 'manual',
      triggerName: null,
      parentFlowRunId: null,
      cwd: '/home/user/dev/my-repo',
      externalSessionId: null,
    });

    // Should not throw — just noop
    handler.onMessage(systemInit());
    expect(mockSetAttribute).not.toHaveBeenCalled();
  });

  it('should wrap execution with OTel span in wrapWithContext', async () => {
    const factory = new TracingEnrichmentHandlerFactory({
      tracingProvider: 'phoenix',
    } as never);

    let called = false;
    await factory.wrapWithContext(
      {
        traceName: 'test-run',
        tags: ['source:test'],
        metadata: { runId: 'run-123', source: 'test', repoName: 'my-repo' },
      },
      async () => {
        called = true;
      },
    );

    expect(called).toBe(true);
    expect(trace.getTracer).toHaveBeenCalledWith('agentqueue');
  });

  it('should skip wrapping when tracing is disabled', async () => {
    const factory = new TracingEnrichmentHandlerFactory({
      tracingProvider: 'none',
    } as never);

    let called = false;
    await factory.wrapWithContext(
      {
        traceName: 'test-run',
        tags: [],
        metadata: {},
      },
      async () => {
        called = true;
      },
    );

    expect(called).toBe(true);
    // getTracer should not have been called again for this invocation
    // (clear was called in beforeEach, so count should be 0)
    expect(trace.getTracer).not.toHaveBeenCalled();
  });
});
