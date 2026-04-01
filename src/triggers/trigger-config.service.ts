import { Injectable, Logger } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type { CronTrigger, TriggersFile } from './trigger-config.interface.js';

@Injectable()
export class TriggerConfigService {
  private readonly logger = new Logger(TriggerConfigService.name);
  private readonly triggers: CronTrigger[];

  constructor() {
    this.triggers = this.loadTriggers();
  }

  getCronTriggers(): CronTrigger[] {
    return this.triggers;
  }

  getConfigPath(): string {
    return path.join(os.homedir(), '.agentqueue', 'triggers.yaml');
  }

  private loadTriggers(): CronTrigger[] {
    const configPath = this.getConfigPath();

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from os.homedir(), not user input
    if (!existsSync(configPath)) {
      this.logger.warn(
        `Triggers config not found at ${configPath}, no cron triggers will be registered`,
      );
      return [];
    }

    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from os.homedir(), not user input
      const content = readFileSync(configPath, 'utf-8');
      const parsed = yaml.load(content) as TriggersFile | null;

      if (!parsed?.triggers) {
        return [];
      }

      const validated = (
        parsed.triggers as unknown as Record<string, unknown>[]
      ).filter((t) => this.validateTrigger(t));

      this.logger.log(
        `Loaded ${validated.length} cron trigger(s) from ${configPath}`,
      );
      return validated as unknown as CronTrigger[];
    } catch (error) {
      this.logger.error(
        `Failed to load triggers config: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  private validateTrigger(trigger: Record<string, unknown>): boolean {
    const name = trigger['name'] as string | undefined;
    const schedule = trigger['schedule'] as string | undefined;
    const target = trigger['target'] as string | undefined;
    const prompt = trigger['prompt'] as string | undefined;

    if (!name || !schedule || !target || !prompt) {
      this.logger.warn(
        `Trigger missing required fields (name, schedule, target, prompt): ${JSON.stringify(trigger)}`,
      );
      return false;
    }

    return true;
  }
}
