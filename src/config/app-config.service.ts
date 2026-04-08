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

  // ── Hooks ────────────────────────────────────────────────────────

  get beforeHookTimeout(): number {
    return Number(process.env.BEFORE_HOOK_TIMEOUT ?? 30000);
  }

  // ── Database ─────────────────────────────────────────────────────

  get databaseUrl(): string {
    const url = process.env.DATABASE_URL;
    if (!url) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('DATABASE_URL environment variable is required');
      }
      return 'postgres://agentqueue:agentqueue@localhost:5433/agentqueue';
    }
    return url;
  }

  // ── Queue ────────────────────────────────────────────────────────

  // Used in step 5 when registering queue workers
  get queueConcurrency(): number {
    return Number(process.env.QUEUE_CONCURRENCY ?? 5);
  }

  // Used in step 5 when registering queue workers
  get queueRetryLimit(): number {
    return Number(process.env.QUEUE_RETRY_LIMIT ?? 3);
  }

  // ── Runs ─────────────────────────────────────────────────────────

  /** Default per-run timeout in milliseconds (default: 30 minutes) */
  get runTimeoutMs(): number {
    const defaultMs = 30 * 60 * 1000;
    const raw = process.env.RUN_TIMEOUT_MS;
    if (raw === undefined || raw === '') return defaultMs;
    const parsed = Number(raw);
    if (isNaN(parsed) || parsed <= 0) {
      this.logger.warn(
        `Invalid RUN_TIMEOUT_MS value "${raw}", falling back to default (${defaultMs}ms)`,
      );
      return defaultMs;
    }
    return parsed;
  }

  // ── Langfuse ─────────────────────────────────────────────────────

  get langfuseEnabled(): boolean {
    return !!process.env.LANGFUSE_SECRET_KEY;
  }
}
