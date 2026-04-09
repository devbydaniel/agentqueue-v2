import { Injectable, Logger } from '@nestjs/common';
import { basename } from 'node:path';
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import { AppConfigService } from '../../config/app-config.service.js';
import {
  startObservation,
  type LangfuseSpan,
  type LangfuseTool,
} from '@langfuse/tracing';
import { CallbackHandler } from '../callback-handler.interface.js';

const MAX_INPUT_LENGTH = 10_000;

function truncate(text: string, max = MAX_INPUT_LENGTH): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

function extractToolResult(result: unknown): string {
  const typed = result as
    | { content: Array<{ type: string; text?: string }> }
    | undefined;
  return (
    typed?.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n') ?? ''
  );
}

function extractContentText(
  content: string | Array<{ type: string; text?: string }> | undefined,
): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return extractAssistantText(content);
  return '';
}

function extractAssistantText(
  content: Array<{ type: string; text?: string }>,
): string {
  return content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

export interface LangfuseTraceContext {
  traceName: string;
  tags: string[];
  metadata: Record<string, string>;
  sessionId?: string;
}

export interface LangfuseTraceableRun {
  id: string;
  source: string;
  triggerName: string | null;
  parentFlowRunId: string | null;
  cwd: string;
  externalSessionId: string | null;
}

function buildSessionId(run: LangfuseTraceableRun): string | undefined {
  if (
    (run.source === 'linear' || run.source === 'telegram') &&
    run.externalSessionId
  ) {
    return run.externalSessionId;
  }

  if (run.source === 'flow' && run.parentFlowRunId) {
    return run.parentFlowRunId;
  }

  return undefined;
}

/**
 * Per-run callback handler that sends agent run traces to Langfuse.
 *
 * Hierarchy:
 *   Trace (agent run)
 *     └─ Span per turn
 *         ├─ Generation (assistant message)
 *         └─ Tool spans (tool executions)
 *
 * Active only when LANGFUSE_SECRET_KEY is set.
 */
export class LangfuseCallbackHandler implements CallbackHandler {
  readonly name = 'langfuse';
  private readonly logger = new Logger(LangfuseCallbackHandler.name);

  /** Root span for the current agent run. */
  private rootSpan: LangfuseSpan | undefined;
  /** Current turn span (child of root). */
  private turnSpan: LangfuseSpan | undefined;
  /** In-flight tool spans keyed by toolCallId. */
  private readonly toolSpans = new Map<string, LangfuseTool>();

  constructor(
    private readonly traceContext: LangfuseTraceContext,
    private readonly enabled: boolean,
  ) {}

  onEvent(event: AgentSessionEvent): void {
    if (!this.enabled) return;

    try {
      this.handleEvent(event);
    } catch (error) {
      this.logger.error('Failed to process event for Langfuse', {
        error: error as Error,
        eventType: event.type,
      });
    }
  }

  private handleEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case 'agent_start':
        this.onAgentStart();
        break;

      case 'agent_end':
        this.onAgentEnd(event);
        break;

      case 'turn_start':
        this.onTurnStart();
        break;

      case 'turn_end':
        this.onTurnEnd();
        break;

      case 'message_end':
        this.onMessageEnd(event);
        break;

      case 'tool_execution_start':
        this.onToolStart(event);
        break;

      case 'tool_execution_end':
        this.onToolEnd(event);
        break;

      case 'compaction_start':
        this.addEvent('compaction-start', { reason: event.reason });
        break;

      case 'compaction_end':
        this.addEvent('compaction-end', {
          reason: event.reason,
          aborted: event.aborted,
        });
        break;

      case 'auto_retry_start':
        this.addEvent('auto-retry-start', {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          error: event.errorMessage,
        });
        break;

      case 'auto_retry_end':
        this.addEvent('auto-retry-end', {
          success: event.success,
          attempt: event.attempt,
        });
        break;

      // Intentionally not traced — too noisy / no useful data.
      case 'message_start':
      case 'message_update':
      case 'tool_execution_update':
      case 'queue_update':
        break;
    }
  }

  // ── Agent lifecycle ──────────────────────────────────────────────

  private onAgentStart(): void {
    this.rootSpan = startObservation(this.traceContext.traceName, {
      input: { event: 'agent_start' },
      metadata: this.traceContext.metadata,
    });
    this.logger.debug('Langfuse trace started');
  }

  private onAgentEnd(event: { messages: unknown[] }): void {
    if (!this.rootSpan) return;

    this.rootSpan
      .update({
        output: { messageCount: event.messages.length },
      })
      .end();
    this.rootSpan = undefined;
    this.logger.debug('Langfuse trace ended');
  }

  // ── Turn lifecycle ───────────────────────────────────────────────

  private onTurnStart(): void {
    const parent = this.rootSpan;
    if (!parent) return;

    this.turnSpan = parent.startObservation('turn');
  }

  private onTurnEnd(): void {
    if (!this.turnSpan) return;

    this.turnSpan.end();
    this.turnSpan = undefined;
  }

  // ── Messages ─────────────────────────────────────────────────────

  private onMessageEnd(event: { message: unknown }): void {
    const parent = this.turnSpan ?? this.rootSpan;
    if (!parent) return;

    const msg = event.message as {
      role?: string;
      content?:
        | string
        | Array<{
            type: string;
            text?: string;
            name?: string;
            arguments?: unknown;
          }>;
    };

    if (!msg.role) return;

    switch (msg.role) {
      case 'system':
      case 'user': {
        const text = extractContentText(msg.content);
        if (!text) return;
        const label = msg.role === 'system' ? 'system-message' : 'user-message';
        const span = parent.startObservation(label, {
          input: truncate(text),
        });
        span.end();
        break;
      }

      case 'assistant': {
        if (!Array.isArray(msg.content)) return;
        const text = extractAssistantText(msg.content);
        const toolCalls = msg.content.filter((c) => c.type === 'toolCall');

        const generation = parent.startObservation(
          'assistant-message',
          {
            output: truncate(text),
            metadata: toolCalls.length
              ? {
                  toolCalls: toolCalls.map((tc) => ({
                    name: tc.name,
                    args: truncate(JSON.stringify(tc.arguments)),
                  })),
                }
              : undefined,
          },
          { asType: 'generation' },
        );
        generation.end();
        break;
      }
    }
  }

  // ── Tool executions ──────────────────────────────────────────────

  private onToolStart(event: {
    toolCallId: string;
    toolName: string;
    args: unknown;
  }): void {
    const parent = this.turnSpan ?? this.rootSpan;
    if (!parent) return;

    const span = parent.startObservation(
      event.toolName,
      { input: truncate(JSON.stringify(event.args)) },
      { asType: 'tool' },
    );
    this.toolSpans.set(event.toolCallId, span);
  }

  private onToolEnd(event: {
    toolCallId: string;
    toolName: string;
    result: unknown;
    isError: boolean;
  }): void {
    const span = this.toolSpans.get(event.toolCallId);
    if (!span) return;

    const resultText = extractToolResult(event.result);
    span
      .update({
        output: truncate(resultText),
        metadata: { isError: event.isError },
      })
      .end();
    this.toolSpans.delete(event.toolCallId);
  }

  // ── Helpers ──────────────────────────────────────────────────────

  /** Record a point-in-time event on the current turn or root span. */
  private addEvent(name: string, attributes: Record<string, unknown>): void {
    const parent = this.turnSpan ?? this.rootSpan;
    if (!parent) return;

    const event = parent.startObservation(
      name,
      { metadata: attributes },
      { asType: 'event' },
    );
    event.end();
  }
}

