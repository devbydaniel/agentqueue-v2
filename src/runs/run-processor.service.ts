import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  SDKMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { RUN_EVENT_HANDLERS } from '../callbacks/constants.js';
import type { RunEventHandler } from '../callbacks/run-event-handler.interface.js';
import type { TraceContext } from '../callbacks/build-trace-context.js';
import { ActiveSessionTrackerService } from './active-session-tracker.service.js';
import { SdkSessionFactory } from './sdk-session.factory.js';
import { RunLifecycleService } from './run-lifecycle.service.js';
import { RunHandlerBuilder } from './run-handler-builder.service.js';
import { RunSourceNotifier } from './run-source-notifier.service.js';

export interface RunSessionParams {
  cwd: string;
  prompt: string;
  additionalHandlers?: RunEventHandler[];
  /** Session ID to resume a previous SDK session */
  resumeSessionId?: string;
  /** Optional external ID to track the session for later cancellation (e.g. Linear agentSessionId) */
  externalSessionId?: string;
  /** Run ID for dual-indexed tracker (enables abort-by-runId from dashboard) */
  runId?: string;
  /** System prompt snippet to append after the base system prompt */
  appendSystemPrompt?: string;
  /** AbortController for per-run timeout + cancellation */
  abortController?: AbortController;
  /** Trace-level attributes applied for the duration of the run */
  traceContext?: TraceContext;
}

export interface RunSessionResult {
  success: boolean;
  sessionId?: string;
}

@Injectable()
export class RunProcessorService {
  private readonly logger = new Logger(RunProcessorService.name);

  constructor(
    private readonly sdkSessionFactory: SdkSessionFactory,
    private readonly activeSessionTracker: ActiveSessionTrackerService,
    private readonly lifecycle: RunLifecycleService,
    private readonly handlerBuilder: RunHandlerBuilder,
    private readonly sourceNotifier: RunSourceNotifier,
    @Inject(RUN_EVENT_HANDLERS)
    private readonly globalHandlers: RunEventHandler[],
  ) {}

  /**
   * Abort a tracked session by its external session ID (e.g. Linear agentSessionId).
   * Returns true if the session was found and aborted.
   */
  abortSession(externalSessionId: string): boolean {
    return this.activeSessionTracker.abort(externalSessionId);
  }

  /**
   * Abort a tracked session by its run ID.
   * Returns true if a session was found and aborted.
   */
  abortByRunId(runId: string): boolean {
    return this.activeSessionTracker.abort(runId);
  }

  /**
   * DB-aware processing: load run from DB, mark running, execute session,
   * write terminal status. Called by the queue worker.
   */
  async processRun(runId: string): Promise<void> {
    const run = await this.lifecycle.loadForProcessing(runId);
    if (!run) return;

    await this.lifecycle.markRunning(run);

    const bundle = this.handlerBuilder.buildForRun(run);
    const timeoutMs = this.lifecycle.resolveTimeoutMs(run);
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    const resumeSessionId = await this.lifecycle.resolveResumeSessionId(
      run.externalSessionId,
    );

    try {
      const result = await this.runSession({
        cwd: run.cwd,
        prompt: run.prompt,
        resumeSessionId,
        externalSessionId: run.externalSessionId ?? undefined,
        runId,
        appendSystemPrompt: run.appendSystemPrompt ?? undefined,
        additionalHandlers: bundle.additionalHandlers,
        abortController,
        traceContext: bundle.traceContext,
      });

      await this.lifecycle.finalizeSuccess(run, result.sessionId);
      await this.sourceNotifier.notifySuccess(run, bundle);
    } catch (error) {
      await this.lifecycle.persistTerminalError(run, error, {
        isTimeout: abortController.signal.aborted,
        timeoutMs,
      });
      await this.sourceNotifier.notifyError(run, bundle);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async runSession(
    params: RunSessionParams,
  ): Promise<RunSessionResult> {
    this.logger.log('Running session', { cwd: params.cwd });

    const abortController = params.abortController ?? new AbortController();
    const handle = await this.createSdkHandle(params, abortController);

    const trackKey = this.trackSession(params, abortController);

    const handlers = [
      ...this.globalHandlers,
      ...(params.additionalHandlers ?? []),
    ];

    try {
      const lastResult = await this.consumeSession(
        handle.messages,
        handlers,
        params.traceContext,
      );

      if (lastResult?.is_error) {
        throw new Error(
          lastResult.subtype === 'error_max_turns'
            ? 'Agent run exceeded maximum turns'
            : `Agent run failed: ${lastResult.subtype}`,
        );
      }

      return {
        success: !lastResult?.is_error,
        sessionId: handle.sessionId,
      };
    } finally {
      if (trackKey !== undefined) {
        this.activeSessionTracker.untrack(trackKey, params.runId);
      }
    }
  }

  private createSdkHandle(
    params: RunSessionParams,
    abortController: AbortController,
  ): ReturnType<SdkSessionFactory['create']> {
    const systemPrompts: string[] = [];
    if (params.appendSystemPrompt) {
      systemPrompts.push(params.appendSystemPrompt);
    }
    return this.sdkSessionFactory.create({
      cwd: params.cwd,
      prompt: params.prompt,
      runId: params.runId,
      additionalSystemPrompts:
        systemPrompts.length > 0 ? systemPrompts : undefined,
      abortController,
      resumeSessionId: params.resumeSessionId,
    });
  }

  private trackSession(
    params: RunSessionParams,
    abortController: AbortController,
  ): string | undefined {
    if (!params.externalSessionId && !params.runId) return undefined;
    const trackKey = params.externalSessionId ?? params.runId!;
    this.activeSessionTracker.track(trackKey, abortController, params.runId);
    return trackKey;
  }

  private async consumeSession(
    messages: AsyncIterable<SDKMessage>,
    handlers: RunEventHandler[],
    traceContext: TraceContext | undefined,
  ): Promise<SDKResultMessage | undefined> {
    let lastResult: SDKResultMessage | undefined;

    const executeSession = async (): Promise<void> => {
      try {
        for await (const message of messages) {
          await this.dispatchToHandlers(handlers, message);
          if (message.type === 'result') {
            lastResult = message;
          }
        }
      } finally {
        // Always call onComplete — handlers use this for cleanup (e.g.
        // closing tracing spans, flushing Linear activities).
        await this.completeHandlers(handlers, lastResult);
      }
    };

    if (traceContext) {
      await this.handlerBuilder.wrapWithTraceContext(
        traceContext,
        executeSession,
      );
    } else {
      await executeSession();
    }
    return lastResult;
  }

  /**
   * Dispatch a single SDK message to all handlers sequentially.
   * Errors in one handler don't prevent others from being called.
   */
  private async dispatchToHandlers(
    handlers: RunEventHandler[],
    message: SDKMessage,
  ): Promise<void> {
    for (const handler of handlers) {
      try {
        const result = handler.onMessage(message);
        if (result instanceof Promise) {
          await result;
        }
      } catch (error) {
        this.logger.error(`Handler "${handler.name}" threw`, {
          error: error as Error,
          messageType: message.type,
        });
      }
    }
  }

  /**
   * Call onComplete on all handlers that implement it.
   * Called in a finally block so it runs on both success and error paths.
   */
  private async completeHandlers(
    handlers: RunEventHandler[],
    result: SDKResultMessage | undefined,
  ): Promise<void> {
    for (const handler of handlers) {
      if (handler.onComplete) {
        try {
          await handler.onComplete(result);
        } catch (error) {
          this.logger.error(`Handler "${handler.name}" onComplete failed`, {
            error: error as Error,
          });
        }
      }
    }
  }
}
