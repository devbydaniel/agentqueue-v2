import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { TriggerConfigService } from '../config/trigger-config.service.js';
import { interpolateTemplate } from '../config/trigger-config.interface.js';
import { RunsService } from '../runs/runs.service.js';
import { LinearCallbackHandler } from '../callbacks/handlers/linear.callback-handler.js';
import { LinearWebhookParserService } from './linear-webhook-parser.service.js';
import { ensureDirectoryExists } from '../common/utils/cwd-path.js';

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
 *  4. Either aborts an in-flight session (stop signal) or enqueues a fresh
 *     agent run via `RunsService` (fire-and-forget). Callback handling
 *     (streaming events back to Linear) is delegated to `RunProcessorService`.
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

      try {
        const aborted = this.runsService.abortSession(payload.agentSessionId);
        const message = aborted
          ? 'Agent stopped by user request.'
          : 'No active session found to stop.';
        void linearHandler.emitResponse(message).catch((error: unknown) => {
          this.logger.error('Failed to emit stop response to Linear', {
            error: error as Error,
          });
        });
      } catch (error) {
        this.logger.error('Failed to abort session', {
          error: error as Error,
        });
      }

      return;
    }

    // 6. Resolve cwd from config
    const cwd = ensureDirectoryExists(linearConfig.cwd, 'linear trigger cwd');

    // 7. Build prompt
    const prompt =
      payload.action === 'created'
        ? payload.promptContext!
        : payload.agentActivityBody!;

    // 8. Interpolate system prompt templates
    const templateVars = {
      issueId: payload.issueId ?? '',
      agentSessionId: payload.agentSessionId,
      action: payload.action,
      agentName: params.agentName,
      cwd,
    };

    const appendSystemPrompt = linearConfig.append_system_prompt
      ? interpolateTemplate(linearConfig.append_system_prompt, templateVars)
      : undefined;

    // 9. Enqueue run (processing + Linear callback handled by RunProcessorService)
    this.logger.log('Enqueueing agent run from Linear webhook', {
      agentName: params.agentName,
      action: payload.action,
      agentSessionId: payload.agentSessionId,
    });

    void this.runsService
      .enqueue({
        source: 'linear',
        triggerName: params.agentName,
        cwd,
        prompt,
        externalSessionId: payload.agentSessionId,
        appendSystemPrompt,
        timeoutMs: linearConfig.timeout_ms,
      })
      .catch((error: unknown) => {
        this.logger.error('Failed to enqueue Linear agent run', {
          error: error as Error,
          agentName: params.agentName,
          agentSessionId: payload.agentSessionId,
        });
      });
  }
}
