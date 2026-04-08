import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BOSS } from '../queue/queue.tokens.js';
import type { Boss } from '../queue/queue.tokens.js';
import { RunProcessorService } from './run-processor.service.js';
import { RunRepository } from './run.repository.js';
import type { CreateRunCommand, ListRunsFilters } from './run.repository.js';
import { RunEventRepository } from './run-event.repository.js';
import type { RunEventPagination } from './run-event.repository.js';
import type { Run } from '../database/runs.schema.js';
import type { RunEvent } from '../database/run-events.schema.js';
import { RUNS_QUEUE_NAME } from './runs.constants.js';

export interface EnqueueRunCommand {
  source: 'manual' | 'cron' | 'linear' | 'github' | 'flow';
  triggerName?: string;
  parentFlowRunId?: string;
  repo: string;
  prompt: string;
  externalSessionId?: string;
  prependSystemPrompt?: string;
  appendSystemPrompt?: string;
  timeoutMs?: number;
}

export interface EnqueueRunResult {
  runId: string;
  status: 'waiting';
}

const TERMINAL_STATUSES = new Set([
  'succeeded',
  'errored',
  'aborted',
  'timed_out',
  'interrupted',
]);

@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);

  constructor(
    private readonly runProcessorService: RunProcessorService,
    private readonly runRepository: RunRepository,
    private readonly runEventRepository: RunEventRepository,
    @Inject(BOSS) private readonly boss: Boss,
  ) {}

  /**
   * Abort a tracked session by its external session ID (e.g. Linear agentSessionId).
   * Returns true if the session was found and aborted.
   */
  async abortSession(externalSessionId: string): Promise<boolean> {
    return this.runProcessorService.abortSession(externalSessionId);
  }

  async enqueue(command: EnqueueRunCommand): Promise<EnqueueRunResult> {
    this.logger.log('Enqueueing run', {
      repo: command.repo,
      source: command.source,
    });

    const createCommand: CreateRunCommand = {
      source: command.source,
      triggerName: command.triggerName,
      parentFlowRunId: command.parentFlowRunId,
      repo: command.repo,
      prompt: command.prompt,
      externalSessionId: command.externalSessionId,
      prependSystemPrompt: command.prependSystemPrompt,
      appendSystemPrompt: command.appendSystemPrompt,
      timeoutMs: command.timeoutMs,
    };

    const run = await this.runRepository.create(createCommand);

    let jobId: string | null;
    try {
      jobId = await this.boss.send(RUNS_QUEUE_NAME, { runId: run.id });
    } catch (error) {
      run.status = 'errored';
      run.errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      run.completedAt = new Date();
      await this.runRepository.save(run);
      throw error;
    }

    if (jobId) {
      await this.runRepository.markWaitingQueueJob(run.id, jobId);
    }

    this.logger.log('Run enqueued', {
      runId: run.id,
      queueJobId: jobId,
    });

    return { runId: run.id, status: 'waiting' };
  }

  async getRun(id: string): Promise<Run> {
    const run = await this.runRepository.findById(id);
    if (!run) {
      throw new NotFoundException(`Run "${id}" not found`);
    }
    return run;
  }

  async listRuns(filters: ListRunsFilters): Promise<Run[]> {
    return this.runRepository.findMany(filters);
  }

  async listRunEvents(
    runId: string,
    pagination?: RunEventPagination,
  ): Promise<RunEvent[]> {
    // Verify the run exists first
    const run = await this.runRepository.findById(runId);
    if (!run) {
      throw new NotFoundException(`Run "${runId}" not found`);
    }
    return this.runEventRepository.findByRunId(runId, pagination);
  }

  async abortRun(runId: string): Promise<{ aborted: boolean }> {
    const run = await this.runRepository.findById(runId);
    if (!run) {
      throw new NotFoundException(`Run "${runId}" not found`);
    }

    if (TERMINAL_STATUSES.has(run.status)) {
      throw new ConflictException(
        `Run "${runId}" is already in terminal status "${run.status}"`,
      );
    }

    if (run.status === 'running') {
      const aborted = await this.runProcessorService.abortByRunId(runId);
      if (aborted) {
        run.status = 'aborted';
        run.completedAt = new Date();
        await this.runRepository.save(run);
      }
      return { aborted };
    }

    if (run.status === 'waiting') {
      // Cancel the pg-boss job if it exists
      if (run.queueJobId) {
        await this.boss.cancel(RUNS_QUEUE_NAME, run.queueJobId);
      }
      run.status = 'aborted';
      run.completedAt = new Date();
      await this.runRepository.save(run);
      return { aborted: true };
    }

    return { aborted: false };
  }
}
