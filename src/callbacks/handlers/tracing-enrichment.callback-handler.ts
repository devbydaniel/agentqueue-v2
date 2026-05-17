import { Injectable, Logger } from '@nestjs/common';
import {
  trace,
  context,
  SpanStatusCode,
  type Span,
  type Context,
  type Tracer,
} from '@opentelemetry/api';
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { AppConfigService } from '../../config/app-config.service.js';
import type { RunEventHandler } from '../run-event-handler.interface.js';
import {
  buildTraceContext,
  type TraceContext,
  type TraceableRun,
} from '../build-trace-context.js';
import {
  OI_SPAN_KIND,
  OI_INPUT_VALUE,
  OI_OUTPUT_VALUE,
  OI_SESSION_ID,
  OI_LLM_MODEL,
  OI_TOOL_NAME,
  TRACER_NAME,
  type ToolUseBlock,
  truncate,
  stringifyToolValue,
  extractAssistantText,
  extractToolUses,
  extractToolResults,
} from './tracing-enrichment.helpers.js';

interface PendingTool {
  span: Span;
  name: string;
}

/**
 * Callback handler that turns the SDK's message stream into OpenInference
 * spans (AGENT → LLM / TOOL children) and enriches the parent run span with
 * `run.*` attributes.
 *
 * Why we emit spans manually instead of using
 * `@arizeai/openinference-instrumentation-claude-agent-sdk`: the auto-
 * instrumentation relies on IITM (`import-in-the-middle`) module patching,
 * and the dependency tree pulls in three different IITM versions whose
 * registries don't share state. The patch never gets applied, so only the
 * parent span lands in Phoenix. Since `RunProcessorService` already pipes
 * every `SDKMessage` through this handler, we can emit the same span shape
 * directly with zero IITM magic. See `phoenix_hook.py` for the shape we
 * mirror — both surfaces feed the same Phoenix project.
 */
export class TracingEnrichmentHandler implements RunEventHandler {
  readonly name = 'tracing-enrichment';
  private readonly logger = new Logger(TracingEnrichmentHandler.name);

  private agentSpan: Span | undefined;
  /** Context with `agentSpan` as the active span — used to parent LLM/TOOL children. */
  private agentContext: Context | undefined;
  private readonly pendingTools = new Map<string, PendingTool>();
  private hasAgentError = false;

  constructor(
    private readonly traceContext: TraceContext,
    private readonly enabled: boolean,
  ) {}

  onMessage(message: SDKMessage): void {
    if (!this.enabled) return;

    try {
      this.handleMessage(message);
    } catch (error) {
      this.logger.error('Failed to handle SDK message for tracing', {
        error: error as Error,
        messageType: message.type,
      });
    }
  }

  onComplete(result: SDKResultMessage | undefined): void {
    if (!this.enabled) return;

    this.enrichParentSpan(result);
    this.endPendingTools();
    this.endAgentSpan(result);
  }

  private handleMessage(message: SDKMessage): void {
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- result/stream_event/tool_progress/etc. handled elsewhere or skipped
    switch (message.type) {
      case 'system':
        this.handleSystemMessage(message);
        break;
      case 'assistant':
        this.handleAssistantMessage(message);
        break;
      case 'user':
        this.handleUserMessage(message);
        break;
      default:
        break;
    }
  }

  private handleSystemMessage(message: SDKMessage & { type: 'system' }): void {
    if (!('subtype' in message)) return;

    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- only tracing relevant subtypes
    switch (message.subtype) {
      case 'init':
        this.handleInit(message);
        break;
      case 'compact_boundary':
        this.handleCompactBoundary(message);
        break;
      case 'api_retry':
        this.handleApiRetry(message);
        break;
      default:
        break;
    }
  }

  private handleInit(message: SDKMessage & { type: 'system' }): void {
    this.enrichParentOnInit(message);
    this.startAgentSpan(message);
  }

