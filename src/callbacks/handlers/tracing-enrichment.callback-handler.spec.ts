import { trace } from '@opentelemetry/api';
import {
  TracingEnrichmentHandler,
  TracingEnrichmentHandlerFactory,
} from './tracing-enrichment.callback-handler.js';
import {
  assistantText,
  autoRetryStart,
  compactionStart,
  sessionStart,
} from './__tests__/pi-event.fixtures.js';
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
    disabled.onStart(sessionStart());
    disabled.onEvent(compactionStart());
    expect(mockSetAttribute).not.toHaveBeenCalled();
    expect(mockAddEvent).not.toHaveBeenCalled();
  });

  it('should set run attributes on start', () => {
    handler.onStart(sessionStart());

    expect(mockSetAttribute).toHaveBeenCalledWith('run.id', 'run-123');
    expect(mockSetAttribute).toHaveBeenCalledWith('run.source', 'test');
    expect(mockSetAttribute).toHaveBeenCalledWith('run.repo_name', 'my-repo');
    expect(mockSetAttribute).toHaveBeenCalledWith('run.trace_name', 'test-run');
    expect(mockSetAttribute).toHaveBeenCalledWith('run.tags', ['source:test']);
    expect(mockSetAttribute).toHaveBeenCalledWith(
      'run.model',
      'anthropic/claude-opus-5-5',
    );
    expect(mockSetAttribute).toHaveBeenCalledWith('run.tool_count', 4);
    expect(mockSetAttribute).toHaveBeenCalledWith(
      'run.pi_session_id',
      'test-session-id',
    );
  });

  it('should not set run.model when no model resolved', () => {
    handler.onStart(sessionStart({ model: undefined }));

    expect(mockSetAttribute).not.toHaveBeenCalledWith(
      'run.model',
      expect.anything(),
    );
  });

  it('should not set optional attributes when absent from context', () => {
    handler.onStart(sessionStart());

    const keys = mockSetAttribute.mock.calls.map(([key]) => key as string);
    expect(keys).not.toContain('run.session_id');
    expect(keys).not.toContain('run.trigger_name');
    expect(keys).not.toContain('run.external_session_id');
    expect(keys).not.toContain('run.parent_run_id');
  });

  it('should set session_id when present in context', () => {
    const ctxWithSession: TraceContext = {
      ...defaultContext,
      sessionId: 'linear-session-1',
    };
    const h = new TracingEnrichmentHandler(ctxWithSession, true);
    h.onStart(sessionStart());

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
    h.onStart(sessionStart());

    expect(mockSetAttribute).toHaveBeenCalledWith(
      'run.trigger_name',
      'my-trigger',
    );
  });

  it('should set external_session_id and parent_run_id when present', () => {
    const ctx: TraceContext = {
      ...defaultContext,
      metadata: {
        ...defaultContext.metadata,
        externalSessionId: 'ext-1',
        parentRunId: 'run-parent',
      },
    };
    const h = new TracingEnrichmentHandler(ctx, true);
    h.onStart(sessionStart());

    expect(mockSetAttribute).toHaveBeenCalledWith(
      'run.external_session_id',
      'ext-1',
    );
    expect(mockSetAttribute).toHaveBeenCalledWith(
      'run.parent_run_id',
      'run-parent',
    );
  });

  it('should add compaction event on compaction_start', () => {
    handler.onEvent(compactionStart());

    expect(mockAddEvent).toHaveBeenCalledWith('compaction', {
      trigger: 'threshold',
    });
  });

  it('should add api-retry event on auto_retry_start', () => {
    handler.onEvent(autoRetryStart());

    expect(mockAddEvent).toHaveBeenCalledWith('api-retry', {
      attempt: 1,
      max_retries: 3,
      retry_delay_ms: 1000,
      error: 'overloaded',
    });
  });

  it('should ignore other events', () => {
    handler.onEvent(assistantText('Hello'));

    expect(mockAddEvent).not.toHaveBeenCalled();
    expect(mockSetAttribute).not.toHaveBeenCalled();
  });

  it('should swallow span errors in onEvent', () => {
    mockAddEvent.mockImplementationOnce(() => {
      throw new Error('span closed');
    });

    expect(() => handler.onEvent(compactionStart())).not.toThrow();
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
      parentRunId: null,
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
      parentRunId: null,
      cwd: '/home/user/dev/my-repo',
      externalSessionId: null,
    });

    // Should not throw — just noop
    handler.onStart(sessionStart());
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
    expect(trace.getTracer).not.toHaveBeenCalled();
  });
});
