import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CallbackHandler } from '../callbacks/callback-handler.interface.js';
import { BOSS } from '../queue/queue.tokens.js';
import type { Boss } from '../queue/queue.tokens.js';
import { RunProcessorService } from './run-processor.service.js';
import { RunRepository } from './run.repository.js';
import type { CreateRunCommand } from './run.repository.js';
import { RUNS_QUEUE_NAME } from './runs.constants.js';

export interface ExecuteRunCommand {
  repo: string;
  prompt: string;
  additionalHandlers?: CallbackHandler[];
  /** Optional key to track the session for later cancellation (e.g. Linear agentSessionId) */
  sessionKey?: string;
  /** System prompt snippet to prepend before the base system prompt */
  prependSystemPrompt?: string;
  /** System prompt snippet to append after the base system prompt */
  appendSystemPrompt?: string;
}

export interface ExecuteRunResult {
  success: boolean;
}

export interface EnqueueRunCommand {
  source: 'manual' | 'cron' | 'linear' | 'github' | 'flow';
  triggerName?: string;
  parentFlowRunId?: string;
  repo: string;
  prompt: string;
  sessionKey?: string;
  prependSystemPrompt?: string;
  appendSystemPrompt?: string;
}

export interface EnqueueRunResult {
  runId: string;
  status: 'waiting';
}

@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);

  constructor(
    private readonly runProcessorService: RunProcessorService,
    private readonly runRepository: RunRepository,
    @Inject(BOSS) private readonly boss: Boss,
  ) {}

  /**
   * Abort a tracked session by its key (e.g. Linear agentSessionId).
   * Returns true if the session was found and aborted.
   */
  async abortSession(sessionKey: string): Promise<boolean> {
    return this.runProcessorService.abortSession(sessionKey);
  }

  async execute(command: ExecuteRunCommand): Promise<ExecuteRunResult> {
    this.logger.log('Executing run', { repo: command.repo });
    return this.runProcessorService.runSession(command);
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
      sessionKey: command.sessionKey,
      prependSystemPrompt: command.prependSystemPrompt,
      appendSystemPrompt: command.appendSystemPrompt,
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
}
