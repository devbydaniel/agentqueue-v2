import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { TriggerConfigService } from '../config/trigger-config.service.js';
import { interpolateTemplate } from '../config/trigger-config.interface.js';
import type { LinearTrigger } from '../config/trigger-config.interface.js';
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
 *  1. Looks up the Linear trigger config(s) for the route's agent name
 *  2. Verifies signature + timestamp
 *  3. Parses the payload
 *  4. Either aborts an in-flight session (stop signal) or enqueues a fresh
 *     agent run via `RunsService` (fire-and-forget). Callback handling
 *     (streaming events back to Linear) is delegated to `RunProcessorService`.
 *
 * Supports multiple triggers sharing the same name (webhook endpoint)
 * with different `on` event filters (assigned / mentioned).
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
    // 1. Get all linear trigger configs for this webhook endpoint
    const triggers = this.triggerConfigService.getLinearTriggersByName(
      params.agentName,
    );
    if (triggers.length === 0) {
      throw new NotFoundException(
        `Linear webhook not configured for agent '${params.agentName}'`,
      );
    }

    // 2. Verify signature (all triggers sharing a name have the same signing_secret)
    const firstTrigger = triggers[0];
    if (!params.rawBody || !params.signatureHeader) {
      throw new UnauthorizedException('Missing signature or raw body');
    }

    if (
      !this.linearWebhookParserService.verifySignature(
        params.rawBody,
        params.signatureHeader,
        firstTrigger.signing_secret,
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
      eventType: payload.eventType ?? 'n/a',
      signal: payload.signal ?? 'none',
    });

    // 5. Handle stop signal — abort running session immediately
    if (payload.signal === 'stop') {
      this.handleStopSignal(payload.agentSessionId, firstTrigger);
      return;
    }

    // 6. Route based on action type
    if (payload.action === 'created') {
      this.handleCreated(params.agentName, triggers, payload);
    } else if (payload.action === 'prompted') {
      this.handlePrompted(params.agentName, triggers, payload);
    } else {
      this.logger.warn('Unhandled Linear webhook action', {
        action: payload.action,
        agentSessionId: payload.agentSessionId,
      });
    }
  }

  private handleStopSignal(
    agentSessionId: string,
    trigger: LinearTrigger,
  ): void {
    this.logger.log('Received stop signal, aborting session', {
      agentSessionId,
    });
    const linearClient = this.linearWebhookParserService.createLinearClient(
      trigger.api_key,
    );
    const linearHandler = new LinearCallbackHandler(
      agentSessionId,
      linearClient,
    );

    try {
      const aborted = this.runsService.abortSession(agentSessionId);
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
  }

  private handleCreated(
    agentName: string,
    triggers: LinearTrigger[],
    payload: ReturnType<LinearWebhookParserService['parsePayload']>,
  ): void {
    // Filter triggers by event type
    const matching = triggers.filter(
      (t) => t.on === undefined || t.on === payload.eventType,
    );

    if (matching.length === 0) {
      this.logger.log('No matching Linear trigger for event type', {
        agentName,
        eventType: payload.eventType,
      });
      return;
    }

    for (const trigger of matching) {
      this.enqueueRun(trigger, payload, payload.promptContext ?? '');
    }
  }

  private handlePrompted(
    agentName: string,
    triggers: LinearTrigger[],
    payload: ReturnType<LinearWebhookParserService['parsePayload']>,
  ): void {
    // For follow-ups, resolve the original trigger that handled the "created" event
    void this.resolveAndEnqueuePrompted(agentName, triggers, payload).catch(
      (error: unknown) => {
        this.logger.error('Failed to handle prompted webhook', {
          error: error as Error,
          agentName,
          agentSessionId: payload.agentSessionId,
        });
      },
    );
  }

  private async resolveAndEnqueuePrompted(
    agentName: string,
    triggers: LinearTrigger[],
    payload: ReturnType<LinearWebhookParserService['parsePayload']>,
  ): Promise<void> {
    // Look up which trigger originally created the run for this session
    const originalTriggerKey =
      await this.runsService.findTriggerNameByExternalSessionId(
        payload.agentSessionId,
      );

    let trigger: LinearTrigger | undefined;
    if (originalTriggerKey) {
      trigger =
        this.triggerConfigService.getLinearTriggerByKey(originalTriggerKey);
    }

    if (!trigger) {
      // Fallback: use the first trigger for this endpoint
      this.logger.warn(
        'Could not resolve original trigger for prompted session, falling back to first trigger',
        { agentName, agentSessionId: payload.agentSessionId },
      );
      trigger = triggers[0];
    }

    this.enqueueRun(trigger, payload, payload.agentActivityBody ?? '');
  }

  private enqueueRun(
    trigger: LinearTrigger,
    payload: ReturnType<LinearWebhookParserService['parsePayload']>,
    prompt: string,
  ): void {
    const cwd = ensureDirectoryExists(trigger.cwd, 'linear trigger cwd');

    const templateVars = {
      issueId: payload.issueId ?? '',
      agentSessionId: payload.agentSessionId,
      action: payload.action,
      eventType: payload.eventType ?? '',
      agentName: trigger.name,
      cwd,
    };

    const appendSystemPrompt = trigger.append_system_prompt
      ? interpolateTemplate(trigger.append_system_prompt, templateVars)
      : undefined;

    const key = TriggerConfigService.triggerKey(trigger);
    this.logger.log('Enqueueing agent run from Linear webhook', {
      triggerKey: key,
      action: payload.action,
      eventType: payload.eventType ?? 'n/a',
      agentSessionId: payload.agentSessionId,
    });

    void this.runsService
      .enqueue({
        source: 'linear',
        triggerName: key,
        cwd,
        prompt,
        externalSessionId: payload.agentSessionId,
        appendSystemPrompt,
        timeoutMs: trigger.timeout_ms,
      })
      .catch((error: unknown) => {
        this.logger.error('Failed to enqueue Linear agent run', {
          error: error as Error,
          triggerKey: key,
          agentSessionId: payload.agentSessionId,
        });
      });
  }
}
