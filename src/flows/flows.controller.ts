import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { FlowConfigService } from './flow-config.service.js';
import { FlowRegistryService } from './flow-registry.service.js';
import { FlowExecutorService } from './application/flow-executor.service.js';
import {
  FlowNotFoundError,
  FlowRunNotFoundError,
} from './application/flows.errors.js';
import { StartFlowDto } from './dto/start-flow.dto.js';

@ApiTags('Flows')
@Controller('flows')
export class FlowsController {
  constructor(
    private readonly flowConfigService: FlowConfigService,
    private readonly flowRegistry: FlowRegistryService,
    private readonly flowExecutor: FlowExecutorService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List available flows',
    description:
      'Scans ~/.agentqueue/flows/ for directories with a config.yaml.',
  })
  @ApiResponse({ status: 200, description: 'List of available flows' })
  listFlows() {
    return this.flowConfigService.listFlows();
  }

  @Post(':name/start')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Start a flow run',
    description:
      'Validates the flow exists, kicks off execution in the background, and returns the flow run ID immediately.',
  })
  @ApiResponse({ status: 200, description: 'Flow run started' })
  @ApiResponse({ status: 404, description: 'Flow not found' })
  startFlow(
    @Param('name') name: string,
    @Body() dto: StartFlowDto,
  ): { flowRunId: string } {
    // Validate flow exists (throws if config missing/invalid)
    try {
      this.flowConfigService.loadFlow(name);
    } catch {
      throw new FlowNotFoundError(name);
    }

    const flowRunId = this.flowExecutor.start(name, dto.vars ?? {});
    return { flowRunId };
  }

  @Get(':name/runs')
  @ApiOperation({
    summary: 'List runs for a flow',
    description: 'Returns all tracked runs (active + completed) for a flow.',
  })
  @ApiResponse({ status: 200, description: 'List of flow runs' })
  listRuns(@Param('name') name: string) {
    return this.flowRegistry.listByFlow(name);
  }

  @Get('runs/:runId')
  @ApiOperation({
    summary: 'Get flow run details',
    description: 'Returns the status, steps, and vars of a specific flow run.',
  })
  @ApiResponse({ status: 200, description: 'Flow run details' })
  @ApiResponse({ status: 404, description: 'Flow run not found' })
  getRun(@Param('runId') runId: string) {
    const run = this.flowRegistry.get(runId);
    if (!run) {
      throw new FlowRunNotFoundError(runId);
    }
    return run;
  }

  @Post('runs/:runId/abort')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Abort a running flow',
    description:
      'Signals the abort controller for the flow run. Returns whether the abort was successful.',
  })
  @ApiResponse({ status: 200, description: 'Abort result' })
  abortRun(@Param('runId') runId: string): { aborted: boolean } {
    const aborted = this.flowRegistry.abort(runId);
    return { aborted };
  }
}
