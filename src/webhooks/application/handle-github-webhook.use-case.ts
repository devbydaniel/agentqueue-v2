import { Injectable, Logger } from '@nestjs/common';
import { ApplicationError } from '../../common/errors/base.error.js';
import { TriggerConfigService } from '../../triggers/trigger-config.service.js';
import { matchesFilters } from '../infrastructure/github/webhook-filter.js';
import { FireGithubTriggerUseCase } from './fire-github-trigger.use-case.js';
import { UnexpectedWebhookError } from './webhooks.errors.js';

export interface HandleGithubWebhookCommand {
  eventType: string;
  payload: Record<string, unknown>;
}

export interface HandleGithubWebhookResult {
  triggered: number;
}

/**
 * Handles a verified GitHub webhook event: looks up matching triggers from
 * the trigger config, and dispatches each one via `FireGithubTriggerUseCase`
 * (fire-and-forget). Returns the number of triggers that matched.
 *
 * Signature verification is handled separately by `GithubSignatureVerifierService`
 * before this use case is called.
 */
@Injectable()
export class HandleGithubWebhookUseCase {
  private readonly logger = new Logger(HandleGithubWebhookUseCase.name);

  constructor(
    private readonly triggerConfigService: TriggerConfigService,
    private readonly fireGithubTriggerUseCase: FireGithubTriggerUseCase,
  ) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- async signature for use-case consistency; matching is sync, fires are fire-and-forget
  async execute(
    command: HandleGithubWebhookCommand,
  ): Promise<HandleGithubWebhookResult> {
    this.logger.log('Handling GitHub webhook event', {
      eventType: command.eventType,
    });

    try {
      const triggers = this.triggerConfigService.getGithubTriggers();
      const matching = triggers.filter(
        (t) =>
          t.events.includes(command.eventType) &&
          matchesFilters(command.payload, t.filters),
      );

      if (matching.length === 0) {
        this.logger.debug(
          `No GitHub triggers matched event="${command.eventType}"`,
        );
        return { triggered: 0 };
      }

      // Fire each matching trigger (fire-and-forget — failures are logged
      // but do not affect other triggers or the webhook response).
      for (const trigger of matching) {
        void this.fireGithubTriggerUseCase
          .execute({ trigger, payload: command.payload })
          .catch((error: unknown) => {
            this.logger.error(
              `Failed to fire GitHub trigger "${trigger.name}"`,
              { error: error as Error },
            );
          });
      }

      return { triggered: matching.length };
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      this.logger.error('Error handling GitHub webhook', {
        error: error as Error,
      });
      throw new UnexpectedWebhookError(error);
    }
  }
}
