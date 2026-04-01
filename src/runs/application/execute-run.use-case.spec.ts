import { Test } from '@nestjs/testing';
import { ExecuteRunUseCase } from './execute-run.use-case.js';
import { AgentfilesConfigService } from '../../config/agentfiles-config.service.js';
import { CallbackManager } from '../../callbacks/callback-manager.service.js';
import { UnexpectedRunError } from './runs.errors.js';
import { RepoNotFoundError } from '../../config/config.errors.js';

// Mock the pi SDK module
const mockUnsubscribe = jest.fn();
const mockSession = {
  prompt: jest.fn().mockResolvedValue(undefined),
  subscribe: jest.fn().mockReturnValue(mockUnsubscribe),
  dispose: jest.fn(),
};

const mockSessionManager = { buildSessionContext: jest.fn() };
const mockAuthStorage = {};
const mockModelRegistry = {};
const mockSettingsManager = {};
const mockResourceLoader = { reload: jest.fn().mockResolvedValue(undefined) };

jest.mock(
  '@mariozechner/pi-coding-agent',
  () => ({
    createAgentSession: jest.fn().mockResolvedValue({ session: mockSession }),
    SessionManager: {
      create: jest.fn().mockReturnValue(mockSessionManager),
    },
    AuthStorage: {
      create: jest.fn().mockReturnValue(mockAuthStorage),
    },
    ModelRegistry: {
      create: jest.fn().mockReturnValue(mockModelRegistry),
    },
    SettingsManager: {
      create: jest.fn().mockReturnValue(mockSettingsManager),
    },
    DefaultResourceLoader: jest.fn().mockReturnValue(mockResourceLoader),
  }),
  { virtual: true },
);

describe('ExecuteRunUseCase', () => {
  let useCase: ExecuteRunUseCase;
  let configService: AgentfilesConfigService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module = await Test.createTestingModule({
      providers: [
        ExecuteRunUseCase,
        {
          provide: AgentfilesConfigService,
          useValue: {
            resolveRepo: jest.fn().mockReturnValue('/home/user/dev/my-repo'),
          },
        },
        {
          provide: CallbackManager,
          useValue: {
            attachToSession: jest.fn().mockReturnValue(jest.fn()),
          },
        },
      ],
    }).compile();

    useCase = module.get(ExecuteRunUseCase);
    configService = module.get(AgentfilesConfigService);
  });

  it('should resolve the repo via config service', async () => {
    await useCase.execute({ repo: 'core', prompt: 'do something' });

    expect(configService.resolveRepo).toHaveBeenCalledWith('core');
  });

  it('should create an agent session with the resolved cwd', async () => {
    const { createAgentSession, SessionManager } = await import(
      '@mariozechner/pi-coding-agent'
    );

    await useCase.execute({ repo: 'core', prompt: 'do something' });

    expect(SessionManager.create).toHaveBeenCalledWith(
      '/home/user/dev/my-repo',
    );
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/home/user/dev/my-repo',
        sessionManager: mockSessionManager,
      }),
    );
  });

  it('should call session.prompt with the provided prompt', async () => {
    await useCase.execute({ repo: 'core', prompt: 'fix the tests' });

    expect(mockSession.prompt).toHaveBeenCalledWith('fix the tests');
  });

  it('should return success true on completion', async () => {
    const result = await useCase.execute({ repo: 'core', prompt: 'hello' });

    expect(result).toEqual({ success: true });
  });

  it('should dispose the session even on success', async () => {
    await useCase.execute({ repo: 'core', prompt: 'hello' });

    expect(mockSession.dispose).toHaveBeenCalled();
  });

  it('should dispose the session on error', async () => {
    mockSession.prompt.mockRejectedValueOnce(new Error('boom'));

    await expect(
      useCase.execute({ repo: 'core', prompt: 'hello' }),
    ).rejects.toThrow();

    expect(mockSession.dispose).toHaveBeenCalled();
  });

  it('should re-throw ApplicationError subclasses as-is', async () => {
    (configService.resolveRepo as jest.Mock).mockImplementation(() => {
      throw new RepoNotFoundError('unknown');
    });

    await expect(
      useCase.execute({ repo: 'unknown', prompt: 'hello' }),
    ).rejects.toThrow(RepoNotFoundError);
  });

  it('should wrap unknown errors in UnexpectedRunError', async () => {
    mockSession.prompt.mockRejectedValueOnce(new Error('something broke'));

    await expect(
      useCase.execute({ repo: 'core', prompt: 'hello' }),
    ).rejects.toThrow(UnexpectedRunError);
  });
});
