import { Injectable, Logger } from '@nestjs/common';
import { basename } from 'node:path';
import type {
  SDKMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { AppConfigService } from '../../config/app-config.service.js';
import {
  startObservation,
  type LangfuseSpan,
  type LangfuseTool,
} from '@langfuse/tracing';
import type { RunEventHandler } from '../run-event-handler.interface.js';

const MAX_INPUT_LENGTH = 10_000;

function truncate(text: string, max = MAX_INPUT_LENGTH): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
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
 *   Root span (started on system init)
 *     ├─ Generation span (per assistant message)
 *     ├─ Tool span (per tool_use block, closed on matching tool_result)
 *     ├─ Event markers (compact_boundary, api_retry)
 *     └─ Closed on result message
 *
 * Active only when LANGFUSE_SECRET_KEY is set.
 */
export class LangfuseCallbackHandler implements RunEventHandler {
  readonly name = 'langfuse';
  private readonly logger = new Logger(LangfuseCallbackHandler.name);

  /** Root span for the current agent run. */
  private rootSpan: LangfuseSpan | undefined;
  /** In-flight tool spans keyed by tool_use block id. */
  private readonly toolSpans = new Map<string, LangfuseTool>();

  constructor(
    private readonly traceContext: LangfuseTraceContext,
    private readonly enabled: boolean,
  ) {}

  onMessage(message: SDKMessage): void {
    if (!this.enabled) return;

    try {
      this.handleMessage(message);
    } catch (error) {
      this.logger.error('Failed to process message for Langfuse', {
        error: error as Error,
        messageType: message.type,
      });
    }
  }

  onComplete(result: SDKResultMessage | undefined): void {
    if (!this.enabled) return;

    // Close any orphaned tool spans (e.g. session aborted mid-tool)
    for (const [id, span] of this.toolSpans) {
      span.update({ metadata: { aborted: true } }).end();
      this.toolSpans.delete(id);
    }

    // Close root span if still open (e.g. error path where
    // the result message wasn't processed via onMessage)
    if (this.rootSpan) {
      const output: Record<string, unknown> = result
        ? {
            subtype: result.subtype,
            numTurns: result.num_turns,
            costUsd: result.total_cost_usd,
            durationMs: result.duration_ms,
          }
        : { aborted: true };

      this.rootSpan.update({ output }).end();
      this.rootSpan = undefined;
    }
  }

  private handleMessage(message: SDKMessage): void {
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- intentionally handling only relevant types
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

      case 'result':
        this.handleResult(message);
        break;

      default:
        break;
    }
  }

  // ── System messages ─────────────────────────────────────────────

  private handleSystemMessage(message: SDKMessage & { type: 'system' }): void {
    if (!('subtype' in message)) return;

    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- only tracing relevant subtypes
    switch (message.subtype) {
      case 'init':
        this.rootSpan = startObservation(this.traceContext.traceName, {
          input: { event: 'init' },
          metadata: {
            ...this.traceContext.metadata,
            model: message.model,
            toolCount: message.tools.length,
            mcpServerCount: message.mcp_servers.length,
          },
        });
        this.logger.debug('Langfuse trace started');
        break;

      case 'compact_boundary':
        this.addEvent('compaction', {
          trigger: message.compact_metadata.trigger,
          preTokens: message.compact_metadata.pre_tokens,
        });
        break;

      case 'api_retry':
        this.addEvent('api-retry', {
          attempt: message.attempt,
          maxRetries: message.max_retries,
          retryDelayMs: message.retry_delay_ms,
          error: message.error,
        });
        break;

      default:
        break;
    }
  }

  // ── Assistant messages ──────────────────────────────────────────

  private handleAssistantMessage(
    message: SDKMessage & { type: 'assistant' },
  ): void {
    const parent = this.rootSpan;
    if (!parent) return;

    const content = message.message.content;

    // Create a generation span for text output
    const textParts = content
      .filter((c) => c.type === 'text')
      .map((c) => ('text' in c ? c.text : ''));
    const text = textParts.join('\n');

    const toolCalls = content.filter((c) => c.type === 'tool_use');

    if (text || toolCalls.length > 0) {
      const generation = parent.startObservation(
        'assistant-message',
        {
          output: text ? truncate(text) : undefined,
          metadata: toolCalls.length
            ? {
                toolCalls: toolCalls.map((tc) => ({
                  name: tc.name,
                  args:
                    'input' in tc
                      ? truncate(JSON.stringify(tc.input))
                      : undefined,
                })),
              }
            : undefined,
        },
        { asType: 'generation' },
      );
      generation.end();
    }

    // Open a tool span for each tool_use block
    for (const block of content) {
      if (block.type === 'tool_use') {
        const span = parent.startObservation(
          block.name,
          { input: truncate(JSON.stringify(block.input)) },
          { asType: 'tool' },
        );
        this.toolSpans.set(block.id, span);
      }
    }
  }

  // ── User messages (synthetic tool results) ──────────────────────

  private handleUserMessage(message: SDKMessage & { type: 'user' }): void {
    const msgContent = message.message.content;
    if (!Array.isArray(msgContent)) return;

    for (const block of msgContent) {
      if (
        typeof block === 'object' &&
        'type' in block &&
        block.type === 'tool_result' &&
        'tool_use_id' in block
      ) {
        const toolUseId = block.tool_use_id;
        const span = this.toolSpans.get(toolUseId);
        if (!span) continue;

        const resultText = this.extractToolResultText(
          block as unknown as Record<string, unknown>,
        );
        const isError =
          'is_error' in block ? (block.is_error as boolean) : false;

        span
          .update({
            output: truncate(resultText),
            metadata: { isError },
          })
          .end();
        this.toolSpans.delete(toolUseId);
      }
    }
  }

  // ── Result ──────────────────────────────────────────────────────

  private handleResult(message: SDKResultMessage): void {
    if (!this.rootSpan) return;

    const output: Record<string, unknown> = {
      subtype: message.subtype,
      numTurns: message.num_turns,
      costUsd: message.total_cost_usd,
      durationMs: message.duration_ms,
    };

    if (message.subtype === 'success') {
      output['result'] = truncate(message.result);
    } else {
      output['errors'] = message.errors;
    }

    this.rootSpan.update({ output }).end();
    this.rootSpan = undefined;
    this.logger.debug('Langfuse trace ended');
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private addEvent(name: string, attributes: Record<string, unknown>): void {
    if (!this.rootSpan) return;

    const event = this.rootSpan.startObservation(
      name,
      { metadata: attributes },
      { asType: 'event' },
    );
    event.end();
  }

  private extractToolResultText(block: Record<string, unknown>): string {
    const content = block['content'];
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';

    return (content as Array<Record<string, unknown>>)
      .filter((c) => c['type'] === 'text' && typeof c['text'] === 'string')
      .map((c) => c['text'] as string)
      .join('\n');
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
