import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type {
  CronTrigger,
  GithubTrigger,
  LinearTrigger,
  TelegramTrigger,
  TriggersFile,
  WebhookFilter,
} from './trigger-config.interface.js';
import { interpolateEnvVars } from './trigger-config.interface.js';
import { normalizeCwd } from '../common/utils/cwd-path.js';

export interface TelegramBotConfig {
  botName: string;
  botToken: string;
  webhookSecret: string;
}

@Injectable()
export class TriggerConfigService implements OnModuleInit {
  private readonly logger = new Logger(TriggerConfigService.name);
  private cronTriggers: CronTrigger[] = [];
  private linearTriggers: LinearTrigger[] = [];
  private githubTriggers: GithubTrigger[] = [];
  private telegramTriggers: TelegramTrigger[] = [];

  onModuleInit(): void {
    const result = this.loadTriggers();
    this.cronTriggers = result.cron;
    this.linearTriggers = result.linear;
    this.githubTriggers = result.github;
    this.telegramTriggers = result.telegram;
  }

  getCronTriggers(): CronTrigger[] {
    return this.cronTriggers;
  }

  getLinearTriggers(): LinearTrigger[] {
    return this.linearTriggers;
  }

  getLinearTrigger(name: string): LinearTrigger | undefined {
    return this.linearTriggers.find((t) => t.name === name);
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

  getTelegramBotConfig(botName: string): TelegramBotConfig | undefined {
    const triggers = this.getTelegramTriggersForBot(botName);
    if (triggers.length === 0) {
      return undefined;
    }

    const [first, ...rest] = triggers;
    const isConsistent = rest.every(
      (trigger) =>
        trigger.bot_token === first.bot_token &&
        trigger.webhook_secret === first.webhook_secret,
    );

    if (!isConsistent) {
      this.logger.error(
        `Telegram bot "${botName}" has inconsistent bot_token/webhook_secret values across triggers`,
      );
      return undefined;
    }

    return {
      botName,
      botToken: first.bot_token,
      webhookSecret: first.webhook_secret,
    };
  }

  getConfigPath(): string {
    return path.join(os.homedir(), '.agentqueue', 'triggers.yaml');
  }

  private loadTriggers(): {
    cron: CronTrigger[];
    linear: LinearTrigger[];
    github: GithubTrigger[];
    telegram: TelegramTrigger[];
  } {
    const configPath = this.getConfigPath();

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from os.homedir(), not user input
    if (!existsSync(configPath)) {
      this.logger.warn(
        `Triggers config not found at ${configPath}, no cron triggers will be registered`,
      );
      return { cron: [], linear: [], github: [], telegram: [] };
    }

    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from os.homedir(), not user input
      const content = readFileSync(configPath, 'utf-8');
      const parsed = yaml.load(content) as TriggersFile | null;

      if (!parsed?.triggers) {
        return { cron: [], linear: [], github: [], telegram: [] };
      }

      const raw = parsed.triggers as unknown as Record<string, unknown>[];

      const cronEntries = raw
        .filter((t) => !t['type'] || t['type'] === 'cron')
        .filter((t) => this.validateCronTrigger(t))
        .map(
          (entry): CronTrigger => ({
            name: entry['name'] as string,
            schedule: entry['schedule'] as string,
            cwd: normalizeCwd(entry['cwd'] as string, 'cron trigger cwd'),
            prompt: entry['prompt'] as string,
            ...(entry['agent'] ? { agent: entry['agent'] as string } : {}),
            ...(entry['before'] ? { before: entry['before'] as string } : {}),
            ...(entry['append_system_prompt']
              ? {
                  append_system_prompt: entry['append_system_prompt'] as string,
                }
              : {}),
            ...(entry['timeout_ms']
              ? { timeout_ms: entry['timeout_ms'] as number }
              : {}),
          }),
        );

      const linearEntries = raw
        .filter((t) => t['type'] === 'linear')
        .filter((t) => this.validateLinearTrigger(t))
        .map(
          (entry): LinearTrigger => ({
            name: entry['name'] as string,
            type: 'linear',
            cwd: normalizeCwd(entry['cwd'] as string, 'linear trigger cwd'),
            signing_secret: interpolateEnvVars(
              entry['signing_secret'] as string,
            ),
            api_key: interpolateEnvVars(entry['api_key'] as string),
            ...(entry['agent'] ? { agent: entry['agent'] as string } : {}),
            ...(entry['append_system_prompt']
              ? {
                  append_system_prompt: entry['append_system_prompt'] as string,
                }
              : {}),
            ...(entry['timeout_ms']
              ? { timeout_ms: entry['timeout_ms'] as number }
              : {}),
          }),
        );

      const githubEntries = raw
        .filter((t) => t['type'] === 'github')
        .filter((t) => this.validateGithubTrigger(t))
        .map(
          (entry): GithubTrigger => ({
            name: entry['name'] as string,
            type: 'github',
            events: entry['events'] as string[],
            cwd: normalizeCwd(entry['cwd'] as string, 'github trigger cwd'),
            prompt: entry['prompt'] as string,
            ...(entry['agent'] ? { agent: entry['agent'] as string } : {}),
            ...(entry['filters']
              ? { filters: entry['filters'] as WebhookFilter[] }
              : {}),
            ...(entry['before'] ? { before: entry['before'] as string } : {}),
            ...(entry['append_system_prompt']
              ? {
                  append_system_prompt: entry['append_system_prompt'] as string,
                }
              : {}),
            ...(entry['timeout_ms']
              ? { timeout_ms: entry['timeout_ms'] as number }
              : {}),
          }),
        );

      const telegramEntries = raw
        .filter((t) => t['type'] === 'telegram')
        .filter((t) => this.validateTelegramTrigger(t))
        .map(
          (entry): TelegramTrigger => ({
            name: entry['name'] as string,
            type: 'telegram',
            bot_name: entry['bot_name'] as string,
            bot_token: interpolateEnvVars(entry['bot_token'] as string),
            webhook_secret: interpolateEnvVars(
              entry['webhook_secret'] as string,
            ),
            user_id: String(entry['user_id']),
            cwd: normalizeCwd(entry['cwd'] as string, 'telegram trigger cwd'),
            ...((typeof entry['chat_id'] === 'string' ||
              typeof entry['chat_id'] === 'number') &&
            entry['chat_id']
              ? { chat_id: String(entry['chat_id']) }
              : {}),
            ...(entry['agent'] ? { agent: entry['agent'] as string } : {}),
            ...(entry['append_system_prompt']
              ? {
                  append_system_prompt: entry['append_system_prompt'] as string,
                }
              : {}),
            ...(entry['timeout_ms']
              ? { timeout_ms: entry['timeout_ms'] as number }
              : {}),
          }),
        );

      if (linearEntries.length > 0) {
        this.logger.log(
          `Loaded ${linearEntries.length} linear trigger(s) from ${configPath}`,
        );
      }

      if (githubEntries.length > 0) {
        this.logger.log(
          `Loaded ${githubEntries.length} github trigger(s) from ${configPath}`,
        );
      }

      if (telegramEntries.length > 0) {
        this.logger.log(
          `Loaded ${telegramEntries.length} telegram trigger(s) from ${configPath}`,
        );
      }

      this.logger.log(
        `Loaded ${cronEntries.length} cron trigger(s) from ${configPath}`,
      );
      return {
        cron: cronEntries,
        linear: linearEntries,
        github: githubEntries,
        telegram: telegramEntries,
      };
    } catch (error) {
      this.logger.error(
        `Failed to load triggers config: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { cron: [], linear: [], github: [], telegram: [] };
    }
  }

  private validateCronTrigger(trigger: Record<string, unknown>): boolean {
    const name = trigger['name'] as string | undefined;
    const schedule = trigger['schedule'] as string | undefined;
    const cwd = trigger['cwd'] as string | undefined;
    const prompt = trigger['prompt'] as string | undefined;

    if (!name || !schedule || !cwd || !prompt) {
      this.logger.warn(
        `Trigger missing required fields (name, schedule, cwd, prompt): ${JSON.stringify(trigger)}`,
      );
      return false;
    }

    try {
      normalizeCwd(cwd, `cron trigger "${name}" cwd`);
    } catch (error) {
      this.logger.warn(
        `Skipping cron trigger "${name}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }

    return true;
  }

  private validateLinearTrigger(trigger: Record<string, unknown>): boolean {
    const name = trigger['name'] as string | undefined;
    const cwd = trigger['cwd'] as string | undefined;
    const signingSecret = trigger['signing_secret'] as string | undefined;
    const apiKey = trigger['api_key'] as string | undefined;

    if (!name || !cwd || !signingSecret || !apiKey) {
      this.logger.warn(
        `Linear trigger missing required fields (name, cwd, signing_secret, api_key): ${JSON.stringify(trigger)}`,
      );
      return false;
    }

    try {
      normalizeCwd(cwd, `linear trigger "${name}" cwd`);
    } catch (error) {
      this.logger.warn(
        `Skipping linear trigger "${name}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }

    return true;
  }

  private validateGithubTrigger(trigger: Record<string, unknown>): boolean {
    const name = trigger['name'] as string | undefined;
    const events = trigger['events'];
    const cwd = trigger['cwd'] as string | undefined;
    const prompt = trigger['prompt'] as string | undefined;

    if (!name || !cwd || !prompt) {
      this.logger.warn(
        `GitHub trigger missing required fields (name, cwd, prompt): ${JSON.stringify(trigger)}`,
      );
      return false;
    }

    try {
      normalizeCwd(cwd, `github trigger "${name}" cwd`);
    } catch (error) {
      this.logger.warn(
        `Skipping GitHub trigger "${name}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }

    if (!events || !Array.isArray(events) || events.length === 0) {
      this.logger.warn(
        `GitHub trigger "${name}" missing or empty events array`,
      );
      return false;
    }

    if (trigger['filters'] !== undefined) {
      if (!Array.isArray(trigger['filters'])) {
        this.logger.warn(`GitHub trigger "${name}" filters must be an array`);
        return false;
      }
      if (!this.validateFilters(name, trigger['filters'] as WebhookFilter[])) {
        return false;
      }
    }

    return true;
  }

  private validateTelegramTrigger(trigger: Record<string, unknown>): boolean {
    const name = trigger['name'] as string | undefined;
    const botName = trigger['bot_name'] as string | undefined;
    const botToken = trigger['bot_token'] as string | undefined;
    const webhookSecret = trigger['webhook_secret'] as string | undefined;
    const userId = trigger['user_id'];
    const cwd = trigger['cwd'] as string | undefined;

    if (
      !name ||
      !botName ||
      !botToken ||
      !webhookSecret ||
      userId === undefined ||
      !cwd
    ) {
      this.logger.warn(
        `Telegram trigger missing required fields (name, bot_name, bot_token, webhook_secret, user_id, cwd): ${JSON.stringify(trigger)}`,
      );
      return false;
    }

    try {
      normalizeCwd(cwd, `telegram trigger "${name}" cwd`);
    } catch (error) {
      this.logger.warn(
        `Skipping telegram trigger "${name}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }

    return true;
  }

  private validateFilters(
    triggerName: string,
    filters: WebhookFilter[],
  ): boolean {
    for (const filter of filters) {
      if (!filter.field || typeof filter.field !== 'string') {
        this.logger.warn(
          `GitHub trigger "${triggerName}" has a filter missing "field"`,
        );
        return false;
      }
      if (filter.pattern !== undefined) {
        try {
          // eslint-disable-next-line security/detect-non-literal-regexp -- pattern is from admin trigger config, not user input
          new RegExp(filter.pattern);
        } catch {
          this.logger.warn(
            `GitHub trigger "${triggerName}" filter on "${filter.field}" has invalid regex: ${filter.pattern}`,
          );
          return false;
        }
      }
    }
    return true;
  }
}
