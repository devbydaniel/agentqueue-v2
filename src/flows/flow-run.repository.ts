import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PgClient, PgPool } from '../database/database.tokens.js';
import { PG_POOL } from '../database/database.tokens.js';
import { mapRows } from '../database/query-helpers.js';
import type { FlowRunRow } from '../database/flow-runs.schema.js';
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

  constructor(@Inject(PG_POOL) private readonly pool: PgPool) {}

  async create(
    flowName: string,
    vars: Record<string, string>,
  ): Promise<FlowRun> {
    const flowRunId = randomUUID();

    const result = await this.pool.query(
      `INSERT INTO flow_runs (flow_run_id, flow_name, status, vars)
      VALUES ($1, $2, 'running', $3)
      RETURNING *`,
      [flowRunId, flowName, vars],
    );
    const row = mapRows<FlowRunRow>(
      result.rows as Record<string, unknown>[],
    )[0];

    this.logger.log(`Created flow run ${flowRunId} for flow "${flowName}"`);
    return rowToFlowRun(row, []);
  }

  async findById(flowRunId: string): Promise<FlowRun | null> {
    const runResult = await this.pool.query(
      'SELECT * FROM flow_runs WHERE flow_run_id = $1',
      [flowRunId],
    );
    if (runResult.rowCount === 0) return null;

    const stepResult = await this.pool.query(
      `SELECT * FROM flow_steps
      WHERE flow_run_id = $1
      ORDER BY step_index ASC`,
      [flowRunId],
    );

    const rows = mapRows<FlowRunRow>(runResult.rows as Record<string, unknown>[]);
    const stepRows = mapRows<FlowStepRow>(
      stepResult.rows as Record<string, unknown>[],
    );

    return rowToFlowRun(rows[0], stepRows);
  }

  async findByFlowName(flowName: string): Promise<FlowRun[]> {
    const runResult = await this.pool.query(
      'SELECT * FROM flow_runs WHERE flow_name = $1',
      [flowName],
    );
    const runRows = mapRows<FlowRunRow>(
      runResult.rows as Record<string, unknown>[],
    );
    if (runRows.length === 0) return [];

    const runIds = runRows.map((r) => r.flowRunId);
    const placeholders = runIds.map((_, index) => `$${index + 1}`).join(', ');
    const stepResult = await this.pool.query(
      `SELECT * FROM flow_steps
      WHERE flow_run_id IN (${placeholders})
      ORDER BY step_index ASC`,
      runIds,
    );
    const allStepRows = mapRows<FlowStepRow>(
      stepResult.rows as Record<string, unknown>[],
    );

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
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.upsertFlowRun(client, run);
      await this.replaceSteps(client, run);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async upsertFlowRun(tx: PgClient, run: FlowRun): Promise<void> {
    await tx.query(
      `INSERT INTO flow_runs (
        flow_run_id,
        flow_name,
        status,
        vars,
        current_agent,
        message,
        started_at,
        completed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (flow_run_id) DO UPDATE SET
        status = EXCLUDED.status,
        vars = EXCLUDED.vars,
        current_agent = EXCLUDED.current_agent,
        message = EXCLUDED.message,
        started_at = EXCLUDED.started_at,
        completed_at = EXCLUDED.completed_at`,
      [
        run.flowRunId,
        run.flowName,
        run.status,
        run.vars,
        run.currentAgent ?? null,
        run.message ?? null,
        run.startedAt,
        run.completedAt ?? null,
      ],
    );
  }

  private async replaceSteps(tx: PgClient, run: FlowRun): Promise<void> {
    await tx.query('DELETE FROM flow_steps WHERE flow_run_id = $1', [
      run.flowRunId,
    ]);

    if (run.steps.length > 0) {
      for (const [index, step] of run.steps.entries()) {
        await tx.query(
          `INSERT INTO flow_steps (
            flow_run_id,
            step_index,
            agent,
            vars,
            started_at,
            completed_at,
            success,
            run_id
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            run.flowRunId,
            index,
            step.agent,
            step.vars,
            step.startedAt,
            step.completedAt ?? null,
            step.success ?? null,
            step.runId ?? null,
          ],
        );
      }
    }
  }

  async markRunningAsInterrupted(): Promise<{ flowRunId: string }[]> {
    const result = await this.pool.query(
      `UPDATE flow_runs
      SET
        status = 'interrupted',
        message = 'Process restarted while flow was in progress',
        completed_at = $1
      WHERE status = 'running'
      RETURNING flow_run_id AS "flowRunId"`,
      [new Date()],
    );

    return result.rows as { flowRunId: string }[];
  }
}
