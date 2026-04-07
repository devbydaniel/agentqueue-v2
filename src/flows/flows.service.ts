import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as path from 'node:path';
import { FlowConfigService, type FlowInfo } from './flow-config.service.js';
import { FlowResolverLoaderService } from './flow-resolver-loader.service.js';
import { FlowRunRepository, type FlowRun } from './flow-run.repository.js';
import { FlowRunnerService } from './flow-runner.service.js';
import { FlowAbortTrackerService } from './flow-abort-tracker.service.js';

export interface StartFlowParams {
  flowName: string;
  vars: Record<string, string>;
}

export interface StartFlowResult {
  flowRunId: string;
}

@Injectable()
export class FlowsService {
  private readonly logger = new Logger(FlowsService.name);

  constructor(
    private readonly flowConfigService: FlowConfigService,
    private readonly flowResolverLoader: FlowResolverLoaderService,
    private readonly flowRunRepository: FlowRunRepository,
    private readonly flowRunner: FlowRunnerService,
    private readonly flowAbortTracker: FlowAbortTrackerService,
  ) {}

  listFlows(): FlowInfo[] {
    return this.flowConfigService.listFlows();
  }

  async listFlowRuns(flowName: string): Promise<FlowRun[]> {
    return this.flowRunRepository.findByFlowName(flowName);
  }

  async getFlowRun(flowRunId: string): Promise<FlowRun> {
    const run = await this.flowRunRepository.findById(flowRunId);
    if (!run) {
      throw new NotFoundException(`Flow run "${flowRunId}" not found`);
    }
    return run;
  }

  abortFlowRun(flowRunId: string): { aborted: boolean } {
    return { aborted: this.flowAbortTracker.abort(flowRunId) };
  }

  async startFlow(params: StartFlowParams): Promise<StartFlowResult> {
    this.logger.log('Starting flow', { flowName: params.flowName });

    // Synchronously load + validate config and resolver so the API caller
    // gets immediate feedback if either is broken (NotFoundException /
    // BadRequestException propagate up to the controller).
    const config = this.flowConfigService.loadFlow(params.flowName);
    const flowDir = this.flowConfigService.getFlowDir(params.flowName);
    const resolverPath = path.resolve(flowDir, config.resolver);
    const resolve = await this.flowResolverLoader.load(resolverPath);

    // Create the flow run row
    const run = await this.flowRunRepository.create(
      params.flowName,
      params.vars,
    );

    // Register the abort controller before kicking off the loop so an abort
    // request that arrives between create() and run() still wins.
    const abortController = new AbortController();
    this.flowAbortTracker.track(run.flowRunId, abortController);

    // Hand off to the runner (fire-and-forget; runner manages its own lifecycle)
    this.flowRunner.run({
      run,
      flowDir,
      config,
      resolve,
      abortSignal: abortController.signal,
    });

    return { flowRunId: run.flowRunId };
  }
}
