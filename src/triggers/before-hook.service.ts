import { Injectable, Logger } from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { AppConfigService } from '../config/app-config.service.js';

// POSIX guarantees /bin/sh exists; using an absolute path avoids PATH lookup
// (sonarjs/no-os-command-from-path).
const SHELL_PATH = '/bin/sh';

const SKIP: BeforeHookResult = { proceed: false, output: '' };

export interface BeforeHookResult {
  proceed: boolean;
  output: string;
}

interface ExitContext {
  code: number | null;
  killed: boolean;
  stdout: string;
  stderr: string;
  label: string;
  timeout: number;
}

/**
 * Runs the optional `before` shell command attached to a trigger.
 *
 * Contract (matches the v1 agentqueue processor):
 * - Exit 0          → `{ proceed: true, output: <trimmed stdout> }`
 * - Non-zero exit   → `{ proceed: false, output: '' }`     (skip the run)
 * - Timeout         → `{ proceed: false, output: '' }`     (skip the run)
 * - Spawn error     → `{ proceed: false, output: '' }`     (skip the run)
 *
 * The hook is executed via `/bin/sh -c <command>`, so it can be a path to a
 * script, an inline shell expression, or a chain of commands.
 */
@Injectable()
export class BeforeHookService {
  private readonly logger = new Logger(BeforeHookService.name);

  constructor(private readonly appConfig: AppConfigService) {}

  run(command: string, label: string): Promise<BeforeHookResult> {
    const timeout = this.appConfig.beforeHookTimeout;
    const child = spawn(SHELL_PATH, ['-c', command], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end();
    return this.collectResult(child, label, timeout);
  }

  private collectResult(
    child: ChildProcess,
    label: string,
    timeout: number,
  ): Promise<BeforeHookResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;
      let settled = false;

      const settle = (result: BeforeHookResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      child.stdout!.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const timer =
        timeout > 0
          ? setTimeout(() => {
              killed = true;
              child.kill('SIGTERM');
            }, timeout)
          : undefined;

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        this.logger.warn(
          `Before hook failed to spawn for ${label}: ${err.message}`,
        );
        settle(SKIP);
      });

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        settle(
          this.interpretExit({ code, killed, stdout, stderr, label, timeout }),
        );
      });
    });
  }

  private interpretExit(ctx: ExitContext): BeforeHookResult {
    if (ctx.killed) {
      this.logger.warn(
        `Before hook for ${ctx.label} timed out after ${ctx.timeout}ms`,
      );
      return SKIP;
    }
    if (ctx.code === 0) {
      return { proceed: true, output: ctx.stdout.trim() };
    }
    this.logger.log(
      `Before hook for ${ctx.label} exited with code ${ctx.code ?? 'null'}${
        ctx.stderr ? ': ' + ctx.stderr.trim() : ''
      }`,
    );
    return SKIP;
  }
}
