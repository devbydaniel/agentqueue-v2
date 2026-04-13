import { Injectable, Logger } from '@nestjs/common';
import { trace, context, type Span } from '@opentelemetry/api';
import type {
  SDKMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { AppConfigService } from '../../config/app-config.service.js';
import type { RunEventHandler } from '../run-event-handler.interface.js';
import {
  buildTraceContext,
  type TraceContext,
  type TraceableRun,
} from '../build-trace-context.js';

/**
 * Lightweight callback handler that enriches auto-instrumented OTel spans
 * with custom run attributes (source, tags, session, cost metrics, etc.).
 *
 * Works with any OTLP-compatible backend (Langfuse, Phoenix, etc.).
 * The heavy lifting (AGENT + TOOL spans) is handled by
 * `@arizeai/openinference-instrumentation-claude-agent-sdk`.
 */
export class TracingEnrichmentHandler implements RunEventHandler {
  readonly name = 'tracing-enrichment';
  private readonly logger = new Logger(TracingEnrichmentHandler.name);

  constructor(
    private readonly traceContext: TraceContext,
    private readonly enabled: boolean,
  ) {}

  onMessage(message: SDKMessage): void {
    if (!this.enabled) return;

    try {
      this.handleMessage(message);
    } catch (error) {
      this.logger.error('Failed to enrich tracing span', {
        error: error as Error,
        messageType: message.type,
      });
    }
  }

  onComplete(result: SDKResultMessage | undefined): void {
    if (!this.enabled) return;

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

  private handleMessage(message: SDKMessage): void {
    if (message.type === 'system') {
      this.handleSystemMessage(message);
    }
  }

  private handleSystemMessage(message: SDKMessage & { type: 'system' }): void {
    if (!('subtype' in message)) return;

    const span = this.getActiveSpan();
    if (!span) return;

    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- only tracing relevant subtypes
    switch (message.subtype) {
      case 'init':
        span.setAttribute('run.id', this.traceContext.metadata['runId'] ?? '');
        span.setAttribute(
          'run.source',
          this.traceContext.metadata['source'] ?? '',
        );
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
        if (this.traceContext.metadata['parentFlowRunId']) {
          span.setAttribute(
            'run.parent_flow_run_id',
            this.traceContext.metadata['parentFlowRunId'],
          );
        }

        span.setAttribute('run.model', message.model);
        span.setAttribute('run.tool_count', message.tools.length);
        span.setAttribute('run.mcp_server_count', message.mcp_servers.length);

        this.logger.debug('Tracing attributes enriched');
        break;

      case 'compact_boundary':
        span.addEvent('compaction', {
          trigger: message.compact_metadata.trigger,
          pre_tokens: message.compact_metadata.pre_tokens,
        });
        break;

      case 'api_retry':
        span.addEvent('api-retry', {
          attempt: message.attempt,
          max_retries: message.max_retries,
          retry_delay_ms: message.retry_delay_ms,
          error: message.error,
        });
        break;

      default:
        break;
    }
  }

  private getActiveSpan(): Span | undefined {
    return trace.getSpan(context.active());
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

    const tracer = trace.getTracer('agentqueue');
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
