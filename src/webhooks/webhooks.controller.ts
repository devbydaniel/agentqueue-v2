import { Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator.js';
import { LinearWebhooksService } from './linear-webhooks.service.js';
import { GithubWebhooksService } from './github-webhooks.service.js';
import { TelegramWebhooksService } from './telegram-webhooks.service.js';

interface RawBodyRequest {
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

@Public()
@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly linearWebhooksService: LinearWebhooksService,
    private readonly githubWebhooksService: GithubWebhooksService,
    private readonly telegramWebhooksService: TelegramWebhooksService,
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
    this.linearWebhooksService.handleWebhook({
      agentName,
      rawBody: req.rawBody,
      signatureHeader: req.headers['linear-signature'] as string | undefined,
      timestampHeader: req.headers['linear-timestamp'] as string | undefined,
      body: req.body as Record<string, unknown>,
    });
    return { accepted: true };
  }

  @Post('github')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Receive GitHub webhooks',
    description:
      'Verifies the webhook signature, matches against configured GitHub triggers, and fires agent runs for matching triggers.',
  })
  @ApiResponse({ status: 200, description: 'Webhook processed' })
  @ApiResponse({ status: 401, description: 'Invalid signature' })
  handleGithubWebhook(@Req() req: RawBodyRequest): {
    accepted: boolean;
    triggered: number;
  } {
    const result = this.githubWebhooksService.handleWebhook({
      rawBody: req.rawBody,
      signatureHeader: req.headers['x-hub-signature-256'] as string | undefined,
      eventType:
        (req.headers['x-github-event'] as string | undefined) ?? 'unknown',
      body: req.body as Record<string, unknown>,
    });
    return { accepted: true, triggered: result.triggered };
  }

  @Post('telegram/:botName')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Receive Telegram bot webhooks',
    description:
      'Verifies the Telegram secret token, routes the inbound message by configured sender/chat rules, and enqueues a background agent run.',
  })
  @ApiResponse({ status: 200, description: 'Webhook processed' })
  @ApiResponse({ status: 401, description: 'Invalid Telegram webhook secret' })
  @ApiResponse({
    status: 404,
    description: 'Telegram bot is not configured',
  })
  async handleTelegramWebhook(
    @Param('botName') botName: string,
    @Req() req: RawBodyRequest,
  ): Promise<{ accepted: boolean; handled: boolean }> {
    return this.telegramWebhooksService.handleWebhook({
      botName,
      secretTokenHeader: req.headers['x-telegram-bot-api-secret-token'] as
        | string
        | undefined,
      body: req.body as Record<string, unknown>,
    });
  }
}
