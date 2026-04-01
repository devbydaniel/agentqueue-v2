import { Controller, HttpCode, Logger, Param, Post, Req } from '@nestjs/common';
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
    // 1. Get linear trigger config
    const linearConfig = this.triggerConfigService.getLinearTrigger();
    if (!linearConfig) {
      throw new WebhookNotEnabledError();
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

    // 3. Verify timestamp
    const body = req.body as Record<string, unknown>;
    const webhookTimestamp = body['webhookTimestamp'] as number | undefined;
    if (
      !webhookTimestamp ||
      !this.linearWebhookService.verifyTimestamp(webhookTimestamp)
    ) {
      throw new WebhookSignatureError('Stale webhook timestamp');
    }

    // 4. Parse payload
    const payload = this.linearWebhookService.parsePayload(body);

    // 5. Resolve repo from agentName
    const repo = agentName;
    this.agentfilesConfigService.resolveRepo(repo); // throws RepoNotFoundError if not found

    // 6. Build prompt
    const prompt =
      payload.action === 'created'
        ? payload.promptContext!
        : payload.agentActivityBody!;

    // 7. Create LinearCallbackHandler
    const linearClient = this.linearWebhookService.createLinearClient(
      linearConfig.api_key,
    );
    const linearHandler = new LinearCallbackHandler(
      payload.agentSessionId,
      linearClient,
    );

    // 8. Fire run in background
    this.logger.log('Firing async agent run from Linear webhook', {
      agentName,
      action: payload.action,
      agentSessionId: payload.agentSessionId,
    });

    void this.executeRunUseCase
      .execute({
        repo,
        prompt,
        additionalHandlers: [linearHandler],
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

    // 9. Return 200 immediately
    return { accepted: true };
  }
}
