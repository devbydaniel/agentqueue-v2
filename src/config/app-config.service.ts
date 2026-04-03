import { Injectable, Logger } from '@nestjs/common';

/**
 * Centralized, typed access to all environment variables.
 * Injected globally — never read `process.env` directly in services.
 */
@Injectable()
export class AppConfigService {
  private readonly logger = new Logger(AppConfigService.name);

  // ── Server ───────────────────────────────────────────────────────

  get port(): number {
    return Number(process.env.PORT ?? 3000);
  }

  // ── Auth ─────────────────────────────────────────────────────────

  get authToken(): string {
    const token = process.env.AUTH_TOKEN;
    if (!token) {
      throw new Error('AUTH_TOKEN environment variable is required');
    }
    return token;
  }

  // ── GitHub ───────────────────────────────────────────────────────

  get githubWebhookSecret(): string | undefined {
    return process.env.GITHUB_WEBHOOK_SECRET;
  }

  // ── Langfuse ─────────────────────────────────────────────────────

  get langfuseEnabled(): boolean {
    return !!process.env.LANGFUSE_SECRET_KEY;
  }
}
