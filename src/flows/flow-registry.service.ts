import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export type FlowRunStatus =
  | 'running'
  | 'done'
  | 'escalated'
  | 'errored'
  | 'aborted';

export interface FlowStepRecord {
  agent: string;
  vars: Record<string, string>;
  startedAt: Date;
  completedAt?: Date;
  success?: boolean;
}

export interface FlowRun {
  flowRunId: string;
  flowName: string;
  status: FlowRunStatus;
  vars: Record<string, string>;
  currentAgent?: string;
  steps: FlowStepRecord[];
  startedAt: Date;
  completedAt?: Date;
  message?: string;
}

@Injectable()
export class FlowRegistryService {
  private readonly logger = new Logger(FlowRegistryService.name);
  private readonly runs = new Map<string, FlowRun>();
  private readonly abortControllers = new Map<string, AbortController>();

  create(flowName: string, vars: Record<string, string>): FlowRun {
    const flowRunId = randomUUID();
    const run: FlowRun = {
      flowRunId,
      flowName,
      status: 'running',
      vars: { ...vars },
      steps: [],
      startedAt: new Date(),
    };
    this.runs.set(flowRunId, run);
    this.logger.log(`Created flow run ${flowRunId} for flow "${flowName}"`);
    return run;
  }

  get(flowRunId: string): FlowRun | undefined {
    return this.runs.get(flowRunId);
  }

  listByFlow(flowName: string): FlowRun[] {
    return [...this.runs.values()].filter((r) => r.flowName === flowName);
  }

  update(flowRunId: string, partial: Partial<FlowRun>): void {
    const run = this.runs.get(flowRunId);
    if (!run) return;
    Object.assign(run, partial);
  }

  addStep(flowRunId: string, step: FlowStepRecord): void {
    const run = this.runs.get(flowRunId);
    if (!run) return;
    run.steps.push(step);
  }

  completeStep(flowRunId: string, success: boolean): void {
    const run = this.runs.get(flowRunId);
    if (!run || run.steps.length === 0) return;
    const lastStep = run.steps[run.steps.length - 1];
    lastStep.completedAt = new Date();
    lastStep.success = success;
  }

  trackAbortController(flowRunId: string, controller: AbortController): void {
    this.abortControllers.set(flowRunId, controller);
  }

  abort(flowRunId: string): boolean {
    const controller = this.abortControllers.get(flowRunId);
    if (!controller) {
      this.logger.warn(`No abort controller found for flow run ${flowRunId}`);
      return false;
    }
    this.logger.log(`Aborting flow run ${flowRunId}`);
    controller.abort();
    this.abortControllers.delete(flowRunId);
    return true;
  }
}
