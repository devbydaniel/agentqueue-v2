import { Injectable, Logger } from '@nestjs/common';
import type { AgentSession } from '@mariozechner/pi-coding-agent';
import { LinearSessionRepository } from './linear-session.repository.js';

export interface CreatePiSessionOptions {
  cwd: string;
  /** Optional external ID to resume / store the underlying pi session file under */
  externalSessionId?: string;
  /** System prompt snippet to prepend before the base system prompt */
  prependSystemPrompt?: string;
  /** System prompt snippet to append after the base system prompt */
  appendSystemPrompt?: string;
}

export interface CreatedPiSession {
  session: AgentSession;
  /** Drop pi SDK resources held by the session. Always call this when done. */
  dispose: () => void;
}

/**
 * Builds a pi `AgentSession` ready to be prompted.
 *
 * Owns the verbose pi SDK plumbing — auth storage, model registry, settings,
 * resource loader (with optional system-prompt overrides), and session
 * resume-or-create against `LinearSessionRepository`. `RunsService` calls
 * this and never imports `@mariozechner/pi-coding-agent` directly.
 */
@Injectable()
export class PiSessionFactory {
  private readonly logger = new Logger(PiSessionFactory.name);

  constructor(
    private readonly linearSessionRepository: LinearSessionRepository,
  ) {}

  async create(options: CreatePiSessionOptions): Promise<CreatedPiSession> {
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
    const settingsManager = SettingsManager.create(options.cwd);

    const resourceLoaderOptions: Record<string, unknown> = {
      cwd: options.cwd,
      settingsManager,
    };

    if (options.prependSystemPrompt) {
      const snippet = options.prependSystemPrompt;
      resourceLoaderOptions['systemPromptOverride'] = (
        base: string | undefined,
      ) => (base ? `${snippet}\n\n${base}` : snippet);
    }

    if (options.appendSystemPrompt) {
      const snippet = options.appendSystemPrompt;
      resourceLoaderOptions['appendSystemPromptOverride'] = (
        base: string[],
      ) => [...base, snippet];
    }

    const resourceLoader = new DefaultResourceLoader(resourceLoaderOptions);
    await resourceLoader.reload();

    // Resume existing pi session or create a new one
    const existingSessionFile = options.externalSessionId
      ? await this.linearSessionRepository.findFilePath(
          options.externalSessionId,
        )
      : null;

    let sessionMgr: ReturnType<typeof SessionManager.create>;
    if (existingSessionFile) {
      try {
        sessionMgr = SessionManager.open(existingSessionFile);
        this.logger.log('Resuming pi session', {
          externalSessionId: options.externalSessionId,
          sessionFile: existingSessionFile,
        });
      } catch (error) {
        this.logger.warn('Failed to resume pi session, starting new', {
          externalSessionId: options.externalSessionId,
          error: error as Error,
        });
        sessionMgr = SessionManager.create(options.cwd);
      }
    } else {
      sessionMgr = SessionManager.create(options.cwd);
    }

    const agentSession = await createAgentSession({
      cwd: options.cwd,
      sessionManager: sessionMgr,
      authStorage,
      modelRegistry,
      resourceLoader,
      settingsManager,
    });

    // Store session file path for future resumption
    if (options.externalSessionId) {
      const sessionFile = sessionMgr.getSessionFile();
      if (sessionFile) {
        await this.linearSessionRepository.saveFilePath(
          options.externalSessionId,
          sessionFile,
        );
      }
    }

    return {
      session: agentSession.session,
      dispose: () => agentSession.session.dispose(),
    };
  }
}
