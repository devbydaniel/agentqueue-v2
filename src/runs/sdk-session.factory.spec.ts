/* eslint-disable sonarjs/publicly-writable-directories */
import { Test } from '@nestjs/testing';
import { SdkSessionFactory } from './sdk-session.factory.js';
import type { AgentProfile } from '../agents/agent-profile.interface.js';

// Mock query generator
const mockMessages = [
  {
    type: 'system',
    subtype: 'init',
    session_id: 'test-session-123',
    tools: ['Read', 'Bash'],
    model: 'claude-sonnet-4-6',
    cwd: '/tmp/test',
    mcp_servers: [],
    claude_code_version: '1.0.0',
    apiKeySource: 'user',
    permissionMode: 'bypassPermissions',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: 'uuid-1',
  },
  {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Hello' }] },
    parent_tool_use_id: null,
    uuid: 'uuid-2',
    session_id: 'test-session-123',
  },
  {
    type: 'result',
    subtype: 'success',
    result: 'Done',
    is_error: false,
    duration_ms: 1000,
    duration_api_ms: 800,
    num_turns: 1,
    total_cost_usd: 0.01,
    usage: { input_tokens: 100, output_tokens: 50 },
    modelUsage: {},
    permission_denials: [],
    stop_reason: 'end_turn',
    uuid: 'uuid-3',
    session_id: 'test-session-123',
  },
];

async function* mockAsyncGenerator() {
  for (const msg of mockMessages) {
    yield msg;
  }
}

const mockQueryFn = jest.fn();
let capturedOptions: Record<string, unknown> | undefined;

jest.mock(
  '@anthropic-ai/claude-agent-sdk',
  () => ({
    query: (params: { prompt: string; options?: Record<string, unknown> }) => {
      capturedOptions = params.options;
      mockQueryFn(params);
      return mockAsyncGenerator();
    },
  }),
  { virtual: true },
);

