import { Injectable, Logger } from '@nestjs/common';
import { ApplicationError } from '../../common/errors/base.error.js';
import { CallbackManager } from '../../callbacks/callback-manager.service.js';
import { AgentfilesConfigService } from '../../config/agentfiles-config.service.js';
import { UnexpectedRunError } from './runs.errors.js';

interface ExecuteRunCommand {
  repo: string;
  prompt: string;
}

export interface ExecuteRunResult {
  success: boolean;
}

@Injectable()
export class ExecuteRunUseCase {
  private readonly logger = new Logger(ExecuteRunUseCase.name);

  constructor(
    private readonly agentfilesConfigService: AgentfilesConfigService,
    private readonly callbackManager: CallbackManager,
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

    const detachCallbacks = this.callbackManager.attachToSession(
      session.session,
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
}
