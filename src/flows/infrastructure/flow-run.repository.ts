/* eslint-disable @typescript-eslint/require-await -- in-memory implementation; bodies will use await when backed by a real database */
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

/**
 * Persists flow run state. Currently in-memory; the API is async so the
 * eventual database-backed implementation can drop in without changing callers.
 */
@Injectable()
export class FlowRunRepository {
  private readonly logger = new Logger(FlowRunRepository.name);
  private readonly runs = new Map<string, FlowRun>();

  async create(
    flowName: string,
    vars: Record<string, string>,
  ): Promise<FlowRun> {
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

  async findById(flowRunId: string): Promise<FlowRun | null> {
    return this.runs.get(flowRunId) ?? null;
  }

  async findByFlowName(flowName: string): Promise<FlowRun[]> {
    return [...this.runs.values()].filter((r) => r.flowName === flowName);
  }

  async update(flowRunId: string, partial: Partial<FlowRun>): Promise<void> {
    const run = this.runs.get(flowRunId);
    if (!run) return;
    Object.assign(run, partial);
  }

  async addStep(flowRunId: string, step: FlowStepRecord): Promise<void> {
    const run = this.runs.get(flowRunId);
    if (!run) return;
    run.steps.push(step);
  }

  async completeStep(flowRunId: string, success: boolean): Promise<void> {
    const run = this.runs.get(flowRunId);
    if (!run || run.steps.length === 0) return;
    const lastStep = run.steps[run.steps.length - 1];
    lastStep.completedAt = new Date();
    lastStep.success = success;
  }
}
