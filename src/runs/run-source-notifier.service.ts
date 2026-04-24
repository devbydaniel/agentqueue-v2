import { Injectable, Logger } from '@nestjs/common';
import type { Run } from '../database/runs.schema.js';
import type { AssistantMessageCallbackHandler } from '../callbacks/handlers/assistant-message.callback-handler.js';
import type { LinearCallbackHandler } from '../callbacks/handlers/linear.callback-handler.js';
import type { SlackStreamingCallbackHandler } from '../slack/slack-streaming.callback-handler.js';
import { TelegramService } from '../telegram/telegram.service.js';

export interface SuccessNotificationContext {
  linearHandler: LinearCallbackHandler | undefined;
  assistantMessageHandler: AssistantMessageCallbackHandler | undefined;
  slackStreamingHandler: SlackStreamingCallbackHandler | undefined;
}

export interface ErrorNotificationContext {
  linearHandler: LinearCallbackHandler | undefined;
  slackStreamingHandler: SlackStreamingCallbackHandler | undefined;
}

@Injectable()
export class RunSourceNotifier {
  private readonly logger = new Logger(RunSourceNotifier.name);

  constructor(private readonly telegramService: TelegramService) {}

  async notifySuccess(
    run: Run,
    ctx: SuccessNotificationContext,
  ): Promise<void> {
    const { linearHandler, assistantMessageHandler, slackStreamingHandler } =
      ctx;

    if (linearHandler) {
      await this.emitSafe('Failed to emit success response to Linear', () =>
        linearHandler.emitResponse(
          linearHandler.getLastAssistantMessage() ?? 'Completed.',
        ),
      );
    }

    if (run.source === 'telegram' && run.externalSessionId && run.triggerName) {
      await this.emitSafe('Failed to emit Telegram reply', () =>
        this.telegramService.emitRunResponse(
          run.triggerName!,
          run.externalSessionId!,
          assistantMessageHandler?.getLastAssistantMessage() ?? 'Completed.',
        ),
      );
    }

    if (slackStreamingHandler) {
      await this.emitSafe('Failed to emit Slack reply', () =>
        slackStreamingHandler.finalize(),
      );
    }
  }

  async notifyError(run: Run, ctx: ErrorNotificationContext): Promise<void> {
    const { linearHandler, slackStreamingHandler } = ctx;

    if (linearHandler) {
      await this.emitSafe('Failed to emit error to Linear', () =>
        linearHandler.emitError(run.errorMessage!),
      );
    }

    if (run.source === 'telegram' && run.externalSessionId && run.triggerName) {
      await this.emitSafe('Failed to emit Telegram reply', () =>
        this.telegramService.emitRunError(
          run.triggerName!,
          run.externalSessionId!,
          run.errorMessage!,
        ),
      );
    }

    if (slackStreamingHandler) {
      await this.emitSafe('Failed to emit Slack reply', () =>
        slackStreamingHandler.emitError(run.errorMessage!),
      );
    }
  }

  private async emitSafe(
    label: string,
    action: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.logger.error(label, { error: error as Error });
    }
  }
}
