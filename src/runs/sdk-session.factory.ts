import { Injectable } from '@nestjs/common';
import type {
  Options,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * Default model. Uses the `claude` CLI's
 * `opus` alias so new Opus releases are picked up automatically on CLI upgrade.
 */
const DEFAULT_MODEL = 'opus';

export interface CreateSdkSessionOptions {
  cwd: string;
  prompt: string;
  /** The executing run's id — exposed to the session via env var + system prompt so child enqueues can set parentRunId */
  runId?: string;
  /** Additional system prompt snippets appended to the Claude Code preset prompt (in order) */
  additionalSystemPrompts?: string[];
  /** AbortController for cancellation/timeout */
  abortController?: AbortController;
  /** Session ID to resume */
  resumeSessionId?: string;
}

export interface SdkSessionHandle {
  /** Async iterable of all SDK messages. Caller iterates this to drive the session. */
  messages: AsyncGenerator<SDKMessage, void>;
  /** Abort the running session. */
  abort: () => void;
  /** The session ID (captured from the first system init message). */
  get sessionId(): string | undefined;
}

/**
 * Builds a Claude Agent SDK `query()` call from the run config.
 * Wired into `RunProcessorService` as the execution engine.
 */
@Injectable()
export class SdkSessionFactory {
  async create(options: CreateSdkSessionOptions): Promise<SdkSessionHandle> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    const abortController = options.abortController ?? new AbortController();
    const sdkOptions = this.buildSdkOptions(options, abortController);

    const queryHandle: Query = query({
      prompt: options.prompt,
      options: sdkOptions,
    });

    let sessionId: string | undefined;

    const wrappedMessages = this.wrapWithSessionCapture(queryHandle, (id) => {
      sessionId = id;
    });

    return {
      messages: wrappedMessages,
      abort: () => {
        abortController.abort();
      },
      get sessionId() {
        return sessionId;
      },
    };
  }

  private buildSdkOptions(
    options: CreateSdkSessionOptions,
    abortController: AbortController,
  ): Options {
    const sdkOptions: Options = {
      cwd: options.cwd,
      abortController,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      // 'user' loads ~/.claude/settings.json — where agentfiles deploys the
      // phoenix Stop hook (and any future user-level hooks). 'project' loads
      // <cwd>/.claude/settings.json (per-agent overrides + CLAUDE.md).
      settingSources: ['user', 'project'],
    };

    this.applyExecutableOverride(sdkOptions);
    this.applyRunIdEnv(sdkOptions, options.runId);

    sdkOptions.model = DEFAULT_MODEL;

    this.applySystemPrompt(sdkOptions, options);

    if (options.resumeSessionId) {
      sdkOptions.resume = options.resumeSessionId;
    }

    return sdkOptions;
  }

  private applyExecutableOverride(sdkOptions: Options): void {
    if (process.env.AGENTQUEUE_CLAUDE_PATH) {
      sdkOptions.pathToClaudeCodeExecutable =
        process.env.AGENTQUEUE_CLAUDE_PATH;
    }
  }

  private applyRunIdEnv(sdkOptions: Options, runId: string | undefined): void {
    if (runId) {
      sdkOptions.env = {
        ...process.env,
        AGENTQUEUE_RUN_ID: runId,
      };
    }
  }

  private applySystemPrompt(
    sdkOptions: Options,
    options: CreateSdkSessionOptions,
  ): void {
    const promptParts = this.collectSystemPromptParts(
      options.additionalSystemPrompts,
      options.runId,
    );
    if (promptParts.length > 0) {
      sdkOptions.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: promptParts.join('\n\n'),
      };
    }
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

  private async *wrapWithSessionCapture(
    queryHandle: Query,
    onSessionId: (id: string) => void,
  ): AsyncGenerator<SDKMessage, void> {
    for await (const message of queryHandle) {
      if (
        message.type === 'system' &&
        'subtype' in message &&
        message.subtype === 'init'
      ) {
        onSessionId(message.session_id);
      }
      yield message;
    }
  }
}