  private enrichParentOnInit(message: SDKMessage & { type: 'system' }): void {
    const span = this.getActiveSpan();
    if (!span) return;

    span.setAttribute('run.id', this.traceContext.metadata['runId'] ?? '');
    span.setAttribute('run.source', this.traceContext.metadata['source'] ?? '');
    span.setAttribute(
      'run.repo_name',
      this.traceContext.metadata['repoName'] ?? '',
    );
    span.setAttribute('run.trace_name', this.traceContext.traceName);
    span.setAttribute('run.tags', this.traceContext.tags);

    if (this.traceContext.sessionId) {
      span.setAttribute('run.session_id', this.traceContext.sessionId);
    }
    if (this.traceContext.metadata['triggerName']) {
      span.setAttribute(
        'run.trigger_name',
        this.traceContext.metadata['triggerName'],
      );
    }
    if (this.traceContext.metadata['externalSessionId']) {
      span.setAttribute(
        'run.external_session_id',
        this.traceContext.metadata['externalSessionId'],
      );
    }
    if (this.traceContext.metadata['parentRunId']) {
      span.setAttribute(
        'run.parent_run_id',
        this.traceContext.metadata['parentRunId'],
      );
    }

    if ('model' in message && typeof message.model === 'string') {
      span.setAttribute('run.model', message.model);
    }
    if ('tools' in message && Array.isArray(message.tools)) {
      span.setAttribute('run.tool_count', message.tools.length);
    }
    if ('mcp_servers' in message && Array.isArray(message.mcp_servers)) {
      span.setAttribute('run.mcp_server_count', message.mcp_servers.length);
    }

    this.logger.debug('Tracing attributes enriched');
  }

  private startAgentSpan(message: SDKMessage & { type: 'system' }): void {
    if (this.agentSpan) return; // already started

    const sessionId =
      'session_id' in message && typeof message.session_id === 'string'
        ? message.session_id
        : undefined;
    const model =
      'model' in message && typeof message.model === 'string'
        ? message.model
        : undefined;

    const tracer = this.getTracer();
    if (!tracer) return;

    const parentCtx = context.active();
    const attributes: Record<string, string> = {
      [OI_SPAN_KIND]: 'AGENT',
    };
    // eslint-disable-next-line security/detect-object-injection -- key is a module-private constant
    if (sessionId) attributes[OI_SESSION_ID] = sessionId;
    // eslint-disable-next-line security/detect-object-injection -- key is a module-private constant
    if (model) attributes[OI_LLM_MODEL] = model;

    this.agentSpan = tracer.startSpan(
      'ClaudeAgent.query',
      { attributes },
      parentCtx,
    );
    this.agentContext = trace.setSpan(parentCtx, this.agentSpan);
  }

  private handleAssistantMessage(message: SDKAssistantMessage): void {
    if (!this.agentSpan || !this.agentContext) return;

    const tracer = this.getTracer();
    if (!tracer) return;

    const text = extractAssistantText(message);
    if (text.length > 0) {
      this.emitAssistantLlmSpan(tracer, message, text);
    }

    for (const tu of extractToolUses(message)) {
      this.startToolSpan(tracer, tu);
    }
  }

  private emitAssistantLlmSpan(
    tracer: Tracer,
    message: SDKAssistantMessage,
    text: string,
  ): void {
    const model = message.message.model;
    const attributes: Record<string, string> = {
      [OI_SPAN_KIND]: 'LLM',
      [OI_OUTPUT_VALUE]: truncate(text),
      'llm.output_messages.0.message.role': 'assistant',
      'llm.output_messages.0.message.content': truncate(text),
    };
    if (typeof model === 'string') {
      // eslint-disable-next-line security/detect-object-injection -- key is a module-private constant
      attributes[OI_LLM_MODEL] = model;
    }

    const span = tracer.startSpan('llm', { attributes }, this.agentContext);
    span.end();
  }

  private startToolSpan(tracer: Tracer, tu: ToolUseBlock): void {
    const span = tracer.startSpan(
      `tool: ${tu.name}`,
      {
        attributes: {
          [OI_SPAN_KIND]: 'TOOL',
          [OI_TOOL_NAME]: tu.name,
          [OI_INPUT_VALUE]: truncate(stringifyToolValue(tu.input)),
        },
      },
      this.agentContext,
    );
    this.pendingTools.set(tu.id, { span, name: tu.name });
  }

  private handleUserMessage(message: SDKUserMessage): void {
    if (this.pendingTools.size === 0) return;

    for (const result of extractToolResults(message)) {
      const pending = this.pendingTools.get(result.toolUseId);
      if (!pending) continue;

      pending.span.setAttribute(
        OI_OUTPUT_VALUE,
        truncate(stringifyToolValue(result.content)),
      );
      if (result.isError) {
        pending.span.setStatus({ code: SpanStatusCode.ERROR });
        this.hasAgentError = true;
      }
      pending.span.end();
      this.pendingTools.delete(result.toolUseId);
    }
  }

