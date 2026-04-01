import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApplicationError } from '../../common/errors/base.error.js';
import { CALLBACK_HANDLERS } from '../../callbacks/constants.js';
import type { CallbackHandler } from '../../callbacks/callback-handler.interface.js';
import { AgentfilesConfigService } from '../../config/agentfiles-config.service.js';
import { UnexpectedRunError } from './runs.errors.js';
import type { AgentSession } from '@mariozechner/pi-coding-agent';

interface ExecuteRunCommand {
  repo: string;
  prompt: string;
  additionalHandlers?: CallbackHandler[];
}

export interface ExecuteRunResult {
  success: boolean;
}

@Injectable()
export class ExecuteRunUseCase {
  private readonly logger = new Logger(ExecuteRunUseCase.name);

  constructor(
    private readonly agentfilesConfigService: AgentfilesConfigService,
    @Inject(CALLBACK_HANDLERS)
    private readonly globalHandlers: CallbackHandler[],
  ) {}

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
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      settingsManager,
    });
    await resourceLoader.reload();

    const session = await createAgentSession({
      cwd,
      sessionManager: SessionManager.create(cwd),
      authStorage,
      modelRegistry,
      resourceLoader,
      settingsManager,
    });

    const detachCallbacks = this.attachHandlers(
      session.session,
      command.additionalHandlers,
    );

    try {
      await session.session.prompt(command.prompt);
      return { success: true };
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      this.logger.error('Error executing run', { error: error as Error });
      throw new UnexpectedRunError(error);
    } finally {
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
