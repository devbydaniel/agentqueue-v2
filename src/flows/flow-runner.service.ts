import { Injectable, Logger } from '@nestjs/common';
import * as path from 'node:path';
import { FlowConfigService } from './flow-config.service.js';
import { FlowRunRepository } from './infrastructure/flow-run.repository.js';
import { FlowAbortTrackerService } from './flow-abort-tracker.service.js';
import type { FlowConfig } from './flow-config.interface.js';
import { ExecuteRunUseCase } from '../runs/application/execute-run.use-case.js';
import { interpolateTemplate } from '../common/utils/interpolate-template.js';

export type ResolverResult =
  | { agent: string; vars: Record<string, string> }
  | { done: true; summary?: string }
  | { escalate: string };

export type Resolver = (
  flowDir: string,
  vars: Record<string, string>,
) => ResolverResult | Promise<ResolverResult>;

interface LoopContext {
  flowRunId: string;
  config: FlowConfig;
  flowDir: string;
  resolve: Resolver;
  abortController: AbortController;
  vars: Record<string, string>;
}

/**
 * Lifecycle service that owns in-process flow run loops.
 *
 * The flow run row is created by the caller (typically `StartFlowUseCase`);
 * this service receives the `flowRunId` and runs the resolver loop in the
 * background, dispatching agent steps via `ExecuteRunUseCase` and recording
 * progress in the repository. Abort signals come in via `FlowAbortTrackerService`.
 *
 * Categorized as a lifecycle / runtime service (not a use case) because it
 * owns long-running loop state and an in-memory `AbortController`. Use cases
 * delegate to it for the runtime mechanics.
 */
@Injectable()
export class FlowRunnerService {
  private readonly logger = new Logger(FlowRunnerService.name);

  constructor(
    private readonly flowConfigService: FlowConfigService,
    private readonly flowRunRepository: FlowRunRepository,
    private readonly flowAbortTracker: FlowAbortTrackerService,
    private readonly executeRunUseCase: ExecuteRunUseCase,
  ) {}

  /**
   * Kick off a flow run loop in the background. Returns immediately.
   * Caller is responsible for having created the flow run row first.
   */
  run(flowRunId: string, flowName: string, vars: Record<string, string>): void {
    this.logger.log(`Starting flow "${flowName}" → run ${flowRunId}`);

    void this.runLoop(flowRunId, flowName, vars).catch((error: unknown) => {
      this.logger.error(
        `Flow run ${flowRunId} loop failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /** @visibleForTesting — override in tests to inject a mock resolver */
  protected async loadResolver(
    resolverPath: string,
  ): Promise<{ resolve: Resolver }> {
    // Register tsx loader for TypeScript resolvers
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- tsx CJS registration must use require()
    require('tsx/cjs/api');
    const mod = (await import(resolverPath)) as { resolve: Resolver };
    return mod;
  }

  private async runLoop(
    flowRunId: string,
    flowName: string,
    vars: Record<string, string>,
  ): Promise<void> {
    const ctx = await this.initializeLoop(flowRunId, flowName, vars);
    if (!ctx) return;

    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional resolver loop; exits via return on done/escalate/error/abort
      while (true) {
        if (ctx.abortController.signal.aborted) {
          await this.completeRun(flowRunId, 'aborted');
          return;
        }

        const result = await ctx.resolve(ctx.flowDir, { ...ctx.vars });
        const shouldContinue = await this.handleResult(ctx, result);
        if (!shouldContinue) return;
      }
    } catch (error) {
      await this.errorRun(flowRunId, error);
    }
  }

  private async initializeLoop(
    flowRunId: string,
    flowName: string,
    vars: Record<string, string>,
  ): Promise<LoopContext | null> {
    try {
      const config = this.flowConfigService.loadFlow(flowName);
      const flowDir = this.flowConfigService.getFlowDir(flowName);
      const resolverPath = path.resolve(flowDir, config.resolver);
      const mod = await this.loadResolver(resolverPath);

      if (typeof mod.resolve !== 'function') {
        throw new Error(
          `Resolver module at "${resolverPath}" does not export a "resolve" function`,
        );
      }

      const abortController = new AbortController();
      this.flowAbortTracker.track(flowRunId, abortController);

      return {
        flowRunId,
        config,
        flowDir,
        resolve: mod.resolve,
        abortController,
        vars: { ...vars },
      };
    } catch (error) {
      this.logger.error(
        `Flow run ${flowRunId} failed to initialize: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.errorRun(flowRunId, error);
      return null;
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
      await this.executeRunUseCase.execute({
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
