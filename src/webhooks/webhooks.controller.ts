import {
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TriggerConfigService } from '../triggers/trigger-config.service.js';
import { AgentfilesConfigService } from '../config/agentfiles-config.service.js';
import { ExecuteRunUseCase } from '../runs/application/execute-run.use-case.js';
import { LinearWebhookService } from './linear-webhook.service.js';
import { LinearCallbackHandler } from '../callbacks/handlers/linear.callback-handler.js';
import {
  WebhookNotEnabledError,
  WebhookSignatureError,
} from './webhooks.errors.js';

interface RawBodyRequest {
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly triggerConfigService: TriggerConfigService,
    private readonly agentfilesConfigService: AgentfilesConfigService,
    private readonly linearWebhookService: LinearWebhookService,
    private readonly executeRunUseCase: ExecuteRunUseCase,
  ) {}

  @Get('linear/:agentName')
  @HttpCode(200)
  @ApiOperation({ summary: 'Webhook URL verification' })
  @ApiResponse({ status: 200, description: 'URL is valid' })
  verifyLinearWebhook(): { ok: boolean } {
    return { ok: true };
  }

  @Post('linear/:agentName')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Receive Linear Agent Interaction webhooks',
    description:
      'Verifies the webhook signature, parses the payload, and fires an agent run in the background. Returns 200 immediately.',
  })
  @ApiResponse({ status: 200, description: 'Webhook accepted' })
  @ApiResponse({ status: 400, description: 'Malformed payload' })
  @ApiResponse({
    status: 401,
    description: 'Invalid signature or stale timestamp',
  })
  @ApiResponse({
    status: 404,
    description: 'Linear not configured or agent not found',
  })
  handleLinearWebhook(
    @Param('agentName') agentName: string,
    @Req() req: RawBodyRequest,
  ): { accepted: boolean } {
    // 1. Get linear trigger config for this agent
    const linearConfig = this.triggerConfigService.getLinearTrigger(agentName);
    if (!linearConfig) {
      throw new WebhookNotEnabledError(agentName);
    }

    // 2. Verify signature
    const rawBody = req.rawBody;
    const signature = req.headers['linear-signature'] as string | undefined;
    if (!rawBody || !signature) {
      throw new WebhookSignatureError('Missing signature or raw body');
    }

    if (
      !this.linearWebhookService.verifySignature(
        rawBody,
        signature,
        linearConfig.signing_secret,
      )
    ) {
      throw new WebhookSignatureError();
    }

    // 3. Verify timestamp (from header or body)
    const body = req.body as Record<string, unknown>;
    const timestampHeader = req.headers['linear-timestamp'] as
      | string
      | undefined;
    const webhookTimestamp =
      (timestampHeader ? Number(timestampHeader) : undefined) ??
      (body['webhookTimestamp'] as number | undefined);
    if (
      !webhookTimestamp ||
      !this.linearWebhookService.verifyTimestamp(webhookTimestamp)
    ) {
      throw new WebhookSignatureError('Stale webhook timestamp');
    }

    // 4. Parse payload
    const payload = this.linearWebhookService.parsePayload(body);
    this.logger.log('Linear webhook received', {
      agentName,
      action: payload.action,
      agentSessionId: payload.agentSessionId,
      signal: payload.signal ?? 'none',
    });

    // 5. Handle stop signal — abort running session immediately
    if (payload.signal === 'stop') {
      this.logger.log('Received stop signal, aborting session', {
        agentSessionId: payload.agentSessionId,
      });
      const linearClient = this.linearWebhookService.createLinearClient(
        linearConfig.api_key,
      );
      const linearHandler = new LinearCallbackHandler(
        payload.agentSessionId,
        linearClient,
      );

      void this.executeRunUseCase
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

      return { accepted: true };
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
    const linearClient = this.linearWebhookService.createLinearClient(
      linearConfig.api_key,
    );
    const linearHandler = new LinearCallbackHandler(
      payload.agentSessionId,
      linearClient,
    );

    // 9. Fire run in background
    this.logger.log('Firing async agent run from Linear webhook', {
      agentName,
      action: payload.action,
      agentSessionId: payload.agentSessionId,
    });

    void this.executeRunUseCase
      .execute({
        repo,
        prompt,
        sessionKey: payload.agentSessionId,
        additionalHandlers: [linearHandler],
      })
      .then(async () => {
        await linearHandler.emitResponse('Completed.');
      })
      .catch(async (error: unknown) => {
        this.logger.error('Agent run from Linear webhook failed', {
          error: error as Error,
          agentName,
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

    // 10. Return 200 immediately
    return { accepted: true };
  }
}
