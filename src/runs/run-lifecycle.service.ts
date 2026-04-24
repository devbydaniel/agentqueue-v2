import { Injectable, Logger } from '@nestjs/common';
import type { Run } from '../database/runs.schema.js';
import { AppConfigService } from '../config/app-config.service.js';
import { RunRepository } from './run.repository.js';
import { ExternalSessionRepository } from './external-session.repository.js';
import { RunCompletionNotifier } from './run-completion.notifier.js';

export interface TerminalErrorContext {
  isTimeout: boolean;
  timeoutMs: number;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  'errored',
  'aborted',
  'timed_out',
  'interrupted',
]);

@Injectable()
export class RunLifecycleService {
  private readonly logger = new Logger(RunLifecycleService.name);

  constructor(
    private readonly runRepository: RunRepository,
    private readonly externalSessionRepository: ExternalSessionRepository,
    private readonly runCompletionNotifier: RunCompletionNotifier,
    private readonly appConfigService: AppConfigService,
  ) {}

  async loadForProcessing(runId: string): Promise<Run | undefined> {
    const run = await this.runRepository.findById(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }
    if (run.status !== 'waiting') {
      this.logger.warn('Skipping non-waiting run', {
        runId,
        status: run.status,
      });
      return undefined;
    }
    return run;
  }

  resolveTimeoutMs(run: Run): number {
    return run.timeoutMs ?? this.appConfigService.runTimeoutMs;
  }

  async resolveResumeSessionId(
    externalSessionId: string | null,
  ): Promise<string | undefined> {
    if (!externalSessionId) return undefined;
    const sessionId =
      await this.externalSessionRepository.findSessionId(externalSessionId);
    return sessionId ?? undefined;
  }

  async markRunning(run: Run): Promise<void> {
    run.status = 'running';
    run.startedAt = new Date();
    run.attemptsMade = run.attemptsMade + 1;
    await this.runRepository.save(run);
  }

  async finalizeSuccess(
    run: Run,
    sessionId: string | undefined,
  ): Promise<void> {
    if (run.externalSessionId && sessionId) {
      await this.externalSessionRepository.upsertSession({
        provider: run.source as 'linear' | 'telegram' | 'slack',
        sessionKey: run.externalSessionId,
        sessionId,
      });
    }
    run.status = 'succeeded';
    run.completedAt = new Date();
    await this.runRepository.save(run);
    await this.runCompletionNotifier.notify(run.id);
  }

  async persistTerminalError(
    run: Run,
    error: unknown,
    ctx: TerminalErrorContext,
  ): Promise<void> {
    // Re-read run from DB to avoid overwriting a terminal state set by abort.
    const freshRun = await this.runRepository.findById(run.id);
    if (freshRun && TERMINAL_STATUSES.has(freshRun.status)) {
      this.logger.warn(
        'Skipping errored write — run already in terminal state',
        { runId: run.id, status: freshRun.status },
      );
      return;
    }

    if (ctx.isTimeout) {
      run.status = 'timed_out';
      run.errorMessage = `Run timed out after ${ctx.timeoutMs}ms`;
    } else {
      run.status = 'errored';
      run.errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
    }
    run.completedAt = new Date();
    try {
      await this.runRepository.save(run);
      await this.runCompletionNotifier.notify(run.id);
    } catch (saveErr) {
      this.logger.error('Failed to save errored run status', {
        runId: run.id,
        error: saveErr as Error,
      });
    }
  }
}
