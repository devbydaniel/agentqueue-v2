import { Inject, Injectable, Logger } from '@nestjs/common';
import { LinearClient } from '@linear/sdk';
import { CALLBACK_HANDLERS } from '../callbacks/constants.js';
import type { CallbackHandler } from '../callbacks/callback-handler.interface.js';
import { LinearCallbackHandler } from '../callbacks/handlers/linear.callback-handler.js';
import { AgentfilesConfigService } from '../config/agentfiles-config.service.js';
import { TriggerConfigService } from '../config/trigger-config.service.js';
import { ActiveSessionTrackerService } from './active-session-tracker.service.js';
import { PiSessionFactory } from './pi-session.factory.js';
import { RunRepository } from './run.repository.js';
import { RunCompletionNotifier } from './run-completion.notifier.js';
import { RunEventRepository } from './run-event.repository.js';
import { RunEventCallbackHandler } from '../callbacks/handlers/run-event.callback-handler.js';
import type { AgentSession } from '@mariozechner/pi-coding-agent';

export interface RunSessionParams {
  repo: string;
  prompt: string;
  additionalHandlers?: CallbackHandler[];
  /** Optional key to track the session for later cancellation (e.g. Linear agentSessionId) */
  sessionKey?: string;
  /** System prompt snippet to prepend before the base system prompt */
  prependSystemPrompt?: string;
  /** System prompt snippet to append after the base system prompt */
  appendSystemPrompt?: string;
}

export interface RunSessionResult {
  success: boolean;
}

@Injectable()
export class RunProcessorService {
  private readonly logger = new Logger(RunProcessorService.name);

  constructor(
    private readonly agentfilesConfigService: AgentfilesConfigService,
    private readonly piSessionFactory: PiSessionFactory,
    private readonly activeSessionTracker: ActiveSessionTrackerService,
    private readonly runRepository: RunRepository,
    private readonly runCompletionNotifier: RunCompletionNotifier,
    private readonly runEventRepository: RunEventRepository,
    private readonly triggerConfigService: TriggerConfigService,
    @Inject(CALLBACK_HANDLERS)
    private readonly globalHandlers: CallbackHandler[],
  ) {}

  /**
   * Abort a tracked session by its key (e.g. Linear agentSessionId).
   * Returns true if the session was found and aborted.
   */
  async abortSession(sessionKey: string): Promise<boolean> {
    return this.activeSessionTracker.abort(sessionKey);
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
    const { additionalHandlers, linearHandler } = this.buildLinearHandlers(run);

    // Attach registry handler to persist filtered events
    additionalHandlers.push(
      new RunEventCallbackHandler(runId, this.runEventRepository),
    );

    try {
      await this.runSession({
        repo: run.repo,
        prompt: run.prompt,
        sessionKey: run.sessionKey ?? undefined,
        prependSystemPrompt: run.prependSystemPrompt ?? undefined,
        appendSystemPrompt: run.appendSystemPrompt ?? undefined,
        additionalHandlers,
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
    } catch (error) {
      run.status = 'errored';
      run.errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
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

      await this.emitLinearSafe(
        linearHandler,
        () => linearHandler!.emitError(run.errorMessage!),
        'Failed to emit error to Linear',
      );

      throw error;
    }
  }

  private buildLinearHandlers(run: {
    source: string;
    sessionKey: string | null;
    triggerName: string | null;
  }): {
    additionalHandlers: CallbackHandler[];
    linearHandler: LinearCallbackHandler | undefined;
  } {
    const additionalHandlers: CallbackHandler[] = [];
    let linearHandler: LinearCallbackHandler | undefined;

    if (run.source === 'linear' && run.sessionKey && run.triggerName) {
      const linearConfig = this.triggerConfigService.getLinearTrigger(
        run.triggerName,
      );
      if (linearConfig) {
        const linearClient = new LinearClient({
          apiKey: linearConfig.api_key,
        });
        linearHandler = new LinearCallbackHandler(run.sessionKey, linearClient);
        additionalHandlers.push(linearHandler);
      }
    }

    return { additionalHandlers, linearHandler };
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

  async runSession(params: RunSessionParams): Promise<RunSessionResult> {
    this.logger.log('Running session', { repo: params.repo });

    const cwd = this.agentfilesConfigService.resolveRepo(params.repo);

    const { session, dispose } = await this.piSessionFactory.create({
      cwd,
      sessionKey: params.sessionKey,
      prependSystemPrompt: params.prependSystemPrompt,
      appendSystemPrompt: params.appendSystemPrompt,
    });

    const detachCallbacks = this.attachHandlers(
      session,
      params.additionalHandlers,
    );

    if (params.sessionKey) {
      this.activeSessionTracker.track(params.sessionKey, session);
    }

    try {
      await session.prompt(params.prompt);
      return { success: true };
    } finally {
      if (params.sessionKey) {
        this.activeSessionTracker.untrack(params.sessionKey);
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
