import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { BOSS } from '../queue/queue.tokens.js';
import type { Boss } from '../queue/queue.tokens.js';
import { AppConfigService } from '../config/app-config.service.js';
import { RunProcessorService } from './run-processor.service.js';
import { RUNS_QUEUE_NAME } from './runs.constants.js';

@Injectable()
export class RunQueueWorkerService implements OnModuleInit {
  private readonly logger = new Logger(RunQueueWorkerService.name);

  constructor(
    @Inject(BOSS) private readonly boss: Boss,
    private readonly appConfigService: AppConfigService,
    private readonly runProcessorService: RunProcessorService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.boss.work(
      RUNS_QUEUE_NAME,
      {
        localConcurrency: this.appConfigService.queueConcurrency,
      },
      async (jobs) => {
        // pg-boss delivers an array; we process each independently
        for (const job of jobs) {
          const runId = (job.data as { runId: string }).runId;
          this.logger.log('Processing run from queue', {
            runId,
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
      queue: RUNS_QUEUE_NAME,
      concurrency: this.appConfigService.queueConcurrency,
    });
  }
}
