import { Inject, Injectable, Logger } from '@nestjs/common';
import { CALLBACK_HANDLERS } from '../callbacks/constants.js';
import type { CallbackHandler } from '../callbacks/callback-handler.interface.js';
import { AgentfilesConfigService } from '../config/agentfiles-config.service.js';
import { ActiveSessionTrackerService } from './active-session-tracker.service.js';
import { PiSessionFactory } from './pi-session.factory.js';
import type { AgentSession } from '@mariozechner/pi-coding-agent';

export interface ExecuteRunCommand {
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

export interface ExecuteRunResult {
  success: boolean;
}

@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);

  constructor(
    private readonly agentfilesConfigService: AgentfilesConfigService,
    private readonly piSessionFactory: PiSessionFactory,
    private readonly activeSessionTracker: ActiveSessionTrackerService,
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

  async execute(command: ExecuteRunCommand): Promise<ExecuteRunResult> {
    this.logger.log('Executing run', { repo: command.repo });

    const cwd = this.agentfilesConfigService.resolveRepo(command.repo);

    const { session, dispose } = await this.piSessionFactory.create({
      cwd,
      sessionKey: command.sessionKey,
      prependSystemPrompt: command.prependSystemPrompt,
      appendSystemPrompt: command.appendSystemPrompt,
    });

    const detachCallbacks = this.attachHandlers(
      session,
      command.additionalHandlers,
    );

    if (command.sessionKey) {
      this.activeSessionTracker.track(command.sessionKey, session);
    }

    try {
      await session.prompt(command.prompt);
      return { success: true };
    } finally {
      if (command.sessionKey) {
        this.activeSessionTracker.untrack(command.sessionKey);
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
