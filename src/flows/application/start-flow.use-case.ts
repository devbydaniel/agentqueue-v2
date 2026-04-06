import { Injectable, Logger } from '@nestjs/common';
import { ApplicationError } from '../../common/errors/base.error.js';
import { FlowConfigService } from '../infrastructure/flow-config.service.js';
import { FlowRunRepository } from '../infrastructure/flow-run.repository.js';
import { FlowRunnerService } from './flow-runner.service.js';
import { FlowNotFoundError, UnexpectedFlowError } from './flows.errors.js';

export interface StartFlowCommand {
  flowName: string;
  vars: Record<string, string>;
}

export interface StartFlowResult {
  flowRunId: string;
}

@Injectable()
export class StartFlowUseCase {
  private readonly logger = new Logger(StartFlowUseCase.name);

  constructor(
    private readonly flowConfigService: FlowConfigService,
    private readonly flowRunRepository: FlowRunRepository,
    private readonly flowRunnerService: FlowRunnerService,
  ) {}

  async execute(command: StartFlowCommand): Promise<StartFlowResult> {
    this.logger.log('Starting flow', { flowName: command.flowName });

    try {
      // 1. Validate the flow exists (loadFlow throws if config is missing/invalid)
      try {
        this.flowConfigService.loadFlow(command.flowName);
      } catch {
        throw new FlowNotFoundError(command.flowName);
      }

      // 2. Create the flow run row
      const run = await this.flowRunRepository.create(
        command.flowName,
        command.vars,
      );

      // 3. Hand off to the runner (fire-and-forget; runner manages its own lifecycle)
      this.flowRunnerService.run(run.flowRunId, command.flowName, command.vars);

      return { flowRunId: run.flowRunId };
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      this.logger.error('Error starting flow', { error: error as Error });
      throw new UnexpectedFlowError(error);
    }
  }
}