@Injectable()
export class LangfuseCallbackHandlerFactory {
  private readonly logger = new Logger(LangfuseCallbackHandlerFactory.name);
  private readonly enabled: boolean;

  constructor(appConfig: AppConfigService) {
    this.enabled = appConfig.langfuseEnabled;
    if (!this.enabled) {
      this.logger.warn(
        'LANGFUSE_SECRET_KEY not set — Langfuse tracing disabled',
      );
    }
  }

  createForRun(run: LangfuseTraceableRun): {
    handler: LangfuseCallbackHandler;
    traceContext: LangfuseTraceContext;
  } {
    const traceContext = this.buildTraceContext(run);
    return {
      handler: new LangfuseCallbackHandler(traceContext, this.enabled),
      traceContext,
    };
  }

  buildTraceContext(run: LangfuseTraceableRun): LangfuseTraceContext {
    const sessionId = buildSessionId(run);
    const tags = [`source:${run.source}`];

    if (run.triggerName) {
      tags.push(`trigger:${run.triggerName}`);
    }

    if (run.parentFlowRunId) {
      tags.push('flow:child');
    }

    tags.push(sessionId ? 'session:shared' : 'session:ephemeral');

    const metadata: Record<string, string> = {
      runId: run.id,
      source: run.source,
      repoName: basename(run.cwd),
    };

    if (run.triggerName) {
      metadata['triggerName'] = run.triggerName;
    }

    if (run.externalSessionId) {
      metadata['externalSessionId'] = run.externalSessionId;
    }

    if (run.parentFlowRunId) {
      metadata['parentFlowRunId'] = run.parentFlowRunId;
    }

    return {
      traceName: `${run.source}-run`,
      tags,
      metadata,
      sessionId,
    };
  }
}
