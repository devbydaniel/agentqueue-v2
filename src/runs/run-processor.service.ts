import { Inject, Injectable, Logger } from '@nestjs/common';
import { LinearClient } from '@linear/sdk';
import { propagateAttributes } from '@langfuse/tracing';
import { CALLBACK_HANDLERS } from '../callbacks/constants.js';
import type { CallbackHandler } from '../callbacks/callback-handler.interface.js';
import { AssistantMessageCallbackHandler } from '../callbacks/handlers/assistant-message.callback-handler.js';
import {
  LangfuseCallbackHandlerFactory,
  type LangfuseTraceContext,
} from '../callbacks/handlers/langfuse.callback-handler.js';
import { LinearCallbackHandler } from '../callbacks/handlers/linear.callback-handler.js';
import { AppConfigService } from '../config/app-config.service.js';
import { TriggerConfigService } from '../config/trigger-config.service.js';
import { ActiveSessionTrackerService } from './active-session-tracker.service.js';
import { PiSessionFactory } from './pi-session.factory.js';
import { RunRepository } from './run.repository.js';
import { RunCompletionNotifier } from './run-completion.notifier.js';
import type { Run } from '../database/runs.schema.js';
import { RunEventRepository } from './run-event.repository.js';
import { RunEventCallbackHandler } from '../callbacks/handlers/run-event.callback-handler.js';
import type { AgentSession } from '@mariozechner/pi-coding-agent';
import { TelegramService } from '../telegram/telegram.service.js';

export interface RunSessionParams {
  cwd: string;
  prompt: string;
  additionalHandlers?: CallbackHandler[];
  /** Optional external ID to track the session for later cancellation (e.g. Linear agentSessionId) */
  externalSessionId?: string;
  externalSessionProvider?: 'linear' | 'telegram';
  /** Run ID for dual-indexed tracker (enables abort-by-runId from dashboard) */
  runId?: string;
  /** System prompt snippet to prepend before the base system prompt */
  prependSystemPrompt?: string;
  /** System prompt snippet to append after the base system prompt */
  appendSystemPrompt?: string;
  /** AbortSignal for per-run timeout */
  abortSignal?: AbortSignal;
  /** Trace-level Langfuse attributes applied for the duration of the run */
  langfuseTraceContext?: LangfuseTraceContext;
}

export interface RunSessionResult {
  success: boolean;
}

@Injectable()
export class RunProcessorService {
  private readonly logger = new Logger(RunProcessorService.name);

  constructor(
    private readonly appConfigService: AppConfigService,
    private readonly piSessionFactory: PiSessionFactory,
    private readonly activeSessionTracker: ActiveSessionTrackerService,
    private readonly runRepository: RunRepository,
    private readonly runCompletionNotifier: RunCompletionNotifier,
    private readonly runEventRepository: RunEventRepository,
    private readonly triggerConfigService: TriggerConfigService,
    private readonly telegramService: TelegramService,
    private readonly langfuseCallbackHandlerFactory: LangfuseCallbackHandlerFactory,
    @Inject(CALLBACK_HANDLERS)
    private readonly globalHandlers: CallbackHandler[],
  ) {}

  /**
   * Abort a tracked session by its external session ID (e.g. Linear agentSessionId).
   * Returns true if the session was found and aborted.
   */
  async abortSession(externalSessionId: string): Promise<boolean> {
    return this.activeSessionTracker.abort(externalSessionId);
  }

  /**
   * Abort a tracked session by its run ID.
   * Returns true if a session was found and aborted.
   */
  async abortByRunId(runId: string): Promise<boolean> {
    return this.activeSessionTracker.abort(runId);
  }

