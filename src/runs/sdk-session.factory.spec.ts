/* eslint-disable sonarjs/publicly-writable-directories */
import { Test } from '@nestjs/testing';
import { SdkSessionFactory } from './sdk-session.factory.js';

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
      settingSources: ['user', 'project'],
    });
  });

  it('should build combined system prompt from additional prompts', async () => {
    const handle = await factory.create({
      cwd: '/tmp/test',
      prompt: 'Do stuff',
      additionalSystemPrompts: ['Be concise.', 'Always explain reasoning.'],
    });

    const iterator = handle.messages[Symbol.asyncIterator]();
    await iterator.next();

    expect(capturedOptions!['systemPrompt']).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Be concise.\n\nAlways explain reasoning.',
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

  it('should use the default model with minimal options', async () => {
    const handle = await factory.create({
      cwd: '/tmp/test',
      prompt: 'Hello',
    });

    const iterator = handle.messages[Symbol.asyncIterator]();
    await iterator.next();

    expect(capturedOptions!['model']).toBe('opus');
  });

  it('should inject runId into env and system prompt when provided', async () => {
    const handle = await factory.create({
      cwd: '/tmp/test',
      prompt: 'Hello',
      runId: 'run-abc-123',
    });

    const iterator = handle.messages[Symbol.asyncIterator]();
    await iterator.next();

    const env = capturedOptions!['env'] as Record<string, string | undefined>;
    expect(env['AGENTQUEUE_RUN_ID']).toBe('run-abc-123');

    const systemPrompt = capturedOptions!['systemPrompt'] as {
      append: string;
    };
    expect(systemPrompt.append).toContain('run-abc-123');
    expect(systemPrompt.append).toContain('AGENTQUEUE_RUN_ID');
    expect(systemPrompt.append).toContain('parentRunId');
  });

  it('should not set env when runId is not provided', async () => {
    const handle = await factory.create({
      cwd: '/tmp/test',
      prompt: 'Hello',
    });

    const iterator = handle.messages[Symbol.asyncIterator]();
    await iterator.next();

    expect(capturedOptions!['env']).toBeUndefined();
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
