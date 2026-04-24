import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { App, ExpressReceiver } from '@slack/bolt';
import type { Express } from 'express';
import { TriggerConfigService } from '../config/trigger-config.service.js';
import type { SlackTrigger } from '../config/trigger-config.interface.js';
import { SlackIngestService } from './slack-ingest.service.js';
import { SlackService } from './slack.service.js';

const SUGGESTED_PROMPTS = [
  { title: 'Status check', message: 'What are you working on?' },
  { title: 'Help', message: 'What can you do?' },
];

interface RunningBot {
  botName: string;
  app: App;
}

function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

function groupByBotName(triggers: SlackTrigger[]): Map<string, SlackTrigger[]> {
  const byBotName = new Map<string, SlackTrigger[]>();
  for (const trigger of triggers) {
    const existing = byBotName.get(trigger.bot_name) ?? [];
    existing.push(trigger);
    byBotName.set(trigger.bot_name, existing);
  }
  return byBotName;
}

@Injectable()
export class SlackListenerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(SlackListenerService.name);
  private readonly runningBots: RunningBot[] = [];

  constructor(
    private readonly triggerConfigService: TriggerConfigService,
    private readonly ingestService: SlackIngestService,
    private readonly slackService: SlackService,
    private readonly httpAdapterHost: HttpAdapterHost,
  ) {}

  onApplicationBootstrap(): void {
    const triggers = this.triggerConfigService.getSlackTriggers();
    if (triggers.length === 0) {
      this.logger.log('No Slack triggers configured; listener idle');
      return;
    }

    const expressApp = this.httpAdapterHost.httpAdapter.getInstance<Express>();
    for (const [botName, group] of groupByBotName(triggers)) {
      this.bootstrapBot(botName, group, expressApp);
    }
  }

  private bootstrapBot(
    botName: string,
    group: SlackTrigger[],
    expressApp: Express,
  ): void {
    const first = group[0];
    const inconsistent = group.some(
      (t) =>
        t.bot_token !== first.bot_token ||
        t.signing_secret !== first.signing_secret,
    );
    if (inconsistent) {
      this.logger.error(
        `Slack bot "${botName}" has inconsistent bot_token or signing_secret across triggers; skipping`,
      );
      return;
    }

    try {
      const receiver = new ExpressReceiver({
        signingSecret: first.signing_secret,
        endpoints: '/events',
      });
      const app = new App({ token: first.bot_token, receiver });
      this.registerHandlers(botName, app);
      expressApp.use(`/slack/${botName}`, receiver.router);
      this.slackService.registerClient(botName, app.client);
      this.runningBots.push({ botName, app });
      this.logger.log(
        `Slack bot "${botName}" mounted at /slack/${botName}/events`,
      );
    } catch (error) {
      this.logger.error(`Failed to initialize Slack bot "${botName}"`, {
        error: error as Error,
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const { botName, app } of this.runningBots) {
      try {
        await app.stop();
        this.logger.log(`Stopped Slack bot "${botName}"`);
      } catch (error) {
        this.logger.error(`Failed to stop Slack bot "${botName}"`, {
          error: error as Error,
        });
      }
    }
    this.runningBots.length = 0;
  }

  private registerHandlers(botName: string, app: App): void {
    app.event('assistant_thread_started', async ({ event, client, logger }) => {
      try {
        const { channel_id, thread_ts } = event.assistant_thread;
        await client.assistant.threads.setSuggestedPrompts({
          channel_id,
          thread_ts,
          title: 'How can I help?',
          prompts: SUGGESTED_PROMPTS,
        });
      } catch (error) {
        logger.error(
          `assistant_thread_started handler failed: ${String(error)}`,
        );
      }
    });

    app.event('app_mention', async ({ event, client, logger }) => {
      const text = stripMentions(event.text);
      if (!text) return;
      const threadTs = event.thread_ts ?? event.ts;
      this.startIndicators(client, event.channel, event.ts, threadTs);
      await this.ingest(logger, botName, {
        channelId: event.channel,
        userId: event.user ?? '',
        threadTs,
        text,
      });
    });

    app.message(async ({ message, client, logger }) => {
      if (message.subtype !== undefined && message.subtype !== 'file_share') {
        return;
      }
      if (message.channel_type !== 'im') return;
      if ('bot_id' in message && message.bot_id) return;
      const text = (
        'text' in message && message.text ? message.text : ''
      ).trim();
      if (!text) return;
      const threadTs = message.thread_ts ?? message.ts;
      this.startIndicators(client, message.channel, message.ts, threadTs);
      await this.ingest(logger, botName, {
        channelId: message.channel,
        userId: ('user' in message && message.user) || '',
        threadTs,
        text,
      });
    });
  }

  private async ingest(
    logger: { error: (msg: string) => void },
    botName: string,
    params: {
      channelId: string;
      userId: string;
      threadTs: string;
      text: string;
    },
  ): Promise<void> {
    try {
      await this.ingestService.ingestMessage({ botName, ...params });
    } catch (error) {
      logger.error(`Slack ingest failed: ${String(error)}`);
    }
  }

  private startIndicators(
    client: App['client'],
    channelId: string,
    messageTs: string,
    threadTs: string,
  ): void {
    void Promise.allSettled([
      client.reactions.add({
        channel: channelId,
        timestamp: messageTs,
        name: 'eyes',
      }),
      client.assistant.threads.setStatus({
        channel_id: channelId,
        thread_ts: threadTs,
        status: 'Thinking…',
      }),
    ]);
  }
}
