/* eslint-disable sonarjs/publicly-writable-directories */
import { Test } from '@nestjs/testing';
import { PiSessionFactory } from './pi-session.factory.js';

type AgentSession = Parameters<PiSessionFactory['close']>[0];

interface SpawnContext {
  command: string;
  cwd: string;
  env: Record<string, string | undefined>;
}

interface CapturedLoaderOptions {
  cwd: string;
  agentDir: string;
  appendSystemPromptOverride: (base: string[]) => string[];
  extensionFactories: {
    name: string;
    factory: (api: { registerTool: jest.Mock }) => void;
  }[];
}

interface CapturedBashOptions {
  spawnHook: (ctx: SpawnContext) => SpawnContext;
}

interface BindOptions {
  mode: string;
  onError: (error: {
    extensionPath: string;
    event: string;
    error: string;
  }) => void;
}

const AGENT_DIR = '/home/user/.pi/agent';

const mockReload = jest.fn();
const mockBindExtensions = jest.fn();
const mockEmit = jest.fn();
const mockDispose = jest.fn();
const mockCreateAgentSession = jest.fn();
const mockFindById = jest.fn();
const mockOpen = jest.fn();
const mockCreate = jest.fn();
const mockCreateBashToolDefinition = jest.fn();
let capturedLoaderOptions: CapturedLoaderOptions | undefined;

const mockLoader = { reload: mockReload };

const mockSession = {
  bindExtensions: mockBindExtensions,
  extensionRunner: { emit: mockEmit },
  dispose: mockDispose,
};

jest.mock(
  '@earendil-works/pi-coding-agent',
  () => ({
    getAgentDir: () => AGENT_DIR,
    DefaultResourceLoader: jest.fn((options: CapturedLoaderOptions) => {
      capturedLoaderOptions = options;
      return mockLoader;
    }),
    createAgentSession: mockCreateAgentSession,
    SessionManager: {
      findById: mockFindById,
      open: mockOpen,
      create: mockCreate,
    },
    createBashToolDefinition: mockCreateBashToolDefinition,
  }),
  { virtual: true },
);

