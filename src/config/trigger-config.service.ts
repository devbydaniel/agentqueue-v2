import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type {
  CronTrigger,
  GithubTrigger,
  LinearTrigger,
  SlackTrigger,
  TelegramTrigger,
  TriggersFile,
} from './trigger-config.interface.js';
import { parseCronTriggers } from './trigger-parsers/cron.parser.js';
import {
  parseLinearTriggers,
  VALID_LINEAR_EVENT_TYPES,
} from './trigger-parsers/linear.parser.js';
import { parseGithubTriggers } from './trigger-parsers/github.parser.js';
import { parseTelegramTriggers } from './trigger-parsers/telegram.parser.js';
import { parseSlackTriggers } from './trigger-parsers/slack.parser.js';

interface LoadedTriggers {
  cron: CronTrigger[];
  linear: LinearTrigger[];
  github: GithubTrigger[];
  telegram: TelegramTrigger[];
  slack: SlackTrigger[];
}

const EMPTY_TRIGGERS: LoadedTriggers = {
  cron: [],
  linear: [],
  github: [],
  telegram: [],
  slack: [],
};

@Injectable()
export class TriggerConfigService implements OnModuleInit {
  private readonly logger = new Logger(TriggerConfigService.name);

  private cronTriggers: CronTrigger[] = [];
  private linearTriggers: LinearTrigger[] = [];
  private githubTriggers: GithubTrigger[] = [];
  private telegramTriggers: TelegramTrigger[] = [];
  private slackTriggers: SlackTrigger[] = [];

  onModuleInit(): void {
    const result = this.loadTriggers();
    this.cronTriggers = result.cron;
    this.linearTriggers = result.linear;
    this.githubTriggers = result.github;
    this.telegramTriggers = result.telegram;
    this.slackTriggers = result.slack;
  }

  getCronTriggers(): CronTrigger[] {
    return this.cronTriggers;
  }

  static triggerKey(trigger: LinearTrigger): string {
    return trigger.on ? `${trigger.name}:${trigger.on}` : trigger.name;
  }

  getLinearTriggers(): LinearTrigger[] {
    return this.linearTriggers;
  }

  getLinearTrigger(name: string): LinearTrigger | undefined {
    return this.linearTriggers.find((t) => t.name === name);
  }

  /** Returns all Linear triggers sharing the given name (webhook endpoint). */
  getLinearTriggersByName(name: string): LinearTrigger[] {
    return this.linearTriggers.filter((t) => t.name === name);
  }

  /**
   * Resolves a composite trigger key (`"name:on"` or plain `"name"`)
   * back to a specific LinearTrigger. Falls back to first match by name.
   */
  getLinearTriggerByKey(key: string): LinearTrigger | undefined {
    const colonIdx = key.lastIndexOf(':');
    if (colonIdx > 0) {
      const possibleEvent = key.slice(colonIdx + 1);
      if (VALID_LINEAR_EVENT_TYPES.has(possibleEvent)) {
        const name = key.slice(0, colonIdx);
        const match = this.linearTriggers.find(
          (t) => t.name === name && t.on === possibleEvent,
        );
        if (match) return match;
      }
    }
    return this.getLinearTrigger(key);
  }

  getGithubTriggers(): GithubTrigger[] {
    return this.githubTriggers;
  }

  getTelegramTriggers(): TelegramTrigger[] {
    return this.telegramTriggers;
  }

  getTelegramTrigger(name: string): TelegramTrigger | undefined {
    return this.telegramTriggers.find((t) => t.name === name);
  }

  getTelegramTriggersForBot(botName: string): TelegramTrigger[] {
    return this.telegramTriggers.filter((t) => t.bot_name === botName);
  }

  getSlackTriggers(): SlackTrigger[] {
    return this.slackTriggers;
  }

  getSlackTrigger(name: string): SlackTrigger | undefined {
    return this.slackTriggers.find((t) => t.name === name);
  }

  getSlackTriggersForBot(botName: string): SlackTrigger[] {
    return this.slackTriggers.filter((t) => t.bot_name === botName);
  }

  getConfigPath(): string {
    return path.join(os.homedir(), '.agentqueue', 'triggers.yaml');
  }

  private loadTriggers(): LoadedTriggers {
    const configPath = this.getConfigPath();

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from os.homedir(), not user input
    if (!existsSync(configPath)) {
      this.logger.warn(
        `Triggers config not found at ${configPath}, no cron triggers will be registered`,
      );
      return { ...EMPTY_TRIGGERS };
    }

    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from os.homedir(), not user input
      const content = readFileSync(configPath, 'utf-8');
      const parsed = yaml.load(content) as TriggersFile | null;
      if (!parsed?.triggers) return { ...EMPTY_TRIGGERS };

      const raw = parsed.triggers as unknown as Record<string, unknown>[];
      const result: LoadedTriggers = {
        cron: parseCronTriggers(raw, this.logger),
        linear: parseLinearTriggers(raw, this.logger),
        github: parseGithubTriggers(raw, this.logger),
        telegram: parseTelegramTriggers(raw, this.logger),
        slack: parseSlackTriggers(raw, this.logger),
      };

      for (const type of Object.keys(result) as (keyof LoadedTriggers)[]) {
        // eslint-disable-next-line security/detect-object-injection -- type is a known key of LoadedTriggers
        const count = result[type].length;
        if (count > 0) {
          this.logger.log(
            `Loaded ${count} ${type} trigger(s) from ${configPath}`,
          );
        }
      }
      return result;
    } catch (error) {
      this.logger.error(
        `Failed to load triggers config: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ...EMPTY_TRIGGERS };
    }
  }
}
