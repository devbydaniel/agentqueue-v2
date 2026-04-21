import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type {
  CronTrigger,
  GithubTrigger,
  LinearEventType,
  LinearTrigger,
  TelegramTrigger,
  TriggersFile,
  WebhookFilter,
} from './trigger-config.interface.js';
import { interpolateEnvVars } from './trigger-config.interface.js';
import { normalizeCwd } from '../common/utils/cwd-path.js';

const EMPTY_TRIGGERS = {
  cron: [] as CronTrigger[],
  linear: [] as LinearTrigger[],
  github: [] as GithubTrigger[],
  telegram: [] as TelegramTrigger[],
};

const VALID_LINEAR_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  'assigned',
  'mentioned',
]);

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

  getConfigPath(): string {
    return path.join(os.homedir(), '.agentqueue', 'triggers.yaml');
  }

  private loadTriggers(): typeof EMPTY_TRIGGERS {
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

      if (!parsed?.triggers) {
        return { ...EMPTY_TRIGGERS };
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
            ...(entry['on'] ? { on: entry['on'] as LinearEventType } : {}),
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

      const validatedLinearEntries =
        this.crossValidateLinearTriggers(linearEntries);

      const result = {
        cron: cronEntries,
        linear: validatedLinearEntries,
        github: githubEntries,
        telegram: telegramEntries,
      };
      for (const [type, entries] of Object.entries(result)) {
        if (entries.length > 0) {
          this.logger.log(
            `Loaded ${entries.length} ${type} trigger(s) from ${configPath}`,
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

  private crossValidateLinearTriggers(
    triggers: LinearTrigger[],
  ): LinearTrigger[] {
    const byName = new Map<string, LinearTrigger[]>();
    for (const t of triggers) {
      const group = byName.get(t.name) ?? [];
      group.push(t);
      byName.set(t.name, group);
    }

    const valid: LinearTrigger[] = [];
    for (const [name, group] of byName) {
      if (group.length === 1) {
        valid.push(group[0]);
        continue;
      }

      const first = group[0];
      if (
        group.some(
          (t) =>
            t.signing_secret !== first.signing_secret ||
            t.api_key !== first.api_key,
        )
      ) {
        this.logger.error(
          `Linear triggers sharing name "${name}" have inconsistent signing_secret/api_key — discarding group`,
        );
      } else if (group.some((t) => t.on === undefined)) {
        this.logger.error(
          `Linear trigger "${name}" without "on" cannot coexist with other triggers sharing the same name — discarding group`,
        );
      } else if (new Set(group.map((t) => t.on)).size !== group.length) {
        this.logger.error(
          `Linear triggers sharing name "${name}" have duplicate "on" values — discarding group`,
        );
      } else {
        valid.push(...group);
      }
    }

    return valid;
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

    if (
      trigger['on'] !== undefined &&
      !VALID_LINEAR_EVENT_TYPES.has(trigger['on'] as string)
    ) {
      this.logger.warn(
        `Linear trigger "${name}" has invalid "on" value: "${trigger['on'] as string}". Must be "assigned" or "mentioned".`,
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
    const userId = trigger['user_id'];
    const cwd = trigger['cwd'] as string | undefined;

    if (!name || !botName || !botToken || userId === undefined || !cwd) {
      this.logger.warn(
        `Telegram trigger missing required fields (name, bot_name, bot_token, user_id, cwd): ${JSON.stringify(trigger)}`,
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
