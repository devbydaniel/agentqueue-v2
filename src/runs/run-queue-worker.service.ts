import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { BOSS } from '../queue/queue.tokens.js';
import type { Boss } from '../queue/queue.tokens.js';
import { AppConfigService } from '../config/app-config.service.js';
import { TriggerConfigService } from '../config/trigger-config.service.js';
import type { QueueConfig } from '../config/trigger-config.interface.js';
import { RunProcessorService } from './run-processor.service.js';
import { ActiveSessionTrackerService } from './active-session-tracker.service.js';
import { RUNS_QUEUE_NAME } from './runs.constants.js';

@Injectable()
export class RunQueueWorkerService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(RunQueueWorkerService.name);

  constructor(
    @Inject(BOSS) private readonly boss: Boss,
    private readonly appConfigService: AppConfigService,
    private readonly triggerConfigService: TriggerConfigService,
    private readonly runProcessorService: RunProcessorService,
    private readonly activeSessionTracker: ActiveSessionTrackerService,
  ) {}

  async onModuleInit(): Promise<void> {
    // The default queue, then one worker per queue from triggers.yaml, each
    // with its own concurrency so a busy queue can't starve another.
    const queues: QueueConfig[] = [
      {
        name: RUNS_QUEUE_NAME,
        concurrency: this.appConfigService.queueConcurrency,
      },
      ...this.triggerConfigService.getQueues(),
    ];
    for (const queue of queues) {
      await this.registerWorker(queue);
    }
  }

  private async registerWorker(queue: QueueConfig): Promise<void> {
    await this.boss.createQueue(queue.name);
    await this.boss.work(
      queue.name,
      {
        localConcurrency: queue.concurrency,
        // One run per external session at a time (see RunsService.enqueue).
        // The in-memory variant is deliberate: pg-boss's DB-tracked
        // groupConcurrency races when several local workers fetch at once and
        // let grouped jobs run in parallel. agentqueue runs as a single pod.
        localGroupConcurrency: 1,
      },
      async (jobs) => {
        // pg-boss delivers an array; we process each independently
        for (const job of jobs) {
          const runId = (job.data as { runId: string }).runId;
          this.logger.log('Processing run from queue', {
            runId,
            queue: queue.name,
            jobId: job.id,
          });
          try {
            await this.runProcessorService.processRun(runId);
            this.logger.log('Run processed successfully', {
              runId,
              jobId: job.id,
            });
          } catch (error) {
            this.logger.error('Run processing failed', {
              runId,
              jobId: job.id,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          }
        }
      },
    );

    this.logger.log('Registered queue worker', {
      queue: queue.name,
      concurrency: queue.concurrency,
    });
  }

  onApplicationShutdown(): void {
    this.logger.log('Shutting down queue worker — aborting in-flight sessions');
    this.activeSessionTracker.abortAll();
    this.logger.log('Queue worker shutdown complete');
  }
}
