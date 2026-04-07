import { Inject, Injectable, Logger } from '@nestjs/common';
import { CALLBACK_HANDLERS } from '../callbacks/constants.js';
import type { CallbackHandler } from '../callbacks/callback-handler.interface.js';
import { AgentfilesConfigService } from '../config/agentfiles-config.service.js';
import { LinearSessionRepository } from './linear-session.repository.js';
import { ActiveSessionTrackerService } from './active-session-tracker.service.js';
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
    private readonly linearSessionRepository: LinearSessionRepository,
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
    this.logger.log('Executing run', {
      repo: command.repo,
    });

    const cwd = this.agentfilesConfigService.resolveRepo(command.repo);

    const {
      createAgentSession,
      SessionManager,
      AuthStorage,
      ModelRegistry,
      DefaultResourceLoader,
      SettingsManager,
    } = await import('@mariozechner/pi-coding-agent');

    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    const settingsManager = SettingsManager.create(cwd);
    const resourceLoaderOptions: Record<string, unknown> = {
      cwd,
      settingsManager,
    };

    if (command.prependSystemPrompt) {
      const snippet = command.prependSystemPrompt;
      resourceLoaderOptions['systemPromptOverride'] = (
        base: string | undefined,
      ) => (base ? `${snippet}\n\n${base}` : snippet);
    }

    if (command.appendSystemPrompt) {
      const snippet = command.appendSystemPrompt;
      resourceLoaderOptions['appendSystemPromptOverride'] = (
        base: string[],
      ) => [...base, snippet];
    }

    const resourceLoader = new DefaultResourceLoader(resourceLoaderOptions);
    await resourceLoader.reload();

    // Resume existing pi session or create a new one
    const existingSessionFile = command.sessionKey
      ? await this.linearSessionRepository.findFilePath(command.sessionKey)
      : null;

    let sessionMgr: ReturnType<typeof SessionManager.create>;
    if (existingSessionFile) {
      try {
        sessionMgr = SessionManager.open(existingSessionFile);
        this.logger.log('Resuming pi session', {
          sessionKey: command.sessionKey,
          sessionFile: existingSessionFile,
        });
      } catch (error) {
        this.logger.warn('Failed to resume pi session, starting new', {
          sessionKey: command.sessionKey,
          error: error as Error,
        });
        sessionMgr = SessionManager.create(cwd);
      }
    } else {
      sessionMgr = SessionManager.create(cwd);
    }

    const session = await createAgentSession({
      cwd,
      sessionManager: sessionMgr,
      authStorage,
      modelRegistry,
      resourceLoader,
      settingsManager,
    });

    // Store session file path for future resumption
    if (command.sessionKey) {
      const sessionFile = sessionMgr.getSessionFile();
      if (sessionFile) {
        await this.linearSessionRepository.saveFilePath(
          command.sessionKey,
          sessionFile,
        );
      }
    }

    const detachCallbacks = this.attachHandlers(
      session.session,
      command.additionalHandlers,
    );

    if (command.sessionKey) {
      this.activeSessionTracker.track(command.sessionKey, session.session);
    }

    try {
      await session.session.prompt(command.prompt);
      return { success: true };
    } finally {
      if (command.sessionKey) {
        this.activeSessionTracker.untrack(command.sessionKey);
      }
      detachCallbacks();
      session.session.dispose();
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
