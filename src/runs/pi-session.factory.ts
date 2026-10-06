import { Injectable, Logger } from '@nestjs/common';
import type {
  AgentSession,
  ExtensionAPI,
  SessionManager,
} from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };

// pi is ESM-only; this CommonJS build loads it with a dynamic import.
const loadPi = () => import('@earendil-works/pi-coding-agent');
type PiSdk = Awaited<ReturnType<typeof loadPi>>;

export interface CreatePiSessionOptions {
  cwd: string;
  /** The executing run's id — exposed to the session via env var + system prompt so child enqueues can set parentRunId */
  runId?: string;
  /** System prompt snippets appended to pi's base prompt (in order) */
  additionalSystemPrompts?: string[];
  /** pi session ID to resume */
  resumeSessionId?: string;
}

/**
 * Creates pi SDK sessions for queue runs. Model, thinking level, project
 * trust, and user extensions (phoenix, subagent) come from the agent-dir
 * settings (`~/.pi/agent`), so the parent session and the subagent CLI
 * children it spawns resolve them the same way.
 */
@Injectable()
export class PiSessionFactory {
  private readonly logger = new Logger(PiSessionFactory.name);

  async create(options: CreatePiSessionOptions): Promise<AgentSession> {
    const pi = await loadPi();
    const agentDir = pi.getAgentDir();

    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: options.cwd,
      agentDir,
      appendSystemPromptOverride: (base) => [
        ...base,
        ...this.collectSystemPromptParts(
          options.additionalSystemPrompts,
          options.runId,
        ),
      ],
      extensionFactories: options.runId
        ? [this.runIdBashExtension(pi, options.cwd, options.runId)]
        : [],
    });
    await resourceLoader.reload();

    const { session } = await pi.createAgentSession({
      cwd: options.cwd,
      agentDir,
      resourceLoader,
      sessionManager: this.openSessionManager(
        pi,
        options.cwd,
        options.resumeSessionId,
      ),
    });

    // Emits session_start so extensions (phoenix, subagent) initialise.
    await session.bindExtensions({
      mode: 'print',
      onError: (error) =>
        this.logger.warn(`Extension error in ${error.extensionPath}`, {
          event: error.event,
          error: error.error,
        }),
    });

    return session;
  }

  /**
   * Shut a session down: emit session_shutdown (the subagent extension stops
   * its children there), then dispose. `AgentSession.dispose()` alone does
   * not notify extensions. Never throws — callers close in a `finally` and
   * must not have the run's own outcome masked by a shutdown error.
   */
  async close(session: AgentSession): Promise<void> {
    try {
      await session.extensionRunner.emit({
        type: 'session_shutdown',
        reason: 'quit',
      });
    } catch (error) {
      this.logger.warn('session_shutdown failed', { error: error as Error });
    } finally {
      session.dispose();
    }
  }

  private openSessionManager(
    pi: PiSdk,
    cwd: string,
    resumeSessionId: string | undefined,
  ): SessionManager {
    if (resumeSessionId) {
      const path = pi.SessionManager.findById(cwd, resumeSessionId);
      if (path) return pi.SessionManager.open(path);
      this.logger.warn(
        `Session ${resumeSessionId} not found for ${cwd} — starting a fresh session`,
      );
    }
    return pi.SessionManager.create(cwd);
  }

  /** Replaces the built-in bash tool with one that exports AGENTQUEUE_RUN_ID. */
  private runIdBashExtension(
    pi: PiSdk,
    cwd: string,
    runId: string,
  ): { name: string; factory: (api: ExtensionAPI) => void } {
    return {
      name: 'agentqueue-run-id',
      factory: (api) => {
        api.registerTool(
          pi.createBashToolDefinition(cwd, {
            spawnHook: (ctx) => ({
              ...ctx,
              env: { ...ctx.env, AGENTQUEUE_RUN_ID: runId },
            }),
          }),
        );
      },
    };
  }

  private collectSystemPromptParts(
    additionalPrompts?: string[],
    runId?: string,
  ): string[] {
    const parts: string[] = [];
    if (runId) parts.push(this.buildRunIdPromptPart(runId));
    if (additionalPrompts) parts.push(...additionalPrompts);
    return parts;
  }

  private buildRunIdPromptPart(runId: string): string {
    return [
      `You are executing as AgentQueue run \`${runId}\`.`,
      `Your runId is also available in the \`AGENTQUEUE_RUN_ID\` environment variable.`,
      `When you enqueue child runs via the queue's \`POST /runs\` API, include \`"parentRunId": "${runId}"\` in the JSON body so the parent→child lineage is preserved.`,
    ].join(' ');
  }
}