  /**
   * DB-aware processing: load run from DB, mark running, execute session,
   * write terminal status. Called by the queue worker.
   */
  async processRun(runId: string): Promise<void> {
    const run = await this.runRepository.findById(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }

    // Guard against re-processing a terminal run (e.g. pg-boss retry)
    if (run.status !== 'waiting') {
      this.logger.warn('Skipping non-waiting run', {
        runId,
        status: run.status,
      });
      return;
    }

    // Mark running
    run.status = 'running';
    run.startedAt = new Date();
    run.attemptsMade = run.attemptsMade + 1;
    await this.runRepository.save(run);

    // Build additional handlers
    const { additionalHandlers, linearHandler, assistantMessageHandler } =
      this.buildSourceHandlers(run);
    const { handler: langfuseHandler, traceContext: langfuseTraceContext } =
      this.langfuseCallbackHandlerFactory.createForRun(run);
    additionalHandlers.push(langfuseHandler);

    // Attach registry handler to persist filtered events
    additionalHandlers.push(
      new RunEventCallbackHandler(runId, this.runEventRepository),
    );

    // Per-run timeout: use the run's configured timeout, fall back to global default
    const timeoutMs = run.timeoutMs ?? this.appConfigService.runTimeoutMs;
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      await this.runSession({
        cwd: run.cwd,
        prompt: run.prompt,
        externalSessionId: run.externalSessionId ?? undefined,
        externalSessionProvider:
          run.source === 'linear' || run.source === 'telegram'
            ? run.source
            : undefined,
        runId,
        prependSystemPrompt: run.prependSystemPrompt ?? undefined,
        appendSystemPrompt: run.appendSystemPrompt ?? undefined,
        additionalHandlers,
        abortSignal: abortController.signal,
        langfuseTraceContext,
      });

      run.status = 'succeeded';
      run.completedAt = new Date();
      await this.runRepository.save(run);
      await this.runCompletionNotifier.notify(runId);

      // Emit Linear response on success
      await this.emitLinearSafe(
        linearHandler,
        () => {
          const message =
            linearHandler!.getLastAssistantMessage() ?? 'Completed.';
          return linearHandler!.emitResponse(message);
        },
        'Failed to emit success response to Linear',
      );

      await this.emitTelegramSafe(run, () =>
        this.telegramService.emitRunResponse(
          run.triggerName!,
          run.externalSessionId!,
          assistantMessageHandler?.getLastAssistantMessage() ?? 'Completed.',
        ),
      );
    } catch (error) {
      await this.handleRunError(
        run,
        runId,
        error,
        abortController.signal.aborted,
        timeoutMs,
        linearHandler,
      );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async handleRunError(
    run: Run,
    runId: string,
    error: unknown,
    isTimeout: boolean,
    timeoutMs: number,
    linearHandler: LinearCallbackHandler | undefined,
  ): Promise<void> {
    // Re-read run from DB to avoid overwriting a terminal state set by abort
    const freshRun = await this.runRepository.findById(runId);
    const terminalStatuses = new Set([
      'succeeded',
      'errored',
      'aborted',
      'timed_out',
      'interrupted',
    ]);
    if (freshRun && terminalStatuses.has(freshRun.status)) {
      this.logger.warn(
        'Skipping errored write — run already in terminal state',
        { runId, status: freshRun.status },
      );
    } else {
      if (isTimeout) {
        run.status = 'timed_out';
        run.errorMessage = `Run timed out after ${timeoutMs}ms`;
      } else {
        run.status = 'errored';
        run.errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
      }
      run.completedAt = new Date();
      try {
        await this.runRepository.save(run);
        await this.runCompletionNotifier.notify(runId);
      } catch (saveErr) {
        this.logger.error('Failed to save errored run status', {
          runId,
          error: saveErr as Error,
        });
      }
    }

    await this.emitLinearSafe(
      linearHandler,
      () => linearHandler!.emitError(run.errorMessage!),
      'Failed to emit error to Linear',
    );

    await this.emitTelegramSafe(run, () =>
      this.telegramService.emitRunError(
        run.triggerName!,
        run.externalSessionId!,
        run.errorMessage!,
      ),
    );
  }

  private buildSourceHandlers(run: {
    source: string;
    externalSessionId: string | null;
    triggerName: string | null;
  }): {
    additionalHandlers: CallbackHandler[];
    linearHandler: LinearCallbackHandler | undefined;
    assistantMessageHandler: AssistantMessageCallbackHandler | undefined;
  } {
    const additionalHandlers: CallbackHandler[] = [];
    let linearHandler: LinearCallbackHandler | undefined;
    let assistantMessageHandler: AssistantMessageCallbackHandler | undefined;

    if (run.source === 'linear' && run.externalSessionId && run.triggerName) {
      const linearConfig = this.triggerConfigService.getLinearTrigger(
        run.triggerName,
      );
      if (linearConfig) {
        const linearClient = new LinearClient({
          apiKey: linearConfig.api_key,
        });
        linearHandler = new LinearCallbackHandler(
          run.externalSessionId,
          linearClient,
        );
        additionalHandlers.push(linearHandler);
      }
    }

    if (run.source === 'telegram' && run.externalSessionId && run.triggerName) {
      assistantMessageHandler = new AssistantMessageCallbackHandler();
      additionalHandlers.push(assistantMessageHandler);
    }

    return { additionalHandlers, linearHandler, assistantMessageHandler };
  }

  private async emitLinearSafe(
    handler: LinearCallbackHandler | undefined,
    action: () => Promise<unknown>,
    errorMessage: string,
  ): Promise<void> {
    if (!handler) return;
    try {
      await action();
    } catch (emitErr) {
      this.logger.error(errorMessage, { error: emitErr as Error });
    }
  }

  private async emitTelegramSafe(
    run: {
      source: string;
      externalSessionId: string | null;
      triggerName: string | null;
    },
    action: () => Promise<unknown>,
  ): Promise<void> {
    if (
      run.source !== 'telegram' ||
      !run.externalSessionId ||
      !run.triggerName
    ) {
      return;
    }

    try {
      await action();
    } catch (emitErr) {
      this.logger.error('Failed to emit Telegram reply', {
        error: emitErr as Error,
        triggerName: run.triggerName,
        sessionKey: run.externalSessionId,
      });
    }
  }

  async runSession(params: RunSessionParams): Promise<RunSessionResult> {
    this.logger.log('Running session', { cwd: params.cwd });

    const { session, dispose } = await this.piSessionFactory.create({
      cwd: params.cwd,
      externalSessionId: params.externalSessionId,
      externalSessionProvider: params.externalSessionProvider,
      prependSystemPrompt: params.prependSystemPrompt,
      appendSystemPrompt: params.appendSystemPrompt,
    });

    const detachCallbacks = this.attachHandlers(
      session,
      params.additionalHandlers,
    );

    if (params.externalSessionId || params.runId) {
      const trackKey = params.externalSessionId ?? params.runId!;
      this.activeSessionTracker.track(trackKey, session, params.runId);
    }

    // Wire abort signal to session abort
    let onAbort: (() => void) | undefined;
    if (params.abortSignal) {
      onAbort = () => {
        this.logger.log('Abort signal received, aborting session', {
          runId: params.runId,
        });
        void session.abort();
      };
      params.abortSignal.addEventListener('abort', onAbort, { once: true });

      // If the signal was already aborted (e.g. timeout fired during session creation),
      // the listener above won't fire — trigger abort manually.
      if (params.abortSignal.aborted) {
        void session.abort();
      }
    }

    try {
      if (params.langfuseTraceContext) {
        await propagateAttributes(params.langfuseTraceContext, async () => {
          await session.prompt(params.prompt);
        });
      } else {
        await session.prompt(params.prompt);
      }
      return { success: true };
    } finally {
      if (onAbort && params.abortSignal) {
        params.abortSignal.removeEventListener('abort', onAbort);
      }
      if (params.externalSessionId || params.runId) {
        const trackKey = params.externalSessionId ?? params.runId!;
        this.activeSessionTracker.untrack(trackKey, params.runId);
      }
      detachCallbacks();
      dispose();
    }
  }

  private attachHandlers(
    session: AgentSession,
    additionalHandlers?: CallbackHandler[],
  ): () => void {
    const handlers = [...this.globalHandlers, ...(additionalHandlers ?? [])];

    const unsubscribe = session.subscribe((event) => {
      for (const handler of handlers) {
        try {
          const result = handler.onEvent(event);
          if (result instanceof Promise) {
            result.catch((err) => {
              this.logger.error(
                `Async callback handler "${handler.name}" rejected`,
                { error: err as Error, eventType: event.type },
              );
            });
          }
        } catch (error) {
          this.logger.error(`Callback handler "${handler.name}" threw`, {
            error: error as Error,
            eventType: event.type,
          });
        }
      }
    });

    this.logger.debug('Attached callback handlers to session', {
      count: handlers.length,
    });

    return unsubscribe;
  }
}
