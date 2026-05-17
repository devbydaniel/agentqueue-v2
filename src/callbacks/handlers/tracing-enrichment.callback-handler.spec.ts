import { trace, SpanStatusCode } from '@opentelemetry/api';
import {
  TracingEnrichmentHandler,
  TracingEnrichmentHandlerFactory,
} from './tracing-enrichment.callback-handler.js';
import {
  systemInit,
  systemApiRetry,
  systemCompactBoundary,
  resultSuccess,
  resultError,
  assistantText,
  assistantToolUse,
  assistantMixed,
  userToolResult,
} from './__tests__/sdk-message.fixtures.js';
import type { TraceContext } from '../build-trace-context.js';

const parentSetAttribute = jest.fn();
const parentAddEvent = jest.fn();
const parentSetStatus = jest.fn();
const parentEnd = jest.fn();
const parentSpan = {
  setAttribute: parentSetAttribute,
  addEvent: parentAddEvent,
  setStatus: parentSetStatus,
  end: parentEnd,
};

interface ChildSpanRecord {
  name: string;
  attributes: Record<string, unknown>;
  ended: boolean;
  status?: { code: number };
  endAttributes: Record<string, unknown>;
}

let childSpans: ChildSpanRecord[] = [];

function makeChildSpan(name: string, attributes: Record<string, unknown>) {
  const record: ChildSpanRecord = {
    name,
    attributes: { ...attributes },
    ended: false,
    endAttributes: {},
  };
  const span = {
    setAttribute: (key: string, value: unknown) => {
      record.endAttributes[key] = value;
    },
    setStatus: (status: { code: number }) => {
      record.status = status;
    },
    end: () => {
      record.ended = true;
    },
    addEvent: jest.fn(),
  };
  childSpans.push(record);
  return span;
}

const mockTracer = {
  startActiveSpan: jest.fn((_name: string, fn: (span: unknown) => unknown) =>
    fn(parentSpan),
  ),
  startSpan: jest.fn(
    (name: string, opts?: { attributes?: Record<string, unknown> }) =>
      makeChildSpan(name, opts?.attributes ?? {}),
  ),
};

