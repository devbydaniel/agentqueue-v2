import { Injectable, Logger } from '@nestjs/common';
import { TriggerConfigService } from '../config/trigger-config.service.js';
import {
  interpolateTemplate,
  type SlackTrigger,
} from '../config/trigger-config.interface.js';
import { RunsService } from '../runs/runs.service.js';
import { ExternalSessionRepository } from '../runs/external-session.repository.js';
import { SlackService } from './slack.service.js';
import { ensureDirectoryExists } from '../common/utils/cwd-path.js';

const SLACK_SESSION_IDLE_MS = 60 * 60 * 1000;

const SLACK_SYSTEM_PROMPT = `
You are responding via Slack. Format your responses accordingly:

- Use Slack mrkdwn: *bold*, _italic_, \`inline code\`, code fences for blocks
- Keep paragraphs short; blank lines separate them
- Do not use markdown tables (they render poorly)
- Prefer bullet lists for enumerations
`.trim();

export interface SlackIngestParams {
  botName: string;
  channelId: string;
  userId: string;
  threadTs: string | undefined;
  text: string;
}

export interface SlackIngestResult {
  accepted: boolean;
  handled: boolean;
}

function isResetCommand(text: string): boolean {
  return text.trim() === '/reset';
}

@Injectable()
export class SlackIngestService {
  private readonly logger = new Logger(SlackIngestService.name);

  constructor(
    private readonly triggerConfigService: TriggerConfigService,
    private readonly runsService: RunsService,
    private readonly externalSessionRepository: ExternalSessionRepository,
    private readonly slackService: SlackService,
  ) {}

  resolveTrigger(
    botName: string,
    userId: string,
    channelId: string,
  ): SlackTrigger | undefined {
    return this.triggerConfigService
      .getSlackTriggersForBot(botName)
      .find(
        (candidate) =>
          (!candidate.user_id || candidate.user_id === userId) &&
          (!candidate.channel_id || candidate.channel_id === channelId),
      );
  }

  async ingestMessage(params: SlackIngestParams): Promise<SlackIngestResult> {
    const trigger = this.resolveTrigger(
      params.botName,
      params.userId,
      params.channelId,
    );
    if (!trigger) {
      this.logger.debug('Ignoring Slack message with no matching trigger', {
        botName: params.botName,
        userId: params.userId,
        channelId: params.channelId,
      });
      return { accepted: true, handled: false };
    }

    const cwd = ensureDirectoryExists(trigger.cwd, 'slack trigger cwd');
    const sessionKey = buildSessionKey(
      params.botName,
      params.channelId,
      params.threadTs,
    );

    if (isResetCommand(params.text)) {
      await this.handleReset(sessionKey, params);
      return { accepted: true, handled: true };
    }

    await this.expireIfIdle(sessionKey);
    await this.externalSessionRepository.upsertSession({
      provider: 'slack',
      sessionKey,
      sessionId: null,
      botName: params.botName,
      chatId: params.channelId,
      lastActivityAt: new Date(),
    });

    void this.enqueueRun(trigger, cwd, sessionKey, params);
    return { accepted: true, handled: true };
  }

  private async handleReset(
    sessionKey: string,
    params: SlackIngestParams,
  ): Promise<void> {
    await this.teardownSession(sessionKey);
    void this.slackService
      .sendDirectMessage({
        botName: params.botName,
        channelId: params.channelId,
        text: 'Session reset. Send a new message to start fresh.',
        threadTs: params.threadTs,
      })
      .catch((error: unknown) => {
        this.logger.error('Failed to send Slack reset confirmation', {
          error: error as Error,
          sessionKey,
        });
      });
  }

  private async expireIfIdle(sessionKey: string): Promise<void> {
    const existing =
      await this.externalSessionRepository.findBySessionKey(sessionKey);
    if (
      existing?.lastActivityAt &&
      Date.now() - existing.lastActivityAt.getTime() > SLACK_SESSION_IDLE_MS
    ) {
      await this.teardownSession(sessionKey);
    }
  }

  private async teardownSession(sessionKey: string): Promise<void> {
    await this.externalSessionRepository.deleteBySessionKey(sessionKey);
    try {
      this.runsService.abortSession(sessionKey);
    } catch (error) {
      this.logger.error('Failed to abort Slack session', {
        error: error as Error,
        sessionKey,
      });
    }
  }

  private async enqueueRun(
    trigger: SlackTrigger,
    cwd: string,
    sessionKey: string,
    params: SlackIngestParams,
  ): Promise<void> {
    const triggerAppend = trigger.append_system_prompt
      ? interpolateTemplate(trigger.append_system_prompt, {
          botName: params.botName,
          userId: params.userId,
          channelId: params.channelId,
          triggerName: trigger.name,
          cwd,
        })
      : undefined;
    const appendSystemPrompt = triggerAppend
      ? `${triggerAppend}\n\n${SLACK_SYSTEM_PROMPT}`
      : SLACK_SYSTEM_PROMPT;

    try {
      await this.runsService.enqueue({
        source: 'slack',
        triggerName: trigger.name,
        cwd,
        prompt: params.text,
        externalSessionId: sessionKey,
        appendSystemPrompt,
        timeoutMs: trigger.timeout_ms,
      });
    } catch (error) {
      this.logger.error('Failed to enqueue Slack run', {
        error: error as Error,
        sessionKey,
      });
      void this.slackService.sendDirectMessage({
        botName: params.botName,
        channelId: params.channelId,
        text: ':warning: Failed to enqueue your request. Please try again.',
        threadTs: params.threadTs,
      });
    }
  }
}

export function buildSessionKey(
  botName: string,
  channelId: string,
  threadTs: string | undefined,
): string {
  return `slack:${botName}:${channelId}:${threadTs ?? 'main'}`;
}
