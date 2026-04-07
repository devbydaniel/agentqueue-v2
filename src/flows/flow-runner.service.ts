import { Injectable, Logger } from '@nestjs/common';
import { RunsService } from '../runs/runs.service.js';
import { interpolateTemplate } from '../common/utils/interpolate-template.js';
import type { FlowConfig } from './flow-config.service.js';
import type {
  Resolver,
  ResolverResult,
} from './flow-resolver-loader.service.js';
import { FlowRunRepository } from './flow-run.repository.js';
import { FlowAbortTrackerService } from './flow-abort-tracker.service.js';

export interface RunFlowLoopOptions {
  flowRunId: string;
  flowName: string;
  flowDir: string;
  config: FlowConfig;
  resolve: Resolver;
  vars: Record<string, string>;
  abortSignal: AbortSignal;
}

interface LoopContext {
  flowRunId: string;
  flowName: string;
  flowDir: string;
  config: FlowConfig;
  resolve: Resolver;
  abortSignal: AbortSignal;
  vars: Record<string, string>;
}

/**
 * Runs the resolver loop for a single flow run in the background.
 *
 * Caller (FlowsService) is responsible for:
 *  - Loading the flow config + resolver synchronously
 *  - Creating the FlowRun row in the repository
 *  - Creating the AbortController and registering it with FlowAbortTrackerService
 *  - Calling `run()` with everything pre-resolved
 *
 * This service then dispatches agent steps via `RunsService` and records
 * progress in the repository. It exits the loop on done / escalate / error /
 * abort signal.
 */
@Injectable()
export class FlowRunnerService {
  private readonly logger = new Logger(FlowRunnerService.name);

  constructor(
    private readonly flowRunRepository: FlowRunRepository,
    private readonly flowAbortTracker: FlowAbortTrackerService,
    private readonly runsService: RunsService,
  ) {}

  /**
   * Kick off a flow run loop in the background. Returns immediately.
   */
  run(options: RunFlowLoopOptions): void {
    this.logger.log(
      `Starting flow "${options.flowName}" → run ${options.flowRunId}`,
    );

    void this.runLoop(options).catch((error: unknown) => {
      this.logger.error(
        `Flow run ${options.flowRunId} loop failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private async runLoop(options: RunFlowLoopOptions): Promise<void> {
    const ctx: LoopContext = {
      flowRunId: options.flowRunId,
      flowName: options.flowName,
      flowDir: options.flowDir,
      config: options.config,
      resolve: options.resolve,
      abortSignal: options.abortSignal,
      vars: { ...options.vars },
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional resolver loop; exits via return on done/escalate/error/abort
      while (true) {
        if (ctx.abortSignal.aborted) {
          await this.completeRun(ctx.flowRunId, 'aborted');
          return;
        }

        const result = await ctx.resolve(ctx.flowDir, { ...ctx.vars });
        const shouldContinue = await this.handleResult(ctx, result);
        if (!shouldContinue) return;
      }
    } catch (error) {
      await this.errorRun(ctx.flowRunId, error);
    } finally {
      // Drop the abort controller registration so the map doesn't leak
      // entries for completed runs.
      this.flowAbortTracker.untrack(ctx.flowRunId);
    }
  }

  /** Returns true to continue the loop, false to stop. */
  private async handleResult(
    ctx: LoopContext,
    result: ResolverResult,
  ): Promise<boolean> {
    if ('done' in result) {
      await this.completeRun(ctx.flowRunId, 'done', result.summary);
      return false;
    }

    if ('escalate' in result) {
      await this.completeRun(ctx.flowRunId, 'escalated', result.escalate);
      return false;
    }

    if (!('agent' in result)) {
      await this.completeRun(
        ctx.flowRunId,
        'errored',
        'Resolver returned invalid result (no agent/done/escalate)',
      );
      return false;
    }

    return this.dispatchAgent(ctx, result.agent, result.vars);
  }

  /** Dispatches an agent step. Returns true to continue loop, false to stop. */
  private async dispatchAgent(
    ctx: LoopContext,
    agentName: string,
    stepVars: Record<string, string>,
  ): Promise<boolean> {
    const agentConfig = ctx.config.agents.find((a) => a.name === agentName);
    if (!agentConfig) {
      await this.completeRun(
        ctx.flowRunId,
        'errored',
        `Resolver returned unknown agent "${agentName}"`,
      );
      return false;
    }

    Object.assign(ctx.vars, stepVars);
    const renderedPrompt = interpolateTemplate(agentConfig.prompt, ctx.vars);

    await this.flowRunRepository.addStep(ctx.flowRunId, {
      agent: agentName,
      vars: { ...stepVars },
      startedAt: new Date(),
    });
    await this.flowRunRepository.update(ctx.flowRunId, {
      currentAgent: agentName,
      vars: { ...ctx.vars },
    });

    this.logger.log(
      `Flow run ${ctx.flowRunId}: dispatching agent "${agentName}" → ${agentConfig.target}`,
    );

    try {
      await this.runsService.execute({
        repo: agentConfig.target,
        prompt: renderedPrompt,
      });
      await this.flowRunRepository.completeStep(ctx.flowRunId, true);
      return true;
    } catch (error) {
      await this.flowRunRepository.completeStep(ctx.flowRunId, false);
      const msg = `Dispatch failed for agent "${agentName}": ${error instanceof Error ? error.message : String(error)}`;
      this.logger.error(`Flow run ${ctx.flowRunId}: ${msg}`);
      await this.completeRun(ctx.flowRunId, 'errored', msg);
      return false;
    }
  }

  private async completeRun(
    flowRunId: string,
    status: 'done' | 'escalated' | 'errored' | 'aborted',
    message?: string,
  ): Promise<void> {
    this.logger.log(`Flow run ${flowRunId} → ${status}`);
    await this.flowRunRepository.update(flowRunId, {
      status,
      message,
      completedAt: new Date(),
    });
  }

  private async errorRun(flowRunId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`Flow run ${flowRunId} errored: ${message}`);
    await this.flowRunRepository.update(flowRunId, {
      status: 'errored',
      message,
      completedAt: new Date(),
    });
  }
}
