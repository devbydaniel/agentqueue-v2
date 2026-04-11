import { Injectable } from '@nestjs/common';
import type {
  AgentDefinition,
  McpServerConfig,
  Options,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentProfile,
  McpServerProfile,
} from '../agents/agent-profile.interface.js';

export interface CreateSdkSessionOptions {
  cwd: string;
  prompt: string;
  /** Resolved agent profile (already looked up by caller) */
  profile?: AgentProfile;
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
 * Builds a Claude Agent SDK `query()` call from a merged profile + run config.
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
      settingSources: ['project'],
    };

    const profile = options.profile;

    if (profile?.model) {
      sdkOptions.model = profile.model;
    }

    const promptParts = this.collectSystemPromptParts(
      profile?.append_prompt,
      options.additionalSystemPrompts,
    );
    if (promptParts.length > 0) {
      sdkOptions.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: promptParts.join('\n\n'),
      };
    }

    if (profile?.tools) {
      sdkOptions.allowedTools = profile.tools;
    }

    if (profile?.max_turns) {
      sdkOptions.maxTurns = profile.max_turns;
    }

    if (profile?.subagents) {
      sdkOptions.agents = this.mapSubagents(profile.subagents);
    }

    if (profile?.mcp_servers) {
      sdkOptions.mcpServers = this.mapMcpServers(profile.mcp_servers);
    }

    if (options.resumeSessionId) {
      sdkOptions.resume = options.resumeSessionId;
    }

    return sdkOptions;
  }

  private collectSystemPromptParts(
    profileAppend?: string,
    additionalPrompts?: string[],
  ): string[] {
    const parts: string[] = [];
    if (profileAppend) parts.push(profileAppend);
    if (additionalPrompts) parts.push(...additionalPrompts);
    return parts;
  }

  private mapSubagents(
    subagents: NonNullable<AgentProfile['subagents']>,
  ): Record<string, AgentDefinition> {
    const result: Record<string, AgentDefinition> = {};

    for (const [name, sub] of Object.entries(subagents)) {
      const def: AgentDefinition = {
        description: sub.description,
        prompt: sub.prompt,
      };

      if (sub.model) def.model = sub.model;
      if (sub.tools) def.tools = sub.tools;
      if (sub.max_turns) def.maxTurns = sub.max_turns;

      // eslint-disable-next-line security/detect-object-injection -- name comes from our own profile config
      result[name] = def;
    }

    return result;
  }

  private mapMcpServers(
    servers: NonNullable<AgentProfile['mcp_servers']>,
  ): Record<string, McpServerConfig> {
    return Object.fromEntries(
      Object.entries(servers).map(([name, server]) => [
        name,
        this.mapOneMcpServer(server),
      ]),
    );
  }

  private mapOneMcpServer(server: McpServerProfile): McpServerConfig {
    if (server.type === 'stdio') {
      return {
        type: 'stdio',
        command: server.command!,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: server.env } : {}),
      };
    }
    return {
      type: server.type,
      url: server.url!,
      ...(server.headers ? { headers: server.headers } : {}),
    };
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