describe('SdkSessionFactory', () => {
  let factory: SdkSessionFactory;

  beforeEach(async () => {
    jest.clearAllMocks();
    capturedOptions = undefined;

    const module = await Test.createTestingModule({
      providers: [SdkSessionFactory],
    }).compile();

    factory = module.get(SdkSessionFactory);
  });

  it('should create a session with correct base options', async () => {
    const handle = await factory.create({
      cwd: '/home/user/dev/my-repo',
      prompt: 'Hello',
    });

    // Consume one message to trigger the generator
    const iterator = handle.messages[Symbol.asyncIterator]();
    await iterator.next();

    expect(mockQueryFn).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Hello' }),
    );
    expect(capturedOptions).toMatchObject({
      cwd: '/home/user/dev/my-repo',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project'],
    });
  });

  it('should pass model from profile', async () => {
    const profile: AgentProfile = {
      name: 'reviewer',
      model: 'claude-opus-4-6',
    };

    const handle = await factory.create({
      cwd: '/tmp/test',
      prompt: 'Review',
      profile,
    });

    const iterator = handle.messages[Symbol.asyncIterator]();
    await iterator.next();

    expect(capturedOptions!['model']).toBe('claude-opus-4-6');
  });

  it('should build combined system prompt from profile + additional prompts', async () => {
    const profile: AgentProfile = {
      name: 'agent',
      append_prompt: 'You are running inside AgentQueue.',
    };

    const handle = await factory.create({
      cwd: '/tmp/test',
      prompt: 'Do stuff',
      profile,
      additionalSystemPrompts: ['Be concise.', 'Always explain reasoning.'],
    });

    const iterator = handle.messages[Symbol.asyncIterator]();
    await iterator.next();

    expect(capturedOptions!['systemPrompt']).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append:
        'You are running inside AgentQueue.\n\nBe concise.\n\nAlways explain reasoning.',
    });
  });

  it('should not set systemPrompt when no prompt parts provided', async () => {
    const handle = await factory.create({
      cwd: '/tmp/test',
      prompt: 'Hello',
    });

    const iterator = handle.messages[Symbol.asyncIterator]();
    await iterator.next();

    expect(capturedOptions!['systemPrompt']).toBeUndefined();
  });

  it('should pass maxTurns from profile', async () => {
    const profile: AgentProfile = {
      name: 'agent',
      max_turns: 30,
    };

    const handle = await factory.create({
      cwd: '/tmp/test',
      prompt: 'Go',
      profile,
    });

    const iterator = handle.messages[Symbol.asyncIterator]();
    await iterator.next();

    expect(capturedOptions!['maxTurns']).toBe(30);
  });

  it('should pass allowedTools from profile', async () => {
    const profile: AgentProfile = {
      name: 'agent',
      tools: ['Read', 'Grep', 'Bash'],
    };

    const handle = await factory.create({
      cwd: '/tmp/test',
      prompt: 'Go',
      profile,
    });

    const iterator = handle.messages[Symbol.asyncIterator]();
    await iterator.next();

    expect(capturedOptions!['allowedTools']).toEqual(['Read', 'Grep', 'Bash']);
  });

  it('should map subagents to SDK agents format', async () => {
    const profile: AgentProfile = {
      name: 'agent',
      subagents: {
        researcher: {
          description: 'Research topics',
          prompt: 'You are a researcher.',
          model: 'haiku',
          tools: ['WebSearch'],
          max_turns: 10,
        },
      },
    };

    const handle = await factory.create({
      cwd: '/tmp/test',
      prompt: 'Go',
      profile,
    });

    const iterator = handle.messages[Symbol.asyncIterator]();
    await iterator.next();

    expect(capturedOptions!['agents']).toEqual({
      researcher: {
        description: 'Research topics',
        prompt: 'You are a researcher.',
        model: 'haiku',
        tools: ['WebSearch'],
        maxTurns: 10,
      },
    });
  });

  it('should map mcp_servers to SDK mcpServers format', async () => {
    const profile: AgentProfile = {
      name: 'agent',
      mcp_servers: {
        postgres: {
          type: 'stdio',
          command: 'node',
          args: ['./server.js'],
          env: { PG_HOST: 'localhost' },
        },
        remote: {
          type: 'sse',
          url: 'https://mcp.example.com',
          headers: { Authorization: 'Bearer token' },
        },
        api: {
          type: 'http',
          url: 'https://api.example.com/mcp',
        },
      },
    };

    const handle = await factory.create({
      cwd: '/tmp/test',
      prompt: 'Go',
      profile,
    });

    const iterator = handle.messages[Symbol.asyncIterator]();
    await iterator.next();

    const mcpServers = capturedOptions!['mcpServers'] as Record<
      string,
      unknown
    >;
    expect(mcpServers['postgres']).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['./server.js'],
      env: { PG_HOST: 'localhost' },
    });
    expect(mcpServers['remote']).toEqual({
      type: 'sse',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer token' },
    });
    expect(mcpServers['api']).toEqual({
      type: 'http',
      url: 'https://api.example.com/mcp',
    });
  });

  it('should capture session ID from first system init message', async () => {
    const handle = await factory.create({
      cwd: '/tmp/test',
      prompt: 'Hello',
    });

    expect(handle.sessionId).toBeUndefined();

    const iterator = handle.messages[Symbol.asyncIterator]();
    await iterator.next(); // system init message

    expect(handle.sessionId).toBe('test-session-123');
  });

  it('should use provided AbortController', async () => {
    const controller = new AbortController();

    const handle = await factory.create({
      cwd: '/tmp/test',
      prompt: 'Hello',
      abortController: controller,
    });

    const iterator = handle.messages[Symbol.asyncIterator]();
    await iterator.next();

    expect(capturedOptions!['abortController']).toBe(controller);
  });

  it('should create default AbortController when none provided', async () => {
    const handle = await factory.create({
      cwd: '/tmp/test',
      prompt: 'Hello',
    });

    const iterator = handle.messages[Symbol.asyncIterator]();
    await iterator.next();

    expect(capturedOptions!['abortController']).toBeInstanceOf(AbortController);
  });

  it('should abort via the abort controller', async () => {
    const controller = new AbortController();
    const abortSpy = jest.spyOn(controller, 'abort');

    const handle = await factory.create({
      cwd: '/tmp/test',
      prompt: 'Hello',
      abortController: controller,
    });

    handle.abort();

    expect(abortSpy).toHaveBeenCalled();
  });

  it('should pass resume session ID', async () => {
    const handle = await factory.create({
      cwd: '/tmp/test',
      prompt: 'Continue',
      resumeSessionId: 'prev-session-456',
    });

    const iterator = handle.messages[Symbol.asyncIterator]();
    await iterator.next();

    expect(capturedOptions!['resume']).toBe('prev-session-456');
  });

  it('should work without a profile (minimal options)', async () => {
    const handle = await factory.create({
      cwd: '/tmp/test',
      prompt: 'Hello',
    });

    const iterator = handle.messages[Symbol.asyncIterator]();
    await iterator.next();

    expect(capturedOptions!['model']).toBeUndefined();
    expect(capturedOptions!['agents']).toBeUndefined();
    expect(capturedOptions!['mcpServers']).toBeUndefined();
    expect(capturedOptions!['allowedTools']).toBeUndefined();
    expect(capturedOptions!['maxTurns']).toBeUndefined();
  });

  it('should yield all messages from the SDK query', async () => {
    const handle = await factory.create({
      cwd: '/tmp/test',
      prompt: 'Hello',
    });

    const received: unknown[] = [];
    for await (const msg of handle.messages) {
      received.push(msg);
    }

    expect(received).toHaveLength(3);
    expect((received[0] as { type: string }).type).toBe('system');
    expect((received[1] as { type: string }).type).toBe('assistant');
    expect((received[2] as { type: string }).type).toBe('result');
  });
});
