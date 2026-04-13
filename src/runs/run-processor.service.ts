import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  SDKMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { RUN_EVENT_HANDLERS } from '../callbacks/constants.js';
import type { RunEventHandler } from '../callbacks/run-event-handler.interface.js';
import { AssistantMessageCallbackHandler } from '../callbacks/handlers/assistant-message.callback-handler.js';
import { TracingEnrichmentHandlerFactory } from '../callbacks/handlers/tracing-enrichment.callback-handler.js';
import type { TraceContext } from '../callbacks/build-trace-context.js';
import {
  LinearCallbackHandler,
  LinearCallbackHandlerFactory,
} from '../callbacks/handlers/linear.callback-handler.js';
import { AgentProfileService } from '../agents/agent-profile.service.js';
import type { AgentProfile } from '../agents/agent-profile.interface.js';
import { AppConfigService } from '../config/app-config.service.js';
import { ActiveSessionTrackerService } from './active-session-tracker.service.js';
import { SdkSessionFactory } from './sdk-session.factory.js';
import { ExternalSessionRepository } from './external-session.repository.js';
import { RunRepository } from './run.repository.js';
import { RunCompletionNotifier } from './run-completion.notifier.js';
import type { Run } from '../database/runs.schema.js';
import { RunEventRepository } from './run-event.repository.js';
import { RunEventCallbackHandler } from '../callbacks/handlers/run-event.callback-handler.js';
import { TelegramService } from '../telegram/telegram.service.js';

export interface RunSessionParams {
  cwd: string;
  prompt: string;
  /** Resolved agent profile (enables model/tool/subagent overrides) */
  profile?: AgentProfile;
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
    private readonly appConfigService: AppConfigService,
    private readonly sdkSessionFactory: SdkSessionFactory,
    private readonly activeSessionTracker: ActiveSessionTrackerService,
    private readonly runRepository: RunRepository,
    private readonly runCompletionNotifier: RunCompletionNotifier,
    private readonly externalSessionRepository: ExternalSessionRepository,
    private readonly runEventRepository: RunEventRepository,
    private readonly telegramService: TelegramService,
    private readonly tracingEnrichmentHandlerFactory: TracingEnrichmentHandlerFactory,
    private readonly linearCallbackHandlerFactory: LinearCallbackHandlerFactory,
    private readonly agentProfileService: AgentProfileService,
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

    // Resolve agent profile (if the run references one)
    const profile = run.agentName
      ? this.agentProfileService.getProfile(run.agentName)
      : undefined;

    if (run.agentName && !profile) {
      this.logger.warn(
        `Agent profile "${run.agentName}" not found — running without profile overrides`,
        { runId },
      );
    }

    // Agent profile repo overrides the run's cwd (already expanded by AgentProfileService)
    const effectiveCwd = profile?.repo ?? run.cwd;

    // Mark running
    run.status = 'running';
    run.startedAt = new Date();
    run.attemptsMade = run.attemptsMade + 1;
    await this.runRepository.save(run);

    // Build additional handlers
    const { additionalHandlers, linearHandler, assistantMessageHandler } =
      this.buildSourceHandlers(run);
    const { handler: tracingHandler, traceContext } =
      this.tracingEnrichmentHandlerFactory.createForRun(run);
    additionalHandlers.push(tracingHandler);

    // Attach registry handler to persist filtered events
    additionalHandlers.push(
      new RunEventCallbackHandler(runId, this.runEventRepository),
    );

    // Per-run timeout: use the run's configured timeout, fall back to global default
    const timeoutMs = run.timeoutMs ?? this.appConfigService.runTimeoutMs;
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);

    // Look up existing SDK session ID for resume
    const resumeSessionId = run.externalSessionId
      ? await this.externalSessionRepository.findSessionId(
          run.externalSessionId,
        )
      : null;

    try {
      const result = await this.runSession({
        cwd: effectiveCwd,
        prompt: run.prompt,
        profile,
        resumeSessionId: resumeSessionId ?? undefined,
        externalSessionId: run.externalSessionId ?? undefined,
        runId,
        appendSystemPrompt: run.appendSystemPrompt ?? undefined,
        additionalHandlers,
        abortController,
        traceContext,
      });

      // Persist SDK session ID for future resumes
      if (run.externalSessionId && result.sessionId) {
        await this.externalSessionRepository.upsertSession({
          provider: run.source as 'linear' | 'telegram',
          sessionKey: run.externalSessionId,
          sessionId: result.sessionId,
        });
      }

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
    additionalHandlers: RunEventHandler[];
    linearHandler: LinearCallbackHandler | undefined;
    assistantMessageHandler: AssistantMessageCallbackHandler | undefined;
  } {
    const additionalHandlers: RunEventHandler[] = [];
    let linearHandler: LinearCallbackHandler | undefined;
    let assistantMessageHandler: AssistantMessageCallbackHandler | undefined;

    if (run.source === 'linear' && run.externalSessionId && run.triggerName) {
      linearHandler = this.linearCallbackHandlerFactory.createForRun(
        run.triggerName,
        run.externalSessionId,
      );
      if (linearHandler) {
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

  private async runSession(
    params: RunSessionParams,
  ): Promise<RunSessionResult> {
    this.logger.log('Running session', { cwd: params.cwd });

    const abortController = params.abortController ?? new AbortController();

    const systemPrompts: string[] = [];
    if (params.appendSystemPrompt) {
      systemPrompts.push(params.appendSystemPrompt);
    }

    const handle = await this.sdkSessionFactory.create({
      cwd: params.cwd,
      prompt: params.prompt,
      profile: params.profile,
      additionalSystemPrompts:
        systemPrompts.length > 0 ? systemPrompts : undefined,
      abortController,
      resumeSessionId: params.resumeSessionId,
    });

    // Track for abort-on-demand
    if (params.externalSessionId || params.runId) {
      const trackKey = params.externalSessionId ?? params.runId!;
      this.activeSessionTracker.track(trackKey, abortController, params.runId);
    }

    const handlers = [
      ...this.globalHandlers,
      ...(params.additionalHandlers ?? []),
    ];

    let lastResult: SDKResultMessage | undefined;

    try {
      const executeSession = async (): Promise<void> => {
        try {
          for await (const message of handle.messages) {
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

      if (params.traceContext) {
        await this.tracingEnrichmentHandlerFactory.wrapWithContext(
          params.traceContext,
          executeSession,
        );
      } else {
        await executeSession();
      }

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
      if (params.externalSessionId || params.runId) {
        const trackKey = params.externalSessionId ?? params.runId!;
        this.activeSessionTracker.untrack(trackKey, params.runId);
      }
    }
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
