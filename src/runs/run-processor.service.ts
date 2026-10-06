import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  AgentSession,
  AgentSessionEvent,
} from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { RUN_EVENT_HANDLERS } from '../callbacks/constants.js';
import type {
  RunEventHandler,
  SessionStartInfo,
} from '../callbacks/run-event-handler.interface.js';
import {
  assistantMessageOf,
  type AssistantMessage,
} from '../callbacks/pi-messages.js';
import type { TraceContext } from '../callbacks/build-trace-context.js';
import { ActiveSessionTrackerService } from './active-session-tracker.service.js';
import { PiSessionFactory } from './pi-session.factory.js';
import { RunLifecycleService } from './run-lifecycle.service.js';
import { RunHandlerBuilder } from './run-handler-builder.service.js';
import { RunSourceNotifier } from './run-source-notifier.service.js';

export interface RunSessionParams {
  cwd: string;
  prompt: string;
  additionalHandlers?: RunEventHandler[];
  /** pi session ID to resume */
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
  sessionId: string;
}

@Injectable()
export class RunProcessorService {
  private readonly logger = new Logger(RunProcessorService.name);

  constructor(
    private readonly piSessionFactory: PiSessionFactory,
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
    const session = await this.createPiSession(params);
    const trackKey = this.trackSession(params, abortController);
    const abortSession = () => {
      session.abort().catch((error: unknown) => {
        this.logger.error('Failed to abort pi session', {
          error: error as Error,
        });
      });
    };
    abortController.signal.addEventListener('abort', abortSession, {
      once: true,
    });

    const handlers = [
      ...this.globalHandlers,
      ...(params.additionalHandlers ?? []),
    ];

    try {
      // pi's abort() only cancels an active turn, so an abort that landed
      // while the session was being created must stop the prompt here.
      this.throwIfAborted(abortController.signal);
      const lastAssistant = await this.consumeSession(
        session,
        params.prompt,
        handlers,
        params.traceContext,
      );

      this.throwIfAborted(abortController.signal);
      // Provider failures (overload, auth, context overflow) don't throw:
      // pi ends the run with an assistant message whose stopReason is error.
      if (lastAssistant?.stopReason === 'error') {
        throw new Error(
          `Agent run failed: ${lastAssistant.errorMessage ?? 'unknown error'}`,
        );
      }

      return { sessionId: session.sessionId };
    } finally {
      abortController.signal.removeEventListener('abort', abortSession);
      if (trackKey !== undefined) {
        this.activeSessionTracker.untrack(trackKey, params.runId);
      }
      await this.piSessionFactory.close(session);
    }
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new Error('Agent run aborted');
  }

  private createPiSession(params: RunSessionParams): Promise<AgentSession> {
    return this.piSessionFactory.create({
      cwd: params.cwd,
      runId: params.runId,
      additionalSystemPrompts: params.appendSystemPrompt
        ? [params.appendSystemPrompt]
        : undefined,
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

  /**
   * Prompt the session and fan its events out to the handlers. Returns the
   * last completed assistant message, which carries the run's stop reason.
   */
  private async consumeSession(
    session: AgentSession,
    prompt: string,
    handlers: RunEventHandler[],
    traceContext: TraceContext | undefined,
  ): Promise<AssistantMessage | undefined> {
    let lastAssistant: AssistantMessage | undefined;
    // pi listeners are synchronous; chain dispatches so async handlers see
    // events one at a time and in emission order.
    let dispatchChain = Promise.resolve();

    const executeSession = async (): Promise<void> => {
      const unsubscribe = session.subscribe((event) => {
        lastAssistant = assistantMessageOf(event) ?? lastAssistant;
        dispatchChain = dispatchChain.then(() =>
          this.dispatchToHandlers(handlers, event),
        );
      });
      try {
        await this.startHandlers(handlers, this.sessionStartInfo(session));
        await session.prompt(prompt);
        // Extensions can start follow-up turns after prompt() settles (e.g. a
        // subagent reporting back); wait until pi stops continuing on its own.
        await session.waitForIdle();
      } finally {
        unsubscribe();
        await dispatchChain;
        // Always call onComplete — handlers use this for cleanup (e.g.
        // flushing Linear activities).
        await this.completeHandlers(handlers);
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
    return lastAssistant;
  }

  private sessionStartInfo(session: AgentSession): SessionStartInfo {
    const model = session.model;
    return {
      sessionId: session.sessionId,
      model: model ? `${model.provider}/${model.id}` : undefined,
      tools: session.getActiveToolNames(),
    };
  }

  private async startHandlers(
    handlers: RunEventHandler[],
    info: SessionStartInfo,
  ): Promise<void> {
    for (const handler of handlers) {
      if (!handler.onStart) continue;
      try {
        await handler.onStart(info);
      } catch (error) {
        this.logger.error(`Handler "${handler.name}" onStart failed`, {
          error: error as Error,
        });
      }
    }
  }

  /**
   * Dispatch a single pi event to all handlers sequentially.
   * Errors in one handler don't prevent others from being called.
   */
  private async dispatchToHandlers(
    handlers: RunEventHandler[],
    event: AgentSessionEvent,
  ): Promise<void> {
    for (const handler of handlers) {
      try {
        await handler.onEvent(event);
      } catch (error) {
        this.logger.error(`Handler "${handler.name}" threw`, {
          error: error as Error,
          eventType: event.type,
        });
      }
    }
  }

  /**
   * Call onComplete on all handlers that implement it.
   * Called in a finally block so it runs on both success and error paths.
   */
  private async completeHandlers(handlers: RunEventHandler[]): Promise<void> {
    for (const handler of handlers) {
      if (handler.onComplete) {
        try {
          await handler.onComplete();
        } catch (error) {
          this.logger.error(`Handler "${handler.name}" onComplete failed`, {
            error: error as Error,
          });
        }
      }
    }
  }
}
