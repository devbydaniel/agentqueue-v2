import {
  Injectable,
  Logger,
  type OnModuleInit,
  type OnApplicationShutdown,
} from '@nestjs/common';
import pg from 'pg';
import { AppConfigService } from '../config/app-config.service.js';
import { RUN_COMPLETED_CHANNEL } from '../runs/run-completion.notifier.js';
import { RunRepository } from '../runs/run.repository.js';
import type { Run } from '../database/runs.schema.js';

export interface RunCompletionResult {
  status: 'succeeded' | 'errored' | 'timed_out' | 'aborted' | 'interrupted';
  errorMessage?: string;
  runId: string;
}

interface Waiter {
  resolve: (result: RunCompletionResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

@Injectable()
export class FlowRunCompletionListener
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(FlowRunCompletionListener.name);
  private readonly waiters = new Map<string, Waiter>();
  private client: pg.Client | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly runRepository: RunRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    // Create a dedicated client for LISTEN
    // (LISTEN requires a persistent connection, not a pooled one)
    this.client = new pg.Client({
      connectionString: this.config.databaseUrl,
    });

    await this.client.connect();

    await this.client.query(`LISTEN ${RUN_COMPLETED_CHANNEL}`);

    this.client.on('notification', (msg) => {
      if (msg.channel === RUN_COMPLETED_CHANNEL && msg.payload) {
        void this.handleNotification(msg.payload);
      }
    });

    this.client.on('error', (err) => {
      this.logger.error(
        `LISTEN client error: ${err.message} — rejecting all pending waiters`,
      );
      this.rejectAllWaiters(
        new Error(`LISTEN client connection lost: ${err.message}`),
      );
    });

    this.logger.log('Listening for run completions', {
      channel: RUN_COMPLETED_CHANNEL,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.rejectAllWaiters(new Error('Application shutting down'));

    if (this.client) {
      try {
        await this.client.end();
      } catch {
        // ignore close errors during shutdown
      }
      this.client = null;
    }
  }

  /**
   * Wait for a specific run to reach terminal status.
   * Resolves when the run completes or rejects on timeout.
   */
  waitFor(runId: string, timeoutMs: number): Promise<RunCompletionResult> {
    return new Promise<RunCompletionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(runId);
        reject(
          new Error(`Timed out waiting for run ${runId} after ${timeoutMs}ms`),
        );
      }, timeoutMs);

      this.waiters.set(runId, { resolve, reject, timer });
    });
  }

  private async handleNotification(runId: string): Promise<void> {
    const waiter = this.waiters.get(runId);
    if (!waiter) return; // No one waiting for this run

    this.waiters.delete(runId);
    clearTimeout(waiter.timer);

    try {
      const run = await this.runRepository.findById(runId);
      if (!run) {
        waiter.reject(new Error(`Run ${runId} not found after notification`));
        return;
      }

      waiter.resolve(this.toCompletionResult(run));
    } catch (error) {
      waiter.reject(
        error instanceof Error
          ? error
          : new Error('Failed to fetch run after notification'),
      );
    }
  }

  private toCompletionResult(run: Run): RunCompletionResult {
    return {
      status: run.status as RunCompletionResult['status'],
      errorMessage: run.errorMessage ?? undefined,
      runId: run.id,
    };
  }

  private rejectAllWaiters(error: Error): void {
    for (const [runId, waiter] of this.waiters.entries()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.waiters.delete(runId);
    }
  }
}
