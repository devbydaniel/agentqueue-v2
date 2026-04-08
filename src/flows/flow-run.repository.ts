import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, asc, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DrizzleDb } from '../database/database.tokens.js';
import { DRIZZLE } from '../database/database.tokens.js';
import { flowRuns } from '../database/flow-runs.schema.js';
import type { FlowRunRow } from '../database/flow-runs.schema.js';
import { flowSteps } from '../database/flow-steps.schema.js';
import type { FlowStepRow } from '../database/flow-steps.schema.js';

export type FlowRunStatus =
  | 'running'
  | 'done'
  | 'escalated'
  | 'errored'
  | 'aborted'
  | 'interrupted';

export interface FlowStepRecord {
  agent: string;
  vars: Record<string, string>;
  startedAt: Date;
  completedAt?: Date;
  success?: boolean;
  runId?: string;
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

// ── Mapping helpers ────────────────────────────────────────────────────

function rowToFlowRun(row: FlowRunRow, stepRows: FlowStepRow[]): FlowRun {
  return {
    flowRunId: row.flowRunId,
    flowName: row.flowName,
    status: row.status as FlowRunStatus,
    vars: row.vars,
    currentAgent: row.currentAgent ?? undefined,
    steps: stepRows
      .toSorted((a, b) => a.stepIndex - b.stepIndex)
      .map((s) => ({
        agent: s.agent,
        vars: s.vars,
        startedAt: s.startedAt,
        completedAt: s.completedAt ?? undefined,
        success: s.success ?? undefined,
        runId: s.runId ?? undefined,
      })),
    startedAt: row.startedAt,
    completedAt: row.completedAt ?? undefined,
    message: row.message ?? undefined,
  };
}

/**
 * Persists flow run state in Postgres via Drizzle.
 *
 * The mutation surface is intentionally minimal: callers load the run via
 * `findById` (or receive it from `create`), mutate the object directly, then
 * persist with `save`.
 */
@Injectable()
export class FlowRunRepository {
  private readonly logger = new Logger(FlowRunRepository.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async create(
    flowName: string,
    vars: Record<string, string>,
  ): Promise<FlowRun> {
    const flowRunId = randomUUID();

    const [row] = await this.db
      .insert(flowRuns)
      .values({
        flowRunId,
        flowName,
        status: 'running',
        vars,
      })
      .returning();

    this.logger.log(`Created flow run ${flowRunId} for flow "${flowName}"`);
    return rowToFlowRun(row, []);
  }

  async findById(flowRunId: string): Promise<FlowRun | null> {
    const rows = await this.db
      .select()
      .from(flowRuns)
      .where(eq(flowRuns.flowRunId, flowRunId))
      .limit(1);

    if (rows.length === 0) return null;

    const stepRows = await this.db
      .select()
      .from(flowSteps)
      .where(eq(flowSteps.flowRunId, flowRunId))
      .orderBy(asc(flowSteps.stepIndex));

    return rowToFlowRun(rows[0], stepRows);
  }

  async findByFlowName(flowName: string): Promise<FlowRun[]> {
    const runRows = await this.db
      .select()
      .from(flowRuns)
      .where(eq(flowRuns.flowName, flowName));

    if (runRows.length === 0) return [];

    const runIds = runRows.map((r) => r.flowRunId);

    // Fetch all steps for the matching runs in one query
    const allStepRows = await this.db
      .select()
      .from(flowSteps)
      .where(inArray(flowSteps.flowRunId, runIds))
      .orderBy(asc(flowSteps.stepIndex));

    // Group steps by flowRunId
    const stepsByRunId = new Map<string, FlowStepRow[]>();
    for (const step of allStepRows) {
      const list = stepsByRunId.get(step.flowRunId) ?? [];
      list.push(step);
      stepsByRunId.set(step.flowRunId, list);
    }

    return runRows.map((runRow) =>
      rowToFlowRun(runRow, stepsByRunId.get(runRow.flowRunId) ?? []),
    );
  }

  async save(run: FlowRun): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.upsertFlowRun(tx, run);
      await this.replaceSteps(tx, run);
    });
  }

  private async upsertFlowRun(tx: DrizzleDb, run: FlowRun): Promise<void> {
    await tx
      .insert(flowRuns)
      .values({
        flowRunId: run.flowRunId,
        flowName: run.flowName,
        status: run.status,
        vars: run.vars,
        currentAgent: run.currentAgent ?? null,
        message: run.message ?? null,
        startedAt: run.startedAt,
        completedAt: run.completedAt ?? null,
      })
      .onConflictDoUpdate({
        target: flowRuns.flowRunId,
        set: {
          status: run.status,
          vars: run.vars,
          currentAgent: run.currentAgent ?? null,
          message: run.message ?? null,
          startedAt: run.startedAt,
          completedAt: run.completedAt ?? null,
        },
      });
  }

  private async replaceSteps(tx: DrizzleDb, run: FlowRun): Promise<void> {
    await tx.delete(flowSteps).where(eq(flowSteps.flowRunId, run.flowRunId));

    if (run.steps.length > 0) {
      await tx.insert(flowSteps).values(
        run.steps.map((step, index) => ({
          flowRunId: run.flowRunId,
          stepIndex: index,
          agent: step.agent,
          vars: step.vars,
          startedAt: step.startedAt,
          completedAt: step.completedAt ?? null,
          success: step.success ?? null,
          runId: step.runId ?? null,
        })),
      );
    }
  }

  async markRunningAsInterrupted(): Promise<{ flowRunId: string }[]> {
    return this.db
      .update(flowRuns)
      .set({
        status: 'interrupted',
        message: 'Process restarted while flow was in progress',
        completedAt: new Date(),
      })
      .where(eq(flowRuns.status, 'running'))
      .returning({ flowRunId: flowRuns.flowRunId });
  }
}
