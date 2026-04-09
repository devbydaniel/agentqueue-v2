import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { TriggerConfigService } from '../config/trigger-config.service.js';
import { RunsService } from '../runs/runs.service.js';
import { BeforeHookService } from '../triggers/before-hook.service.js';
import type { GithubTrigger } from '../config/trigger-config.interface.js';
import { GithubSignatureVerifierService } from './github-signature-verifier.service.js';
import { interpolatePayloadTemplate } from './github-payload-template.js';
import { matchesFilters } from './github-webhook-filter.js';
import { ensureDirectoryExists } from '../common/utils/cwd-path.js';

const MAX_PROMPT_LENGTH = 50_000;

export interface HandleGithubWebhookParams {
  rawBody: Buffer | undefined;
  signatureHeader: string | undefined;
  eventType: string;
  body: Record<string, unknown>;
}

export interface HandleGithubWebhookResult {
  triggered: number;
}

/**
 * Handles inbound GitHub webhooks end-to-end:
 *  1. Verifies the HMAC signature
 *  2. Looks up matching triggers from the trigger config
 *  3. For each match: interpolates cwd/prompt, runs the optional before-hook,
 *     and dispatches the agent run via `RunsService` (fire-and-forget)
 *
 * Returns the number of triggers that matched. Per-trigger failures are logged
 * but never bubble up — the webhook itself always succeeds as long as the
 * signature was valid.
 */
@Injectable()
export class GithubWebhooksService {
  private readonly logger = new Logger(GithubWebhooksService.name);

  constructor(
    private readonly signatureVerifier: GithubSignatureVerifierService,
    private readonly triggerConfigService: TriggerConfigService,
    private readonly runsService: RunsService,
    private readonly beforeHookService: BeforeHookService,
  ) {}

  handleWebhook(params: HandleGithubWebhookParams): HandleGithubWebhookResult {
    // 1. Verify signature
    if (!params.rawBody || !params.signatureHeader) {
      throw new UnauthorizedException('Missing signature or raw body');
    }
    this.signatureVerifier.verify(params.rawBody, params.signatureHeader);

    this.logger.log('GitHub webhook received', {
      event: params.eventType,
      action: params.body['action'],
      repository: (
        params.body['repository'] as Record<string, unknown> | undefined
      )?.['full_name'],
    });

    // 2. Match triggers
    const triggers = this.triggerConfigService.getGithubTriggers();
    const matching = triggers.filter(
      (t) =>
        t.events.includes(params.eventType) &&
        matchesFilters(params.body, t.filters),
    );

    if (matching.length === 0) {
      this.logger.debug(
        `No GitHub triggers matched event="${params.eventType}"`,
      );
      return { triggered: 0 };
    }

    // 3. Fire each matching trigger (fire-and-forget — failures are logged
    //    but do not affect other triggers or the webhook response).
    for (const trigger of matching) {
      void this.fireTrigger(trigger, params.body).catch((error: unknown) => {
        this.logger.error(`Failed to fire GitHub trigger "${trigger.name}"`, {
          error: error as Error,
        });
      });
    }

    return { triggered: matching.length };
  }

  /**
   * Fires a single GitHub trigger: interpolates cwd/prompt, validates the
   * resolved path, runs the optional before-hook (gate + enrich), and
   * dispatches the agent run.
   *
   * Skip paths (prompt too long, invalid cwd, hook said skip) return
   * normally — they are expected business outcomes, not errors.
   */
  private async fireTrigger(
    trigger: GithubTrigger,
    payload: Record<string, unknown>,
  ): Promise<void> {
    this.logger.log('Firing GitHub trigger', { trigger: trigger.name });

    const rawCwd = interpolatePayloadTemplate(trigger.cwd, payload);
    let prompt = interpolatePayloadTemplate(trigger.prompt, payload);

    if (prompt.length > MAX_PROMPT_LENGTH) {
      this.logger.warn(
        `Prompt for trigger "${trigger.name}" exceeds ${MAX_PROMPT_LENGTH} chars, skipping`,
      );
      return;
    }

    let cwd: string;
    try {
      cwd = ensureDirectoryExists(rawCwd, `GitHub trigger "${trigger.name}" cwd`);
    } catch {
      this.logger.warn(
        `Trigger "${trigger.name}" resolved cwd "${rawCwd}" which is not a usable directory, skipping`,
      );
      return;
    }

    // Run the optional before hook (gate + enrich)
    if (trigger.before) {
      const hookResult = await this.beforeHookService.run(
        trigger.before,
        `github trigger "${trigger.name}"`,
      );
      if (!hookResult.proceed) {
        this.logger.log(
          `GitHub trigger "${trigger.name}" skipped by before hook`,
        );
        return;
      }
      prompt = prompt.replace(/\{\{before_output\}\}/g, hookResult.output);
    }

    const prependSystemPrompt = trigger.prepend_system_prompt
      ? interpolatePayloadTemplate(trigger.prepend_system_prompt, payload)
      : undefined;
    const appendSystemPrompt = trigger.append_system_prompt
      ? interpolatePayloadTemplate(trigger.append_system_prompt, payload)
      : undefined;

    this.logger.log(`Firing run for GitHub trigger "${trigger.name}"`, {
      cwd,
      event: payload['action'],
    });

    const { runId } = await this.runsService.enqueue({
      source: 'github',
      triggerName: trigger.name,
      cwd,
      prompt,
      prependSystemPrompt,
      appendSystemPrompt,
      timeoutMs: trigger.timeout_ms,
    });

    this.logger.log(`Run enqueued for GitHub trigger "${trigger.name}"`, {
      runId,
    });
  }
}
