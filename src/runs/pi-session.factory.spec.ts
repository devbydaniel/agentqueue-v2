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
  appendSystemPromptOverride: (base: string[]) => string[];
  extensionFactories: {
    name: string;
    factory: (api: { registerTool: jest.Mock }) => void;
  }[];
}

interface CapturedServicesOptions {
  cwd: string;
  agentDir: string;
  resourceLoaderOptions: CapturedLoaderOptions;
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

const mockBindExtensions = jest.fn();
const mockEmit = jest.fn();
const mockDispose = jest.fn();
const mockCreateAgentSessionServices = jest.fn();
const mockCreateAgentSessionFromServices = jest.fn();
const mockFindById = jest.fn();
const mockOpen = jest.fn();
const mockCreate = jest.fn();
const mockCreateBashToolDefinition = jest.fn();
let capturedServicesOptions: CapturedServicesOptions | undefined;

const mockServices = { diagnostics: [] as { type: string; message: string }[] };

const mockSetModel = jest.fn();
const mockGetModel = jest.fn();
const mockGetDefaultProvider = jest.fn();
const mockGetDefaultModel = jest.fn();

const mockSession = {
  bindExtensions: mockBindExtensions,
  setModel: mockSetModel,
  model: undefined as { provider: string; id: string } | undefined,
  modelRuntime: { getModel: mockGetModel },
  settingsManager: {
    getDefaultProvider: mockGetDefaultProvider,
    getDefaultModel: mockGetDefaultModel,
  },
  extensionRunner: { emit: mockEmit },
  dispose: mockDispose,
};

jest.mock(
  '@earendil-works/pi-coding-agent',
  () => ({
    getAgentDir: () => AGENT_DIR,
    createAgentSessionServices: mockCreateAgentSessionServices,
    createAgentSessionFromServices: mockCreateAgentSessionFromServices,
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
    capturedServicesOptions = undefined;
    mockServices.diagnostics = [];
    mockSession.model = { provider: 'claude-bridge', id: 'claude-opus-5-5' };
    mockGetDefaultProvider.mockReturnValue('claude-bridge');
    mockGetDefaultModel.mockReturnValue('claude-opus-5-5');
    mockGetModel.mockReturnValue(undefined);
    mockSetModel.mockResolvedValue(undefined);

    mockCreateAgentSessionServices.mockImplementation(
      (options: CapturedServicesOptions) => {
        capturedServicesOptions = options;
        return Promise.resolve(mockServices);
      },
    );
    mockBindExtensions.mockResolvedValue(undefined);
    mockEmit.mockResolvedValue(undefined);
    mockCreateAgentSessionFromServices.mockResolvedValue({
      session: mockSession,
    });
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
    if (!capturedServicesOptions) throw new Error('services not created');
    return capturedServicesOptions.resourceLoaderOptions;
  };

  describe('create', () => {
    it('should create services for cwd and agentDir and build the session from them', async () => {
      const session = await factory.create({ cwd: '/tmp/repo' });

      expect(session).toBe(mockSession);
      expect(capturedServicesOptions).toMatchObject({
        cwd: '/tmp/repo',
        agentDir: AGENT_DIR,
      });
      expect(mockCreateAgentSessionFromServices).toHaveBeenCalledWith(
        expect.objectContaining({ services: mockServices }),
      );
    });

    it('should create services before the session so extension providers are registered first', async () => {
      await factory.create({ cwd: '/tmp/repo' });

      expect(
        mockCreateAgentSessionServices.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mockCreateAgentSessionFromServices.mock.invocationCallOrder[0],
      );
    });

    it('should still create the session when pi reports diagnostics or a model fallback', async () => {
      mockServices.diagnostics = [{ type: 'error', message: 'bad extension' }];
      mockCreateAgentSessionFromServices.mockResolvedValue({
        session: mockSession,
        modelFallbackMessage: 'No models available',
      });

      await expect(factory.create({ cwd: '/tmp/repo' })).resolves.toBe(
        mockSession,
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

  describe('default model', () => {
    const bridgeModel = { provider: 'claude-bridge', id: 'claude-opus-5-5' };

    it('should switch to the settings default when pi fell back to another provider', async () => {
      mockSession.model = { provider: 'openai', id: 'gpt-5.5' };
      mockGetModel.mockReturnValue(bridgeModel);

      await factory.create({ cwd: '/tmp/repo' });

      expect(mockGetModel).toHaveBeenCalledWith(
        'claude-bridge',
        'claude-opus-5-5',
      );
      expect(mockSetModel).toHaveBeenCalledWith(bridgeModel);
      expect(mockBindExtensions.mock.invocationCallOrder[0]).toBeLessThan(
        mockSetModel.mock.invocationCallOrder[0],
      );
    });

    it('should leave the model alone when it already is the settings default', async () => {
      await factory.create({ cwd: '/tmp/repo' });

      expect(mockSetModel).not.toHaveBeenCalled();
    });

    it('should keep the current model when the default is not registered', async () => {
      mockSession.model = { provider: 'openai', id: 'gpt-5.5' };

      await expect(factory.create({ cwd: '/tmp/repo' })).resolves.toBe(
        mockSession,
      );
      expect(mockSetModel).not.toHaveBeenCalled();
    });

    it('should do nothing without a settings default', async () => {
      mockGetDefaultProvider.mockReturnValue(undefined);

      await factory.create({ cwd: '/tmp/repo' });

      expect(mockGetModel).not.toHaveBeenCalled();
      expect(mockSetModel).not.toHaveBeenCalled();
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
      expect(mockCreateAgentSessionFromServices).toHaveBeenCalledWith(
        expect.objectContaining({ sessionManager: { kind: 'opened' } }),
      );
    });

    it('should start a fresh session when the resume id is not found', async () => {
      await factory.create({ cwd: '/tmp/repo', resumeSessionId: 'missing' });

      expect(mockFindById).toHaveBeenCalledWith('/tmp/repo', 'missing');
      expect(mockOpen).not.toHaveBeenCalled();
      expect(mockCreate).toHaveBeenCalledWith('/tmp/repo');
      expect(mockCreateAgentSessionFromServices).toHaveBeenCalledWith(
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