describe('PiSessionFactory', () => {
  let factory: PiSessionFactory;

  beforeEach(async () => {
    jest.clearAllMocks();
    capturedLoaderOptions = undefined;

    mockReload.mockResolvedValue(undefined);
    mockBindExtensions.mockResolvedValue(undefined);
    mockEmit.mockResolvedValue(undefined);
    mockCreateAgentSession.mockResolvedValue({ session: mockSession });
    mockFindById.mockReturnValue(undefined);
    mockOpen.mockReturnValue({ kind: 'opened' });
    mockCreate.mockReturnValue({ kind: 'created' });
    mockCreateBashToolDefinition.mockImplementation(
      (cwd: string, options: CapturedBashOptions) => ({
        name: 'bash',
        cwd,
        options,
      }),
    );

    const module = await Test.createTestingModule({
      providers: [PiSessionFactory],
    }).compile();

    factory = module.get(PiSessionFactory);
  });

  const loaderOptions = (): CapturedLoaderOptions => {
    if (!capturedLoaderOptions) throw new Error('loader not constructed');
    return capturedLoaderOptions;
  };

  describe('create', () => {
    it('should pass cwd and agentDir to the resource loader and session', async () => {
      const session = await factory.create({ cwd: '/tmp/repo' });

      expect(session).toBe(mockSession);
      expect(loaderOptions()).toMatchObject({
        cwd: '/tmp/repo',
        agentDir: AGENT_DIR,
      });
      expect(mockCreateAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/tmp/repo',
          agentDir: AGENT_DIR,
          resourceLoader: mockLoader,
        }),
      );
    });

    it('should reload the resource loader before creating the session', async () => {
      await factory.create({ cwd: '/tmp/repo' });

      expect(mockReload).toHaveBeenCalledTimes(1);
      expect(mockReload.mock.invocationCallOrder[0]).toBeLessThan(
        mockCreateAgentSession.mock.invocationCallOrder[0],
      );
    });

    it('should bind extensions in print mode with an onError callback', async () => {
      await factory.create({ cwd: '/tmp/repo' });

      expect(mockBindExtensions).toHaveBeenCalledTimes(1);
      const bindOptions = mockBindExtensions.mock.calls[0][0] as BindOptions;
      expect(bindOptions.mode).toBe('print');
      expect(typeof bindOptions.onError).toBe('function');
      expect(() =>
        bindOptions.onError({
          extensionPath: '/ext/phoenix.ts',
          event: 'session_start',
          error: 'boom',
        }),
      ).not.toThrow();
    });
  });

  describe('system prompt', () => {
    it('should append the runId part then additional prompts after the base', async () => {
      await factory.create({
        cwd: '/tmp/repo',
        runId: 'run-abc-123',
        additionalSystemPrompts: ['Be concise.', 'Explain reasoning.'],
      });

      const result = loaderOptions().appendSystemPromptOverride([
        'base-1',
        'base-2',
      ]);

      expect(result).toHaveLength(5);
      expect(result.slice(0, 2)).toEqual(['base-1', 'base-2']);
      expect(result[2]).toContain('run-abc-123');
      expect(result.slice(3)).toEqual(['Be concise.', 'Explain reasoning.']);
    });

    it('should mention the runId, AGENTQUEUE_RUN_ID and parentRunId in the runId part', async () => {
      await factory.create({ cwd: '/tmp/repo', runId: 'run-abc-123' });

      const [runIdPart] = loaderOptions().appendSystemPromptOverride([]);

      expect(runIdPart).toContain('run-abc-123');
      expect(runIdPart).toContain('AGENTQUEUE_RUN_ID');
      expect(runIdPart).toContain('"parentRunId": "run-abc-123"');
    });

    it('should append only additional prompts when no runId is given', async () => {
      await factory.create({
        cwd: '/tmp/repo',
        additionalSystemPrompts: ['Be concise.'],
      });

      expect(loaderOptions().appendSystemPromptOverride(['base'])).toEqual([
        'base',
        'Be concise.',
      ]);
    });

    it('should return the base unchanged with no runId or additional prompts', async () => {
      await factory.create({ cwd: '/tmp/repo' });

      expect(loaderOptions().appendSystemPromptOverride(['base'])).toEqual([
        'base',
      ]);
    });
  });

  describe('runId bash extension', () => {
    const registerExtensionTool = () => {
      const { extensionFactories } = loaderOptions();
      expect(extensionFactories).toHaveLength(1);
      const registerTool = jest.fn();
      extensionFactories[0].factory({ registerTool });
      return registerTool;
    };

    const capturedSpawnHook = () => {
      const [, options] = mockCreateBashToolDefinition.mock.calls[0] as [
        string,
        CapturedBashOptions,
      ];
      return options.spawnHook;
    };

    it('should register a named extension with the bash tool for the session cwd', async () => {
      await factory.create({ cwd: '/tmp/repo', runId: 'run-abc-123' });

      expect(loaderOptions().extensionFactories[0].name).toBe(
        'agentqueue-run-id',
      );
      const registerTool = registerExtensionTool();

      expect(mockCreateBashToolDefinition).toHaveBeenCalledWith(
        '/tmp/repo',
        expect.objectContaining({ spawnHook: expect.any(Function) }),
      );
      expect(registerTool).toHaveBeenCalledWith(
        mockCreateBashToolDefinition.mock.results[0].value,
      );
    });

    it('should export AGENTQUEUE_RUN_ID from the spawn hook while preserving the context', async () => {
      await factory.create({ cwd: '/tmp/repo', runId: 'run-abc-123' });
      registerExtensionTool();

      const result = capturedSpawnHook()({
        command: 'echo hi',
        cwd: '/tmp/repo/sub',
        env: { PATH: '/usr/bin', HOME: '/home/user' },
      });

      expect(result).toEqual({
        command: 'echo hi',
        cwd: '/tmp/repo/sub',
        env: {
          PATH: '/usr/bin',
          HOME: '/home/user',
          AGENTQUEUE_RUN_ID: 'run-abc-123',
        },
      });
    });

    it('should register no extension factories without a runId', async () => {
      await factory.create({ cwd: '/tmp/repo' });

      expect(loaderOptions().extensionFactories).toEqual([]);
      expect(mockCreateBashToolDefinition).not.toHaveBeenCalled();
    });
  });

  describe('session manager', () => {
    it('should open the existing session file when the resume id is found', async () => {
      mockFindById.mockReturnValue('/tmp/sessions/prev.jsonl');

      await factory.create({ cwd: '/tmp/repo', resumeSessionId: 'prev-456' });

      expect(mockFindById).toHaveBeenCalledWith('/tmp/repo', 'prev-456');
      expect(mockOpen).toHaveBeenCalledWith('/tmp/sessions/prev.jsonl');
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockCreateAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionManager: { kind: 'opened' } }),
      );
    });

    it('should start a fresh session when the resume id is not found', async () => {
      await factory.create({ cwd: '/tmp/repo', resumeSessionId: 'missing' });

      expect(mockFindById).toHaveBeenCalledWith('/tmp/repo', 'missing');
      expect(mockOpen).not.toHaveBeenCalled();
      expect(mockCreate).toHaveBeenCalledWith('/tmp/repo');
      expect(mockCreateAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionManager: { kind: 'created' } }),
      );
    });

    it('should create a session without lookup when no resume id is given', async () => {
      await factory.create({ cwd: '/tmp/repo' });

      expect(mockFindById).not.toHaveBeenCalled();
      expect(mockCreate).toHaveBeenCalledWith('/tmp/repo');
    });
  });

  describe('close', () => {
    const session = mockSession as unknown as AgentSession;

    it('should emit session_shutdown and then dispose', async () => {
      await factory.close(session);

      expect(mockEmit).toHaveBeenCalledWith({
        type: 'session_shutdown',
        reason: 'quit',
      });
      expect(mockDispose).toHaveBeenCalledTimes(1);
      expect(mockEmit.mock.invocationCallOrder[0]).toBeLessThan(
        mockDispose.mock.invocationCallOrder[0],
      );
    });

    it('should dispose and swallow the error when emit rejects', async () => {
      mockEmit.mockRejectedValue(new Error('shutdown failed'));

      await expect(factory.close(session)).resolves.toBeUndefined();
      expect(mockDispose).toHaveBeenCalledTimes(1);
    });
  });
});
