import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PgPool } from '../database/database.tokens.js';
import { PG_POOL } from '../database/database.tokens.js';
import { mapRow } from '../database/query-helpers.js';
import {
  runSources,
  runStatuses,
  type Run,
  type NewRun,
} from '../database/runs.schema.js';

export interface ListRunsFilters {
  status?: string;
  source?: string;
  cwd?: string;
  trigger?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

export interface CreateRunCommand {
  source: (typeof runSources)[number];
  triggerName?: string;
  parentFlowRunId?: string;
  cwd: string;
  prompt: string;
  externalSessionId?: string;
  appendSystemPrompt?: string;
  timeoutMs?: number;
}

function mapRunRow(row: Record<string, unknown>): Run {
  const mapped = mapRow<Record<string, unknown>>(row);
  return {
    ...(mapped as Omit<Run, 'externalSessionId'>),
    externalSessionId: (row['external_session_id'] as string | null) ?? null,
  };
}

@Injectable()
export class RunRepository {
  private readonly logger = new Logger(RunRepository.name);

  constructor(@Inject(PG_POOL) private readonly pool: PgPool) {}

  async create(command: CreateRunCommand): Promise<Run> {
    const newRun: NewRun = {
      source: command.source,
      triggerName: command.triggerName,
      parentFlowRunId: command.parentFlowRunId,
      cwd: command.cwd,
      prompt: command.prompt,
      promptPreview: command.prompt.slice(0, 500),
      externalSessionId: command.externalSessionId,
      appendSystemPrompt: command.appendSystemPrompt,
      timeoutMs: command.timeoutMs,
    };
    const result = await this.pool.query(
      `INSERT INTO runs (
        source,
        trigger_name,
        parent_flow_run_id,
        cwd,
        prompt,
        prompt_preview,
        external_session_id,
        append_system_prompt,
        timeout_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
      [
        newRun.source,
        newRun.triggerName ?? null,
        newRun.parentFlowRunId ?? null,
        newRun.cwd,
        newRun.prompt,
        newRun.promptPreview ?? null,
        newRun.externalSessionId ?? null,
        newRun.appendSystemPrompt ?? null,
        newRun.timeoutMs ?? null,
      ],
    );
    const row = mapRunRow(result.rows[0] as Record<string, unknown>);
    this.logger.debug('Created run', { id: row.id, source: row.source });
    return row;
  }

  async findById(id: string): Promise<Run | null> {
    const result = await this.pool.query('SELECT * FROM runs WHERE id = $1', [
      id,
    ]);
    return result.rows[0]
      ? mapRunRow(result.rows[0] as Record<string, unknown>)
      : null;
  }

  async save(run: Run): Promise<void> {
    const result = await this.pool.query(
      `UPDATE runs
      SET
        status = $2,
        attempts_made = $3,
        started_at = $4,
        completed_at = $5,
        error_message = $6,
        timeout_ms = $7,
        queue_job_id = $8,
        updated_at = $9
      WHERE id = $1
      RETURNING id`,
      [
        run.id,
        run.status,
        run.attemptsMade,
        run.startedAt,
        run.completedAt,
        run.errorMessage,
        run.timeoutMs,
        run.queueJobId,
        new Date(),
      ],
    );

    if (result.rowCount === 0) {
      throw new NotFoundException(`Run "${run.id}" not found`);
    }
  }

  async findMany(filters: ListRunsFilters = {}): Promise<Run[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let index = 1;

    if (filters.status) {
      conditions.push(`status = $${index++}`);
      values.push(filters.status as (typeof runStatuses)[number]);
    }
    if (filters.source) {
      conditions.push(`source = $${index++}`);
      values.push(filters.source as (typeof runSources)[number]);
    }
    if (filters.cwd) {
      conditions.push(`cwd = $${index++}`);
      values.push(filters.cwd);
    }
    if (filters.trigger) {
      conditions.push(`trigger_name = $${index++}`);
      values.push(filters.trigger);
    }
    if (filters.since) {
      conditions.push(`created_at >= $${index++}`);
      values.push(new Date(filters.since));
    }

    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = filters.offset ?? 0;
    values.push(limit, offset);

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT * FROM runs
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${index++}
      OFFSET $${index}`,
      values,
    );

    return (result.rows as Record<string, unknown>[]).map((row) =>
      mapRunRow(row),
    );
  }

  async markRunningAsInterrupted(): Promise<{ id: string }[]> {
    const result = await this.pool.query(
      `UPDATE runs
      SET
        status = 'interrupted',
        error_message = 'Process restarted while run was in progress',
        completed_at = $1,
        updated_at = $1
      WHERE status = 'running'
      RETURNING id`,
      [new Date()],
    );

    return result.rows as { id: string }[];
  }

  async markWaitingQueueJob(runId: string, queueJobId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE runs
      SET queue_job_id = $2, updated_at = $3
      WHERE id = $1
      RETURNING id`,
      [runId, queueJobId, new Date()],
    );

    if (result.rowCount === 0) {
      throw new NotFoundException(`Run "${runId}" not found`);
    }
  }
}
