import { Injectable, Logger } from '@nestjs/common';
import { ApplicationError } from '../../common/errors/base.error.js';
import { AgentfilesConfigService } from '../../config/agentfiles-config.service.js';
import { RunsService } from '../../runs/runs.service.js';
import { BeforeHookService } from '../../triggers/before-hook.service.js';
import type { GithubTrigger } from '../../triggers/trigger-config.interface.js';
import { interpolatePayloadTemplate } from '../infrastructure/github/payload-template.js';
import { UnexpectedWebhookError } from './webhooks.errors.js';

const MAX_PROMPT_LENGTH = 50_000;

export interface FireGithubTriggerCommand {
  trigger: GithubTrigger;
  payload: Record<string, unknown>;
}

/**
 * Fires a single GitHub trigger: interpolates target/prompt, validates the
 * resolved repo, runs the optional before-hook (gate + enrich), and dispatches
 * the agent run via `RunsService`.
 *
 * Skip paths (prompt too long, repo not configured, hook said skip) return
 * normally without throwing — they are expected business outcomes, not errors.
 * Genuine errors propagate as `UnexpectedWebhookError`.
 */
@Injectable()
export class FireGithubTriggerUseCase {
  private readonly logger = new Logger(FireGithubTriggerUseCase.name);

  constructor(
    private readonly agentfilesConfigService: AgentfilesConfigService,
    private readonly runsService: RunsService,
    private readonly beforeHookService: BeforeHookService,
  ) {}

  async execute(command: FireGithubTriggerCommand): Promise<void> {
    const { trigger, payload } = command;
    this.logger.log('Firing GitHub trigger', { trigger: trigger.name });

    try {
      const repo = interpolatePayloadTemplate(trigger.target, payload);
      let prompt = interpolatePayloadTemplate(trigger.prompt, payload);

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
        repo,
        event: payload['action'],
      });

      await this.runsService.execute({
        repo,
        prompt,
        prependSystemPrompt,
        appendSystemPrompt,
      });

      this.logger.log(`Run completed for GitHub trigger "${trigger.name}"`);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      this.logger.error(`Error firing GitHub trigger "${trigger.name}"`, {
        error: error as Error,
      });
      throw new UnexpectedWebhookError(error);
    }
  }
}
