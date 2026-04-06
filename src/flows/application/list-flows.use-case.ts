import { Injectable, Logger } from '@nestjs/common';
import { ApplicationError } from '../../common/errors/base.error.js';
import { FlowConfigService } from '../flow-config.service.js';
import type { FlowInfo } from '../flow-config.interface.js';
import { UnexpectedFlowError } from './flows.errors.js';

@Injectable()
export class ListFlowsUseCase {
  private readonly logger = new Logger(ListFlowsUseCase.name);

  constructor(private readonly flowConfigService: FlowConfigService) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- async signature for use-case consistency; underlying call is sync
  async execute(): Promise<FlowInfo[]> {
    this.logger.log('Listing flows');

    try {
      return this.flowConfigService.listFlows();
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      this.logger.error('Error listing flows', { error: error as Error });
      throw new UnexpectedFlowError(error);
    }
  }
}