  private handleCompactBoundary(
    message: SDKMessage & { type: 'system' },
  ): void {
    const span = this.getActiveSpan();
    if (!span || !('compact_metadata' in message)) return;
    const meta = message.compact_metadata as {
      trigger: string;
      pre_tokens: number;
    };
    span.addEvent('compaction', {
      trigger: meta.trigger,
      pre_tokens: meta.pre_tokens,
    });
  }

  private handleApiRetry(message: SDKMessage & { type: 'system' }): void {
    const span = this.getActiveSpan();
    if (!span) return;
    const m = message as unknown as {
      attempt: number;
      max_retries: number;
      retry_delay_ms: number;
      error: string;
    };
    span.addEvent('api-retry', {
      attempt: m.attempt,
      max_retries: m.max_retries,
      retry_delay_ms: m.retry_delay_ms,
      error: m.error,
    });
  }

  private enrichParentSpan(result: SDKResultMessage | undefined): void {
    const span = this.getActiveSpan();
    if (!span) return;

    if (result) {
      span.setAttribute('run.subtype', result.subtype);
      span.setAttribute('run.num_turns', result.num_turns);
      span.setAttribute('run.cost_usd', result.total_cost_usd);
      span.setAttribute('run.duration_ms', result.duration_ms);
      span.setAttribute('run.is_error', result.is_error);
    } else {
      span.setAttribute('run.aborted', true);
    }
  }

  private endPendingTools(): void {
    for (const { span } of this.pendingTools.values()) {
      span.setAttribute(OI_OUTPUT_VALUE, '[run ended before tool completed]');
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    }
    this.pendingTools.clear();
  }

  private endAgentSpan(result: SDKResultMessage | undefined): void {
    if (!this.agentSpan) return;

    if (result) {
      this.agentSpan.setAttribute('run.num_turns', result.num_turns);
      this.agentSpan.setAttribute('run.cost_usd', result.total_cost_usd);
      this.agentSpan.setAttribute('run.duration_ms', result.duration_ms);
      this.agentSpan.setAttribute(
        OI_OUTPUT_VALUE,
        this.extractFinalOutput(result),
      );
      if (result.is_error) {
        this.hasAgentError = true;
      }
    }

    this.agentSpan.setStatus({
      code: this.hasAgentError ? SpanStatusCode.ERROR : SpanStatusCode.OK,
    });
    this.agentSpan.end();
    this.agentSpan = undefined;
    this.agentContext = undefined;
  }

  private extractFinalOutput(result: SDKResultMessage): string {
    if (result.subtype === 'success' && 'result' in result) {
      const r = (result as { result?: unknown }).result;
      if (typeof r === 'string') return truncate(r);
    }
    return '';
  }

  private getActiveSpan(): Span | undefined {
    return trace.getSpan(context.active());
  }

  private getTracer(): Tracer | undefined {
    try {
      return trace.getTracer(TRACER_NAME);
    } catch (error) {
      this.logger.debug('Failed to acquire tracer', { error: error as Error });
      return undefined;
    }
  }
}

@Injectable()
export class TracingEnrichmentHandlerFactory {
  private readonly logger = new Logger(TracingEnrichmentHandlerFactory.name);
  private readonly enabled: boolean;

  constructor(appConfig: AppConfigService) {
    this.enabled = appConfig.tracingProvider !== 'none';
    if (!this.enabled) {
      this.logger.warn('Tracing disabled — no TRACING_PROVIDER configured');
    }
  }

  createForRun(run: TraceableRun): {
    handler: TracingEnrichmentHandler;
    traceContext: TraceContext;
  } {
    const traceContext = buildTraceContext(run);
    return {
      handler: new TracingEnrichmentHandler(traceContext, this.enabled),
      traceContext,
    };
  }

  async wrapWithContext<T>(
    ctx: TraceContext,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.enabled) return fn();

    const tracer = trace.getTracer(TRACER_NAME);
    return tracer.startActiveSpan(ctx.traceName, async (span) => {
      try {
        span.setAttribute('run.tags', ctx.tags);
        for (const [key, value] of Object.entries(ctx.metadata)) {
          span.setAttribute(`run.${key}`, value);
        }
        if (ctx.sessionId) {
          span.setAttribute('run.session_id', ctx.sessionId);
        }
        return await fn();
      } finally {
        span.end();
      }
    });
  }
}
