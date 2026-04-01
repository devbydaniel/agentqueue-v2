import {
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import * as cron from 'node-cron';
import { TriggerConfigService } from './trigger-config.service.js';
import { ExecuteRunUseCase } from '../runs/application/execute-run.use-case.js';

@Injectable()
export class CronSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CronSchedulerService.name);
  private readonly tasks: cron.ScheduledTask[] = [];

  constructor(
    private readonly triggerConfigService: TriggerConfigService,
    private readonly executeRunUseCase: ExecuteRunUseCase,
  ) {}

  onModuleInit(): void {
    const triggers = this.triggerConfigService.getCronTriggers();

    for (const trigger of triggers) {
      if (!cron.validate(trigger.schedule)) {
        this.logger.warn(
          `Invalid cron schedule for trigger "${trigger.name}": ${trigger.schedule}`,
        );
        continue;
      }

      const task = cron.schedule(
        trigger.schedule,

        async () => {
          await this.handleCronTick(
            trigger.name,
            trigger.target,
            trigger.prompt,
          );
        },
      );

      this.tasks.push(task);
      this.logger.log(
        `Registered cron trigger "${trigger.name}" [${trigger.schedule}] → ${trigger.target}`,
      );
    }

    this.logger.log(`Cron scheduler started with ${this.tasks.length} task(s)`);
  }

  onModuleDestroy(): void {
    for (const task of this.tasks) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises -- stop() returns void, not a Promise
      task.stop();
    }
    this.logger.log(`Stopped ${this.tasks.length} cron task(s)`);
    this.tasks.length = 0;
  }

  private async handleCronTick(
    triggerName: string,
    repo: string,
    prompt: string,
  ): Promise<void> {
    this.logger.log(`Cron trigger "${triggerName}" fired, executing run`, {
      repo,
    });

    try {
      const result = await this.executeRunUseCase.execute({ repo, prompt });
      this.logger.log(`Cron trigger "${triggerName}" completed`, {
        success: result.success,
      });
    } catch (error) {
      this.logger.error(
        `Cron trigger "${triggerName}" failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
