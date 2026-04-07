import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { TriggerConfigService } from '../triggers/trigger-config.service.js';
import { interpolateTemplate } from '../triggers/trigger-config.interface.js';
import { AgentfilesConfigService } from '../config/agentfiles-config.service.js';
import { RunsService } from '../runs/runs.service.js';
import { LinearCallbackHandler } from '../callbacks/handlers/linear.callback-handler.js';
import { LinearWebhookParserService } from './linear-webhook-parser.service.js';

export interface HandleLinearWebhookParams {
  agentName: string;
  rawBody: Buffer | undefined;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  body: Record<string, unknown>;
}

/**
 * Handles inbound Linear Agent Interaction webhooks end-to-end:
 *  1. Looks up the Linear trigger config for the route's agent name
 *  2. Verifies signature + timestamp
 *  3. Parses the payload
 *  4. Either aborts an in-flight session (stop signal) or dispatches a fresh
 *     agent run via `RunsService` (fire-and-forget) with a `LinearCallbackHandler`
 *     attached to stream events back to Linear.
 *
 * Returns synchronously after dispatch — the caller (controller) can return
 * 200 immediately.
 */
@Injectable()
export class LinearWebhooksService {
  private readonly logger = new Logger(LinearWebhooksService.name);

  constructor(
    private readonly triggerConfigService: TriggerConfigService,
    private readonly linearWebhookParserService: LinearWebhookParserService,
    private readonly agentfilesConfigService: AgentfilesConfigService,
    private readonly runsService: RunsService,
  ) {}

  handleWebhook(params: HandleLinearWebhookParams): void {
    // 1. Get linear trigger config for this agent
    const linearConfig = this.triggerConfigService.getLinearTrigger(
      params.agentName,
    );
    if (!linearConfig) {
      throw new NotFoundException(
        `Linear webhook not configured for agent '${params.agentName}'`,
      );
    }

    // 2. Verify signature
    if (!params.rawBody || !params.signatureHeader) {
      throw new UnauthorizedException('Missing signature or raw body');
    }

    if (
      !this.linearWebhookParserService.verifySignature(
        params.rawBody,
        params.signatureHeader,
        linearConfig.signing_secret,
      )
    ) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // 3. Verify timestamp (from header or body)
    const webhookTimestamp =
      (params.timestampHeader ? Number(params.timestampHeader) : undefined) ??
      (params.body['webhookTimestamp'] as number | undefined);
    if (
      !webhookTimestamp ||
      !this.linearWebhookParserService.verifyTimestamp(webhookTimestamp)
    ) {
      throw new UnauthorizedException('Stale webhook timestamp');
    }

    // 4. Parse payload (throws BadRequestException on malformed input)
    const payload = this.linearWebhookParserService.parsePayload(params.body);
    this.logger.log('Linear webhook received', {
      agentName: params.agentName,
      action: payload.action,
      agentSessionId: payload.agentSessionId,
      signal: payload.signal ?? 'none',
    });

    // 5. Handle stop signal — abort running session immediately
    if (payload.signal === 'stop') {
      this.logger.log('Received stop signal, aborting session', {
        agentSessionId: payload.agentSessionId,
      });
      const linearClient = this.linearWebhookParserService.createLinearClient(
        linearConfig.api_key,
      );
      const linearHandler = new LinearCallbackHandler(
        payload.agentSessionId,
        linearClient,
      );

      void this.runsService
        .abortSession(payload.agentSessionId)
        .then(async (aborted) => {
          const message = aborted
            ? 'Agent stopped by user request.'
            : 'No active session found to stop.';
          await linearHandler.emitResponse(message);
        })
        .catch((error: unknown) => {
          this.logger.error('Failed to abort session', {
            error: error as Error,
          });
        });

      return;
    }

    // 6. Resolve repo from target
    const repo = linearConfig.target;
    this.agentfilesConfigService.resolveRepo(repo); // throws RepoNotFoundError if not found

    // 7. Build prompt
    const prompt =
      payload.action === 'created'
        ? payload.promptContext!
        : payload.agentActivityBody!;

    // 8. Create LinearCallbackHandler
    const linearClient = this.linearWebhookParserService.createLinearClient(
      linearConfig.api_key,
    );
    const linearHandler = new LinearCallbackHandler(
      payload.agentSessionId,
      linearClient,
    );

    // 9. Interpolate system prompt templates
    const templateVars = {
      issueId: payload.issueId ?? '',
      agentSessionId: payload.agentSessionId,
      action: payload.action,
      agentName: params.agentName,
      target: repo,
    };

    const prependSystemPrompt = linearConfig.prepend_system_prompt
      ? interpolateTemplate(linearConfig.prepend_system_prompt, templateVars)
      : undefined;
    const appendSystemPrompt = linearConfig.append_system_prompt
      ? interpolateTemplate(linearConfig.append_system_prompt, templateVars)
      : undefined;

    // 10. Fire run in background
    this.logger.log('Firing async agent run from Linear webhook', {
      agentName: params.agentName,
      action: payload.action,
      agentSessionId: payload.agentSessionId,
    });

    void this.runsService
      .execute({
        repo,
        prompt,
        sessionKey: payload.agentSessionId,
        additionalHandlers: [linearHandler],
        prependSystemPrompt,
        appendSystemPrompt,
      })
      .then(async () => {
        const message = linearHandler.getLastAssistantMessage() ?? 'Completed.';
        await linearHandler.emitResponse(message);
      })
      .catch(async (error: unknown) => {
        this.logger.error('Agent run from Linear webhook failed', {
          error: error as Error,
          agentName: params.agentName,
          agentSessionId: payload.agentSessionId,
        });
        try {
          await linearHandler.emitError(
            error instanceof Error ? error.message : 'Agent run failed',
          );
        } catch (emitErr) {
          this.logger.error('Failed to emit error to Linear', {
            error: emitErr as Error,
          });
        }
      });
  }
}
