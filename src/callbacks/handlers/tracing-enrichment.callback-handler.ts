import { Injectable, Logger } from '@nestjs/common';
import { trace, context, type Span } from '@opentelemetry/api';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent' with {
  'resolution-mode': 'import',
};
import { AppConfigService } from '../../config/app-config.service.js';
import type {
  RunEventHandler,
  SessionStartInfo,
} from '../run-event-handler.interface.js';
import {
  buildTraceContext,
  type TraceContext,
  type TraceableRun,
} from '../build-trace-context.js';

const TRACER_NAME = 'agentqueue';

/**
 * Enriches the parent run span with `run.*` attributes (model, tags, source,
 * session linkage, etc.) and records compaction / api-retry events.
 *
 * The fine-grained AGENT / LLM / TOOL spans (including cost) for each pi
 * session are NOT emitted here. They come from the agentfiles-deployed
 * phoenix pi extension (`~/.pi/agent/extensions/phoenix`), which exports
 * every settled run — same extension, same span shape on laptop and in the
 * pod.
 */
export class TracingEnrichmentHandler implements RunEventHandler {
  readonly name = 'tracing-enrichment';
  private readonly logger = new Logger(TracingEnrichmentHandler.name);

  constructor(
    private readonly traceContext: TraceContext,
    private readonly enabled: boolean,
  ) {}

  onStart(info: SessionStartInfo): void {
    if (!this.enabled) return;

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

    span.setAttribute('run.pi_session_id', info.sessionId);
    if (info.model) span.setAttribute('run.model', info.model);
    span.setAttribute('run.tool_count', info.tools.length);

    this.logger.debug('Tracing attributes enriched');
  }

  onEvent(event: AgentSessionEvent): void {
    if (!this.enabled) return;

    try {
      this.handleEvent(event);
    } catch (error) {
      this.logger.error('Failed to enrich tracing span', {
        error: error as Error,
        eventType: event.type,
      });
    }
  }

  private handleEvent(event: AgentSessionEvent): void {
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- only tracing relevant types
    switch (event.type) {
      case 'compaction_start':
        this.getActiveSpan()?.addEvent('compaction', {
          trigger: event.reason,
        });
        break;

      case 'auto_retry_start':
        this.getActiveSpan()?.addEvent('api-retry', {
          attempt: event.attempt,
          max_retries: event.maxAttempts,
          retry_delay_ms: event.delayMs,
          error: event.errorMessage,
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
