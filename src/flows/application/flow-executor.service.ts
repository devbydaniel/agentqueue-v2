import { Injectable, Logger } from '@nestjs/common';
import * as path from 'node:path';
import { FlowConfigService } from '../flow-config.service.js';
import { FlowRegistryService } from '../flow-registry.service.js';
import type { FlowConfig } from '../flow-config.interface.js';
import { AgentfilesConfigService } from '../../config/agentfiles-config.service.js';
import { ExecuteRunUseCase } from '../../runs/application/execute-run.use-case.js';
import { interpolateTemplate } from '../../common/utils/interpolate-template.js';

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

@Injectable()
export class FlowExecutorService {
  private readonly logger = new Logger(FlowExecutorService.name);

  constructor(
    private readonly flowConfigService: FlowConfigService,
    private readonly flowRegistry: FlowRegistryService,
    private readonly agentfilesConfigService: AgentfilesConfigService,
    private readonly executeRunUseCase: ExecuteRunUseCase,
  ) {}

  start(flowName: string, vars: Record<string, string>): string {
    const run = this.flowRegistry.create(flowName, vars);
    this.logger.log(`Starting flow "${flowName}" → run ${run.flowRunId}`);

    void this.runLoop(run.flowRunId).catch((error: unknown) => {
      this.logger.error(
        `Flow run ${run.flowRunId} loop failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    return run.flowRunId;
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

  private async runLoop(flowRunId: string): Promise<void> {
    const run = this.flowRegistry.get(flowRunId);
    if (!run) return;

    const ctx = await this.initializeLoop(flowRunId, run.flowName, run.vars);
    if (!ctx) return;

    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional resolver loop; exits via return on done/escalate/error/abort
      while (true) {
        if (ctx.abortController.signal.aborted) {
          this.completeRun(flowRunId, 'aborted');
          return;
        }

        const result = await ctx.resolve(ctx.flowDir, { ...ctx.vars });
        const shouldContinue = await this.handleResult(ctx, result);
        if (!shouldContinue) return;
      }
    } catch (error) {
      this.errorRun(flowRunId, error);
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
      this.flowRegistry.trackAbortController(flowRunId, abortController);

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
      this.errorRun(flowRunId, error);
      return null;
    }
  }

  /** Returns true to continue the loop, false to stop. */
  private async handleResult(
    ctx: LoopContext,
    result: ResolverResult,
  ): Promise<boolean> {
    if ('done' in result) {
      this.completeRun(ctx.flowRunId, 'done', result.summary);
      return false;
    }

    if ('escalate' in result) {
      this.completeRun(ctx.flowRunId, 'escalated', result.escalate);
      return false;
    }

    if (!('agent' in result)) {
      this.completeRun(
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
      this.completeRun(
        ctx.flowRunId,
        'errored',
        `Resolver returned unknown agent "${agentName}"`,
      );
      return false;
    }

    Object.assign(ctx.vars, stepVars);
    const renderedPrompt = interpolateTemplate(agentConfig.prompt, ctx.vars);

    this.flowRegistry.addStep(ctx.flowRunId, {
      agent: agentName,
      vars: { ...stepVars },
      startedAt: new Date(),
    });
    this.flowRegistry.update(ctx.flowRunId, {
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
      this.flowRegistry.completeStep(ctx.flowRunId, true);
      return true;
    } catch (error) {
      this.flowRegistry.completeStep(ctx.flowRunId, false);
      const msg = `Dispatch failed for agent "${agentName}": ${error instanceof Error ? error.message : String(error)}`;
      this.logger.error(`Flow run ${ctx.flowRunId}: ${msg}`);
      this.completeRun(ctx.flowRunId, 'errored', msg);
      return false;
    }
  }

  private completeRun(
    flowRunId: string,
    status: 'done' | 'escalated' | 'errored' | 'aborted',
    message?: string,
  ): void {
    this.logger.log(`Flow run ${flowRunId} → ${status}`);
    this.flowRegistry.update(flowRunId, {
      status,
      message,
      completedAt: new Date(),
    });
  }

  private errorRun(flowRunId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`Flow run ${flowRunId} errored: ${message}`);
    this.flowRegistry.update(flowRunId, {
      status: 'errored',
      message,
      completedAt: new Date(),
    });
  }
}
