import {
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import * as cron from 'node-cron';
import { TriggerConfigService } from './trigger-config.service.js';
import { interpolateTemplate } from './trigger-config.interface.js';
import type { CronTrigger } from './trigger-config.interface.js';
import { BeforeHookService } from './before-hook.service.js';
import { RunsService } from '../runs/runs.service.js';

@Injectable()
export class CronSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CronSchedulerService.name);
  private readonly tasks: cron.ScheduledTask[] = [];

  constructor(
    private readonly triggerConfigService: TriggerConfigService,
    private readonly runsService: RunsService,
    private readonly beforeHookService: BeforeHookService,
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

      const task = cron.schedule(trigger.schedule, async () => {
        await this.handleCronTick(trigger);
      });

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

  private async handleCronTick(trigger: CronTrigger): Promise<void> {
    this.logger.log(`Cron trigger "${trigger.name}" fired, executing run`, {
      repo: trigger.target,
    });

    let prompt = trigger.prompt;
    if (trigger.before) {
      const hookResult = await this.beforeHookService.run(
        trigger.before,
        `cron trigger "${trigger.name}"`,
      );
      if (!hookResult.proceed) {
        this.logger.log(
          `Cron trigger "${trigger.name}" skipped by before hook`,
        );
        return;
      }
      prompt = prompt.replace(/\{\{before_output\}\}/g, hookResult.output);
    }

    const templateVars = {
      triggerName: trigger.name,
      schedule: trigger.schedule,
      date: new Date().toISOString().slice(0, 10),
      target: trigger.target,
    };

    const prependSystemPrompt = trigger.prepend_system_prompt
      ? interpolateTemplate(trigger.prepend_system_prompt, templateVars)
      : undefined;
    const appendSystemPrompt = trigger.append_system_prompt
      ? interpolateTemplate(trigger.append_system_prompt, templateVars)
      : undefined;

    try {
      const result = await this.runsService.execute({
        repo: trigger.target,
        prompt,
        prependSystemPrompt,
        appendSystemPrompt,
      });
      this.logger.log(`Cron trigger "${trigger.name}" completed`, {
        success: result.success,
      });
    } catch (error) {
      this.logger.error(
        `Cron trigger "${trigger.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
