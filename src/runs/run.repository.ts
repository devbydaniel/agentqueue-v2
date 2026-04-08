import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.tokens.js';
import { DRIZZLE } from '../database/database.tokens.js';
import { runs, runSourceEnum } from '../database/runs.schema.js';
import type { Run, NewRun } from '../database/runs.schema.js';

export interface CreateRunCommand {
  source: (typeof runSourceEnum.enumValues)[number];
  triggerName?: string;
  parentFlowRunId?: string;
  repo: string;
  prompt: string;
  sessionKey?: string;
  prependSystemPrompt?: string;
  appendSystemPrompt?: string;
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
      sessionKey: command.sessionKey,
      prependSystemPrompt: command.prependSystemPrompt,
      appendSystemPrompt: command.appendSystemPrompt,
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
        queueJobId: run.queueJobId,
        updatedAt: new Date(),
      })
      .where(eq(runs.id, run.id))
      .returning({ id: runs.id });

    if (result.length === 0) {
      throw new NotFoundException(`Run "${run.id}" not found`);
    }
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
