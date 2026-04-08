import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.tokens.js';
import { DRIZZLE } from '../database/database.tokens.js';
import { runs, runSourceEnum, runStatusEnum } from '../database/runs.schema.js';
import type { Run, NewRun } from '../database/runs.schema.js';

export interface ListRunsFilters {
  status?: string;
  source?: string;
  repo?: string;
  trigger?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

export interface CreateRunCommand {
  source: (typeof runSourceEnum.enumValues)[number];
  triggerName?: string;
  parentFlowRunId?: string;
  repo: string;
  prompt: string;
  externalSessionId?: string;
  prependSystemPrompt?: string;
  appendSystemPrompt?: string;
  timeoutMs?: number;
}

@Injectable()
export class RunRepository {
  private readonly logger = new Logger(RunRepository.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async create(command: CreateRunCommand): Promise<Run> {
    const newRun: NewRun = {
      source: command.source,
      triggerName: command.triggerName,
      parentFlowRunId: command.parentFlowRunId,
      repo: command.repo,
      prompt: command.prompt,
      promptPreview: command.prompt.slice(0, 500),
      externalSessionId: command.externalSessionId,
      prependSystemPrompt: command.prependSystemPrompt,
      appendSystemPrompt: command.appendSystemPrompt,
      timeoutMs: command.timeoutMs,
    };

    const [row] = await this.db.insert(runs).values(newRun).returning();
    this.logger.debug('Created run', { id: row.id, source: row.source });
    return row;
  }

  async findById(id: string): Promise<Run | null> {
    const rows = await this.db
      .select()
      .from(runs)
      .where(eq(runs.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async save(run: Run): Promise<void> {
    const result = await this.db
      .update(runs)
      .set({
        status: run.status,
        attemptsMade: run.attemptsMade,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        errorMessage: run.errorMessage,
        timeoutMs: run.timeoutMs,
        queueJobId: run.queueJobId,
        updatedAt: new Date(),
      })
      .where(eq(runs.id, run.id))
      .returning({ id: runs.id });

    if (result.length === 0) {
      throw new NotFoundException(`Run "${run.id}" not found`);
    }
  }

  async findMany(filters: ListRunsFilters = {}): Promise<Run[]> {
    const conditions: SQL[] = [];

    if (filters.status) {
      conditions.push(
        eq(
          runs.status,
          filters.status as (typeof runStatusEnum.enumValues)[number],
        ),
      );
    }
    if (filters.source) {
      conditions.push(
        eq(
          runs.source,
          filters.source as (typeof runSourceEnum.enumValues)[number],
        ),
      );
    }
    if (filters.repo) {
      conditions.push(eq(runs.repo, filters.repo));
    }
    if (filters.trigger) {
      conditions.push(eq(runs.triggerName, filters.trigger));
    }
    if (filters.since) {
      conditions.push(gte(runs.createdAt, new Date(filters.since)));
    }

    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = filters.offset ?? 0;

    return this.db
      .select()
      .from(runs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(runs.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async markRunningAsInterrupted(): Promise<{ id: string }[]> {
    return this.db
      .update(runs)
      .set({
        status: 'interrupted',
        errorMessage: 'Process restarted while run was in progress',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(runs.status, 'running'))
      .returning({ id: runs.id });
  }

  async markWaitingQueueJob(runId: string, queueJobId: string): Promise<void> {
    const result = await this.db
      .update(runs)
      .set({ queueJobId, updatedAt: new Date() })
      .where(eq(runs.id, runId))
      .returning({ id: runs.id });

    if (result.length === 0) {
      throw new NotFoundException(`Run "${runId}" not found`);
    }
  }
}
