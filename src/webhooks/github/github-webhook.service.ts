import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppConfigService } from '../../config/app-config.service.js';
import type { GithubTrigger } from '../../triggers/trigger-config.interface.js';
import { TriggerConfigService } from '../../triggers/trigger-config.service.js';
import { AgentfilesConfigService } from '../../config/agentfiles-config.service.js';
import { ExecuteRunUseCase } from '../../runs/application/execute-run.use-case.js';
import { matchesFilters } from './webhook-filter.js';
import { interpolatePayloadTemplate } from './payload-template.js';
import { WebhookSignatureError } from '../webhooks.errors.js';

const MAX_PROMPT_LENGTH = 50_000;

@Injectable()
export class GithubWebhookService {
  private readonly logger = new Logger(GithubWebhookService.name);

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly triggerConfigService: TriggerConfigService,
    private readonly agentfilesConfigService: AgentfilesConfigService,
    private readonly executeRunUseCase: ExecuteRunUseCase,
  ) {}

  /**
   * Verify the GitHub HMAC-SHA256 signature (`x-hub-signature-256` header).
   * Throws WebhookSignatureError on failure.
   */
  verifySignature(rawBody: Buffer, signatureHeader: string): void {
    const secret = this.appConfig.githubWebhookSecret;
    if (!secret) {
      throw new WebhookSignatureError(
        'GITHUB_WEBHOOK_SECRET is not configured',
      );
    }

    if (!signatureHeader) {
      throw new WebhookSignatureError('Missing x-hub-signature-256 header');
    }

    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;

    const sigBuffer = Buffer.from(signatureHeader);
    const expectedBuffer = Buffer.from(expected);

    if (
      sigBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(sigBuffer, expectedBuffer)
    ) {
      throw new WebhookSignatureError();
    }
  }

  /**
   * Find all GitHub triggers that match the event type and payload,
   * then fire agent runs in the background.
   *
   * Returns the number of triggered runs.
   */
  handleEvent(
    eventType: string,
    payload: Record<string, unknown>,
  ): { triggered: number } {
    const triggers = this.triggerConfigService.getGithubTriggers();

    const matching = triggers.filter(
      (t) => t.events.includes(eventType) && matchesFilters(payload, t.filters),
    );

    if (matching.length === 0) {
      this.logger.debug(`No GitHub triggers matched event="${eventType}"`);
      return { triggered: 0 };
    }

    for (const trigger of matching) {
      this.fireRun(trigger, payload);
    }

    return { triggered: matching.length };
  }

  private fireRun(
    trigger: GithubTrigger,
    payload: Record<string, unknown>,
  ): void {
    const repo = interpolatePayloadTemplate(trigger.target, payload);
    const prompt = interpolatePayloadTemplate(trigger.prompt, payload);

    if (prompt.length > MAX_PROMPT_LENGTH) {
      this.logger.warn(
        `Prompt for trigger "${trigger.name}" exceeds ${MAX_PROMPT_LENGTH} chars, skipping`,
      );
      return;
    }

    // Validate repo exists before firing
    try {
      this.agentfilesConfigService.resolveRepo(repo);
    } catch {
      this.logger.warn(
        `Trigger "${trigger.name}" resolved target "${repo}" which is not a configured repo, skipping`,
      );
      return;
    }

    const prependSystemPrompt = trigger.prepend_system_prompt
      ? interpolatePayloadTemplate(trigger.prepend_system_prompt, payload)
      : undefined;
    const appendSystemPrompt = trigger.append_system_prompt
      ? interpolatePayloadTemplate(trigger.append_system_prompt, payload)
      : undefined;

    this.logger.log(`Firing run for GitHub trigger "${trigger.name}"`, {
      repo,
      event: payload['action'],
    });

    void this.executeRunUseCase
      .execute({
        repo,
        prompt,
        prependSystemPrompt,
        appendSystemPrompt,
      })
      .then(() => {
        this.logger.log(`Run completed for GitHub trigger "${trigger.name}"`);
      })
      .catch((error: unknown) => {
        this.logger.error(`Run failed for GitHub trigger "${trigger.name}"`, {
          error: error as Error,
        });
      });
  }
}
