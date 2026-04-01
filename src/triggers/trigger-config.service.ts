import { Injectable, Logger } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type {
  CronTrigger,
  LinearTrigger,
  TriggersFile,
} from './trigger-config.interface.js';
import { interpolateEnvVars } from './trigger-config.interface.js';

@Injectable()
export class TriggerConfigService {
  private readonly logger = new Logger(TriggerConfigService.name);
  private readonly cronTriggers: CronTrigger[];
  private readonly linearTrigger: LinearTrigger | undefined;

  constructor() {
    const result = this.loadTriggers();
    this.cronTriggers = result.cron;
    this.linearTrigger = result.linear;
  }

  getCronTriggers(): CronTrigger[] {
    return this.cronTriggers;
  }

  getLinearTrigger(): LinearTrigger | undefined {
    return this.linearTrigger;
  }

  getConfigPath(): string {
    return path.join(os.homedir(), '.agentqueue', 'triggers.yaml');
  }

  private loadTriggers(): {
    cron: CronTrigger[];
    linear: LinearTrigger | undefined;
  } {
    const configPath = this.getConfigPath();

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from os.homedir(), not user input
    if (!existsSync(configPath)) {
      this.logger.warn(
        `Triggers config not found at ${configPath}, no cron triggers will be registered`,
      );
      return { cron: [], linear: undefined };
    }

    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from os.homedir(), not user input
      const content = readFileSync(configPath, 'utf-8');
      const parsed = yaml.load(content) as TriggersFile | null;

      if (!parsed?.triggers) {
        return { cron: [], linear: undefined };
      }

      const raw = parsed.triggers as unknown as Record<string, unknown>[];

      const cronEntries = raw
        .filter((t) => !t['type'] || t['type'] === 'cron')
        .filter((t) => this.validateCronTrigger(t));

      const linearEntry = raw.find((t) => t['type'] === 'linear');
      let linear: LinearTrigger | undefined;

      if (linearEntry && this.validateLinearTrigger(linearEntry)) {
        linear = {
          name: linearEntry['name'] as string,
          type: 'linear',
          signing_secret: interpolateEnvVars(
            linearEntry['signing_secret'] as string,
          ),
          api_key: interpolateEnvVars(linearEntry['api_key'] as string),
        };
        this.logger.log('Loaded linear trigger config');
      }

      this.logger.log(
        `Loaded ${cronEntries.length} cron trigger(s) from ${configPath}`,
      );
      return {
        cron: cronEntries as unknown as CronTrigger[],
        linear,
      };
    } catch (error) {
      this.logger.error(
        `Failed to load triggers config: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { cron: [], linear: undefined };
    }
  }

  private validateCronTrigger(trigger: Record<string, unknown>): boolean {
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

  private validateLinearTrigger(trigger: Record<string, unknown>): boolean {
    const name = trigger['name'] as string | undefined;
    const signingSecret = trigger['signing_secret'] as string | undefined;
    const apiKey = trigger['api_key'] as string | undefined;

    if (!name || !signingSecret || !apiKey) {
      this.logger.warn(
        `Linear trigger missing required fields (name, signing_secret, api_key): ${JSON.stringify(trigger)}`,
      );
      return false;
    }

    return true;
  }
}
