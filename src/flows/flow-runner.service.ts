import { Injectable, Logger } from '@nestjs/common';
import { RunsService } from '../runs/runs.service.js';
import { interpolateTemplate } from '../common/utils/interpolate-template.js';
import type { FlowConfig } from './flow-config.service.js';
import type {
  Resolver,
  ResolverResult,
} from './flow-resolver-loader.service.js';
import {
  FlowRunRepository,
  type FlowRun,
  type FlowRunStatus,
  type FlowStepRecord,
} from './flow-run.repository.js';
import { FlowAbortTrackerService } from './flow-abort-tracker.service.js';
import { FlowRunCompletionListener } from './flow-run-completion.listener.js';

/** Timeout for waiting on a single agent step completion (30 minutes) */
const FLOW_STEP_TIMEOUT_MS = 30 * 60 * 1000;

export interface RunFlowLoopOptions {
  run: FlowRun;
  flowDir: string;
  config: FlowConfig;
  resolve: Resolver;
  abortSignal: AbortSignal;
}

interface LoopContext {
  run: FlowRun;
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
 *  - Calling `run()` with the pre-loaded FlowRun and context
 *
 * This service then dispatches agent steps via `RunsService` and persists
 * progress through the repository's `save(run)` method. It exits the loop on
 * done / escalate / error / abort signal.
 */
@Injectable()
export class FlowRunnerService {
  private readonly logger = new Logger(FlowRunnerService.name);

  constructor(
    private readonly flowRunRepository: FlowRunRepository,
    private readonly flowAbortTracker: FlowAbortTrackerService,
    private readonly runsService: RunsService,
    private readonly flowRunCompletionListener: FlowRunCompletionListener,
  ) {}

  /**
   * Kick off a flow run loop in the background. Returns immediately.
   */
  run(options: RunFlowLoopOptions): void {
    this.logger.log(
      `Starting flow "${options.run.flowName}" → run ${options.run.flowRunId}`,
    );

    void this.runLoop(options).catch((error: unknown) => {
      this.logger.error(
        `Flow run ${options.run.flowRunId} loop failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private async runLoop(options: RunFlowLoopOptions): Promise<void> {
    const ctx: LoopContext = {
      run: options.run,
      flowDir: options.flowDir,
      config: options.config,
      resolve: options.resolve,
      abortSignal: options.abortSignal,
      vars: { ...options.run.vars },
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional resolver loop; exits via return on done/escalate/error/abort
      while (true) {
        if (ctx.abortSignal.aborted) {
          await this.completeRun(ctx, 'aborted');
          return;
        }

        const result = await ctx.resolve(ctx.flowDir, { ...ctx.vars });
        const shouldContinue = await this.handleResult(ctx, result);
        if (!shouldContinue) return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Flow run ${ctx.run.flowRunId} errored: ${message}`);
      await this.completeRun(ctx, 'errored', message);
    } finally {
      // Drop the abort controller registration so the map doesn't leak
      // entries for completed runs.
      this.flowAbortTracker.untrack(ctx.run.flowRunId);
    }
  }

  /** Returns true to continue the loop, false to stop. */
  private async handleResult(
    ctx: LoopContext,
    result: ResolverResult,
  ): Promise<boolean> {
    if ('done' in result) {
      await this.completeRun(ctx, 'done', result.summary);
      return false;
    }

    if ('escalate' in result) {
      await this.completeRun(ctx, 'escalated', result.escalate);
      return false;
    }

    if (!('agent' in result)) {
      await this.completeRun(
        ctx,
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
        ctx,
        'errored',
        `Resolver returned unknown agent "${agentName}"`,
      );
      return false;
    }

    Object.assign(ctx.vars, stepVars);
    const renderedPrompt = interpolateTemplate(agentConfig.prompt, ctx.vars);

    const step: FlowStepRecord = {
      agent: agentName,
      vars: { ...stepVars },
      startedAt: new Date(),
    };
    ctx.run.steps.push(step);
    ctx.run.currentAgent = agentName;
    ctx.run.vars = { ...ctx.vars };
    await this.flowRunRepository.save(ctx.run);

    this.logger.log(
      `Flow run ${ctx.run.flowRunId}: dispatching agent "${agentName}" → ${agentConfig.target}`,
    );

    try {
      const { runId } = await this.runsService.enqueue({
        source: 'flow',
        parentFlowRunId: ctx.run.flowRunId,
        repo: agentConfig.target,
        prompt: renderedPrompt,
      });

      // Register the waiter BEFORE saving to avoid a race where the run
      // completes before waitFor() is called and the notification is dropped.
      const completionPromise = this.flowRunCompletionListener.waitFor(
        runId,
        FLOW_STEP_TIMEOUT_MS,
      );

      step.runId = runId;
      await this.flowRunRepository.save(ctx.run);

      const result = await completionPromise;

      step.completedAt = new Date();

      if (result.status === 'succeeded') {
        step.success = true;
        await this.flowRunRepository.save(ctx.run);
        return true;
      }

      step.success = false;
      const suffix = result.errorMessage ? ': ' + result.errorMessage : '';
      const msg = `Agent "${agentName}" run ${runId} ended with status "${result.status}"${suffix}`;
      this.logger.error(`Flow run ${ctx.run.flowRunId}: ${msg}`);
      await this.completeRun(ctx, 'errored', msg);
      return false;
    } catch (error) {
      step.completedAt = new Date();
      step.success = false;
      const msg = `Dispatch failed for agent "${agentName}": ${error instanceof Error ? error.message : String(error)}`;
      this.logger.error(`Flow run ${ctx.run.flowRunId}: ${msg}`);
      await this.completeRun(ctx, 'errored', msg);
      return false;
    }
  }

  private async completeRun(
    ctx: LoopContext,
    status: FlowRunStatus,
    message?: string,
  ): Promise<void> {
    this.logger.log(`Flow run ${ctx.run.flowRunId} → ${status}`);
    ctx.run.status = status;
    ctx.run.message = message;
    ctx.run.completedAt = new Date();
    await this.flowRunRepository.save(ctx.run);
  }
}