jest.mock('@opentelemetry/api', () => {
  const actual = jest.requireActual('@opentelemetry/api');
  return {
    ...actual,
    trace: {
      getSpan: jest.fn(() => parentSpan),
      getTracer: jest.fn(() => mockTracer),
      setSpan: jest.fn((ctx: unknown) => ctx),
    },
    context: {
      active: jest.fn(() => ({})),
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
    childSpans = [];
    handler = new TracingEnrichmentHandler(defaultContext, true);
  });

  it('does not enrich when disabled', () => {
    const disabled = new TracingEnrichmentHandler(defaultContext, false);
    disabled.onMessage(systemInit());
    expect(parentSetAttribute).not.toHaveBeenCalled();
    expect(mockTracer.startSpan).not.toHaveBeenCalled();
  });

  describe('parent-span enrichment', () => {
    it('sets run attributes on system init', () => {
      handler.onMessage(systemInit({ model: 'claude-opus-4-20250514' }));

      expect(parentSetAttribute).toHaveBeenCalledWith('run.id', 'run-123');
      expect(parentSetAttribute).toHaveBeenCalledWith('run.source', 'test');
      expect(parentSetAttribute).toHaveBeenCalledWith(
        'run.repo_name',
        'my-repo',
      );
      expect(parentSetAttribute).toHaveBeenCalledWith(
        'run.trace_name',
        'test-run',
      );
      expect(parentSetAttribute).toHaveBeenCalledWith('run.tags', [
        'source:test',
      ]);
      expect(parentSetAttribute).toHaveBeenCalledWith(
        'run.model',
        'claude-opus-4-20250514',
      );
      expect(parentSetAttribute).toHaveBeenCalledWith('run.tool_count', 3);
      expect(parentSetAttribute).toHaveBeenCalledWith(
        'run.mcp_server_count',
        0,
      );
    });

    it('sets session_id when present in context', () => {
      const ctxWithSession: TraceContext = {
        ...defaultContext,
        sessionId: 'linear-session-1',
      };
      const h = new TracingEnrichmentHandler(ctxWithSession, true);
      h.onMessage(systemInit());

      expect(parentSetAttribute).toHaveBeenCalledWith(
        'run.session_id',
        'linear-session-1',
      );
    });

    it('sets trigger_name when present in metadata', () => {
      const ctxWithTrigger: TraceContext = {
        ...defaultContext,
        metadata: { ...defaultContext.metadata, triggerName: 'my-trigger' },
      };
      const h = new TracingEnrichmentHandler(ctxWithTrigger, true);
      h.onMessage(systemInit());

      expect(parentSetAttribute).toHaveBeenCalledWith(
        'run.trigger_name',
        'my-trigger',
      );
    });

    it('adds compaction event', () => {
      handler.onMessage(systemInit());
      handler.onMessage(systemCompactBoundary());

      expect(parentAddEvent).toHaveBeenCalledWith('compaction', {
        trigger: 'auto',
        pre_tokens: 50000,
      });
    });

    it('adds api-retry event', () => {
      handler.onMessage(systemInit());
      handler.onMessage(systemApiRetry());

      expect(parentAddEvent).toHaveBeenCalledWith(
        'api-retry',
        expect.objectContaining({
          attempt: 1,
          max_retries: 3,
        }),
      );
    });
  });

  describe('AGENT / LLM / TOOL child spans', () => {
    it('starts a ClaudeAgent.query AGENT span on system init', () => {
      handler.onMessage(systemInit({ model: 'claude-opus-4-20250514' }));

      const agent = childSpans.find((s) => s.name === 'ClaudeAgent.query');
      expect(agent).toBeDefined();
      expect(agent?.attributes['openinference.span.kind']).toBe('AGENT');
      expect(agent?.attributes['session.id']).toBe('test-session-id');
      expect(agent?.attributes['llm.model_name']).toBe(
        'claude-opus-4-20250514',
      );
      expect(agent?.ended).toBe(false);
    });

    it('emits an LLM span for an assistant text message', () => {
      handler.onMessage(systemInit());
      handler.onMessage(assistantText('hello world'));

      const llm = childSpans.find((s) => s.name === 'llm');
      expect(llm).toBeDefined();
      expect(llm?.attributes['openinference.span.kind']).toBe('LLM');
      expect(llm?.attributes['output.value']).toBe('hello world');
      expect(llm?.attributes['llm.output_messages.0.message.content']).toBe(
        'hello world',
      );
      expect(llm?.ended).toBe(true);
    });

    it('opens a TOOL span on tool_use and closes it on matching tool_result', () => {
      handler.onMessage(systemInit());
      handler.onMessage(assistantToolUse('Bash', { command: 'ls' }, 'tu-1'));
      handler.onMessage(userToolResult('tu-1', 'file1\nfile2'));

      const tool = childSpans.find((s) => s.name === 'tool: Bash');
      expect(tool).toBeDefined();
      expect(tool?.attributes['openinference.span.kind']).toBe('TOOL');
      expect(tool?.attributes['tool.name']).toBe('Bash');
      expect(tool?.attributes['input.value']).toBe('{"command":"ls"}');
      expect(tool?.endAttributes['output.value']).toBe('file1\nfile2');
      expect(tool?.ended).toBe(true);
      expect(tool?.status).toBeUndefined();
    });

    it('marks TOOL span as ERROR when tool_result has is_error=true', () => {
      handler.onMessage(systemInit());
      handler.onMessage(assistantToolUse('Bash', { command: 'bad' }, 'tu-2'));
      handler.onMessage(userToolResult('tu-2', 'permission denied', true));

      const tool = childSpans.find((s) => s.name === 'tool: Bash');
      expect(tool?.status?.code).toBe(SpanStatusCode.ERROR);
      expect(tool?.ended).toBe(true);
    });

    it('emits both LLM and TOOL spans for a mixed assistant message', () => {
      handler.onMessage(systemInit());
      handler.onMessage(
        assistantMixed('Running command', 'Bash', { command: 'ls' }, 'tu-3'),
      );
      handler.onMessage(userToolResult('tu-3', 'ok'));

      expect(childSpans.some((s) => s.name === 'llm')).toBe(true);
      expect(childSpans.some((s) => s.name === 'tool: Bash')).toBe(true);
    });

    it('ignores assistant messages and tool results until init', () => {
      // No init yet — these should be no-ops.
      handler.onMessage(assistantText('orphan'));
      handler.onMessage(userToolResult('tu-x', 'orphan'));

      expect(mockTracer.startSpan).not.toHaveBeenCalled();
    });
  });

  describe('onComplete', () => {
    it('ends the AGENT span and sets parent run.* result attributes on success', () => {
      handler.onMessage(systemInit());
      handler.onComplete(resultSuccess());

      expect(parentSetAttribute).toHaveBeenCalledWith('run.subtype', 'success');
      expect(parentSetAttribute).toHaveBeenCalledWith('run.cost_usd', 0.05);
      expect(parentSetAttribute).toHaveBeenCalledWith('run.is_error', false);

      const agent = childSpans.find((s) => s.name === 'ClaudeAgent.query');
      expect(agent?.ended).toBe(true);
      expect(agent?.status?.code).toBe(SpanStatusCode.OK);
    });

    it('sets ERROR status on AGENT span when result is an error', () => {
      handler.onMessage(systemInit());
      handler.onComplete(resultError());

      const agent = childSpans.find((s) => s.name === 'ClaudeAgent.query');
      expect(agent?.status?.code).toBe(SpanStatusCode.ERROR);
    });

    it('marks parent span aborted when result is undefined', () => {
      handler.onMessage(systemInit());
      handler.onComplete(undefined);

      expect(parentSetAttribute).toHaveBeenCalledWith('run.aborted', true);

      const agent = childSpans.find((s) => s.name === 'ClaudeAgent.query');
      expect(agent?.ended).toBe(true);
    });

    it('closes pending tool spans on abort', () => {
      handler.onMessage(systemInit());
      handler.onMessage(assistantToolUse('Bash', { command: 'long' }, 'tu-9'));
      // No matching tool_result arrives — run aborts.
      handler.onComplete(undefined);

      const tool = childSpans.find((s) => s.name === 'tool: Bash');
      expect(tool?.ended).toBe(true);
      expect(tool?.status?.code).toBe(SpanStatusCode.ERROR);
    });

    it('does not enrich or end spans when disabled', () => {
      const disabled = new TracingEnrichmentHandler(defaultContext, false);
      disabled.onComplete(resultSuccess());

      expect(parentSetAttribute).not.toHaveBeenCalled();
      expect(mockTracer.startSpan).not.toHaveBeenCalled();
    });
  });
});

describe('TracingEnrichmentHandlerFactory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    childSpans = [];
  });

  it('creates handler with enabled=true when tracing is configured', () => {
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

  it('creates handler with enabled=false when tracing is none', () => {
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

    handler.onMessage(systemInit());
    expect(parentSetAttribute).not.toHaveBeenCalled();
  });

  it('wraps execution with OTel span in wrapWithContext', async () => {
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

  it('skips wrapping when tracing is disabled', async () => {
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
