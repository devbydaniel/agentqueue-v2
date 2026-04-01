import { Test } from '@nestjs/testing';
import { ExecuteRunUseCase } from './execute-run.use-case.js';
import { AgentfilesConfigService } from '../../config/agentfiles-config.service.js';
import { CALLBACK_HANDLERS } from '../../callbacks/constants.js';
import type { CallbackHandler } from '../../callbacks/callback-handler.interface.js';
import { UnexpectedRunError } from './runs.errors.js';
import { RepoNotFoundError } from '../../config/config.errors.js';

// Mock the pi SDK module
const mockUnsubscribe = jest.fn();
let subscribeFn: ((event: unknown) => void) | undefined;
const mockSession = {
  prompt: jest.fn().mockResolvedValue(undefined),
  subscribe: jest.fn().mockImplementation((fn: (event: unknown) => void) => {
    subscribeFn = fn;
    return mockUnsubscribe;
  }),
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
  const mockGlobalHandler: CallbackHandler = {
    name: 'test-global',
    onEvent: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    subscribeFn = undefined;

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
          provide: CALLBACK_HANDLERS,
          useValue: [mockGlobalHandler],
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

  it('should call additionalHandlers on session events', async () => {
    const additionalHandler: CallbackHandler = {
      name: 'test-additional',
      onEvent: jest.fn(),
    };

    // Make prompt emit an event before resolving
    mockSession.prompt.mockImplementationOnce(async () => {
      subscribeFn?.({ type: 'agent_start' });
    });

    await useCase.execute({
      repo: 'core',
      prompt: 'hello',
      additionalHandlers: [additionalHandler],
    });

    expect(additionalHandler.onEvent).toHaveBeenCalledWith({
      type: 'agent_start',
    });
    expect(mockGlobalHandler.onEvent).toHaveBeenCalledWith({
      type: 'agent_start',
    });
  });

  it('should not crash if an additional handler throws synchronously', async () => {
    const throwingHandler: CallbackHandler = {
      name: 'throwing-handler',
      onEvent: jest.fn().mockImplementation(() => {
        throw new Error('handler exploded');
      }),
    };

    const safeHandler: CallbackHandler = {
      name: 'safe-handler',
      onEvent: jest.fn(),
    };

    mockSession.prompt.mockImplementationOnce(async () => {
      subscribeFn?.({ type: 'agent_start' });
    });

    const result = await useCase.execute({
      repo: 'core',
      prompt: 'hello',
      additionalHandlers: [throwingHandler, safeHandler],
    });

    expect(result).toEqual({ success: true });
    // The safe handler should still have been called after the throwing one
    expect(safeHandler.onEvent).toHaveBeenCalled();
  });

  it('should not crash if an additional handler rejects asynchronously', async () => {
    const rejectingHandler: CallbackHandler = {
      name: 'rejecting-handler',
      onEvent: jest.fn().mockRejectedValue(new Error('async boom')),
    };

    mockSession.prompt.mockImplementationOnce(async () => {
      subscribeFn?.({ type: 'agent_start' });
    });

    const result = await useCase.execute({
      repo: 'core',
      prompt: 'hello',
      additionalHandlers: [rejectingHandler],
    });

    expect(result).toEqual({ success: true });
  });
});
