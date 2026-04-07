import { Test } from '@nestjs/testing';
import { RunsService } from './runs.service.js';
import { AgentfilesConfigService } from '../config/agentfiles-config.service.js';
import { LinearSessionRepository } from './linear-session.repository.js';
import { ActiveSessionTrackerService } from './active-session-tracker.service.js';
import { CALLBACK_HANDLERS } from '../callbacks/constants.js';
import type { CallbackHandler } from '../callbacks/callback-handler.interface.js';
import { NotFoundException } from '@nestjs/common';

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

const mockSessionManager = {
  buildSessionContext: jest.fn(),
  getSessionFile: jest.fn().mockReturnValue('/sessions/test-session.jsonl'),
};
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
      open: jest.fn().mockReturnValue(mockSessionManager),
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

describe('RunsService', () => {
  let service: RunsService;
  let configService: AgentfilesConfigService;
  let linearSessionRepository: LinearSessionRepository;
  let activeSessionTracker: ActiveSessionTrackerService;
  const mockGlobalHandler: CallbackHandler = {
    name: 'test-global',
    onEvent: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    subscribeFn = undefined;

    const module = await Test.createTestingModule({
      providers: [
        RunsService,
        {
          provide: AgentfilesConfigService,
          useValue: {
            resolveRepo: jest.fn().mockReturnValue('/home/user/dev/my-repo'),
          },
        },
        {
          provide: LinearSessionRepository,
          useValue: {
            findFilePath: jest.fn().mockResolvedValue(null),
            saveFilePath: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: ActiveSessionTrackerService,
          useValue: {
            track: jest.fn(),
            untrack: jest.fn(),
            abort: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: CALLBACK_HANDLERS,
          useValue: [mockGlobalHandler],
        },
      ],
    }).compile();

    service = module.get(RunsService);
    configService = module.get(AgentfilesConfigService);
    linearSessionRepository = module.get(LinearSessionRepository);
    activeSessionTracker = module.get(ActiveSessionTrackerService);
  });

  it('should resolve the repo via config service', async () => {
    await service.execute({ repo: 'core', prompt: 'do something' });

    expect(configService.resolveRepo).toHaveBeenCalledWith('core');
  });

  it('should create an agent session with the resolved cwd', async () => {
    const { createAgentSession, SessionManager } = await import(
      '@mariozechner/pi-coding-agent'
    );

    await service.execute({ repo: 'core', prompt: 'do something' });

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
    await service.execute({ repo: 'core', prompt: 'fix the tests' });

    expect(mockSession.prompt).toHaveBeenCalledWith('fix the tests');
  });

  it('should return success true on completion', async () => {
    const result = await service.execute({ repo: 'core', prompt: 'hello' });

    expect(result).toEqual({ success: true });
  });

  it('should dispose the session even on success', async () => {
    await service.execute({ repo: 'core', prompt: 'hello' });

    expect(mockSession.dispose).toHaveBeenCalled();
  });

  it('should dispose the session on error', async () => {
    mockSession.prompt.mockRejectedValueOnce(new Error('boom'));

    await expect(
      service.execute({ repo: 'core', prompt: 'hello' }),
    ).rejects.toThrow();

    expect(mockSession.dispose).toHaveBeenCalled();
  });

  it('should propagate NotFoundException from resolveRepo unchanged', async () => {
    (configService.resolveRepo as jest.Mock).mockImplementation(() => {
      throw new NotFoundException('Repo "unknown" not found');
    });

    await expect(
      service.execute({ repo: 'unknown', prompt: 'hello' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('should propagate unknown errors from session.prompt unchanged', async () => {
    mockSession.prompt.mockRejectedValueOnce(new Error('something broke'));

    await expect(
      service.execute({ repo: 'core', prompt: 'hello' }),
    ).rejects.toThrow('something broke');
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

    await service.execute({
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

    const result = await service.execute({
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

    const result = await service.execute({
      repo: 'core',
      prompt: 'hello',
      additionalHandlers: [rejectingHandler],
    });

    expect(result).toEqual({ success: true });
  });

  it('should pass systemPromptOverride to DefaultResourceLoader when prependSystemPrompt is provided', async () => {
    const { DefaultResourceLoader } = await import(
      '@mariozechner/pi-coding-agent'
    );

    await service.execute({
      repo: 'core',
      prompt: 'hello',
      prependSystemPrompt: 'You are a Linear agent.',
    });

    expect(DefaultResourceLoader).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPromptOverride: expect.any(Function),
      }),
    );

    // Verify the override function prepends
    const options = (DefaultResourceLoader as jest.Mock).mock.calls.at(
      -1,
    )[0] as Record<string, unknown>;
    const override = options['systemPromptOverride'] as (
      base: string | undefined,
    ) => string;
    expect(override('base prompt')).toBe(
      'You are a Linear agent.\n\nbase prompt',
    );
    expect(override(undefined)).toBe('You are a Linear agent.');
  });

  it('should pass appendSystemPromptOverride to DefaultResourceLoader when appendSystemPrompt is provided', async () => {
    const { DefaultResourceLoader } = await import(
      '@mariozechner/pi-coding-agent'
    );

    await service.execute({
      repo: 'core',
      prompt: 'hello',
      appendSystemPrompt: 'Always be concise.',
    });

    expect(DefaultResourceLoader).toHaveBeenCalledWith(
      expect.objectContaining({
        appendSystemPromptOverride: expect.any(Function),
      }),
    );

    // Verify the override function appends
    const options = (DefaultResourceLoader as jest.Mock).mock.calls.at(
      -1,
    )[0] as Record<string, unknown>;
    const override = options['appendSystemPromptOverride'] as (
      base: string[],
    ) => string[];
    expect(override(['existing'])).toEqual(['existing', 'Always be concise.']);
    expect(override([])).toEqual(['Always be concise.']);
  });

  it('should not pass system prompt overrides when neither is provided', async () => {
    const { DefaultResourceLoader } = await import(
      '@mariozechner/pi-coding-agent'
    );

    await service.execute({ repo: 'core', prompt: 'hello' });

    const options = (DefaultResourceLoader as jest.Mock).mock.calls.at(
      -1,
    )[0] as Record<string, unknown>;
    expect(options).not.toHaveProperty('systemPromptOverride');
    expect(options).not.toHaveProperty('appendSystemPromptOverride');
  });

  describe('session resumption', () => {
    it('should open existing session when repository has a stored file', async () => {
      const { SessionManager } = await import('@mariozechner/pi-coding-agent');
      (linearSessionRepository.findFilePath as jest.Mock).mockResolvedValueOnce(
        '/sessions/existing.jsonl',
      );

      await service.execute({
        repo: 'core',
        prompt: 'follow up',
        sessionKey: 'linear-session-1',
      });

      expect(linearSessionRepository.findFilePath).toHaveBeenCalledWith(
        'linear-session-1',
      );
      expect(SessionManager.open).toHaveBeenCalledWith(
        '/sessions/existing.jsonl',
      );
      expect(SessionManager.create).not.toHaveBeenCalled();
    });

    it('should fall back to create when open fails', async () => {
      const { SessionManager } = await import('@mariozechner/pi-coding-agent');
      (linearSessionRepository.findFilePath as jest.Mock).mockResolvedValueOnce(
        '/sessions/missing.jsonl',
      );
      (SessionManager.open as jest.Mock).mockImplementationOnce(() => {
        throw new Error('file not found');
      });

      await service.execute({
        repo: 'core',
        prompt: 'follow up',
        sessionKey: 'linear-session-1',
      });

      expect(SessionManager.open).toHaveBeenCalled();
      expect(SessionManager.create).toHaveBeenCalled();
    });

    it('should store session file in repository after creation', async () => {
      await service.execute({
        repo: 'core',
        prompt: 'hello',
        sessionKey: 'linear-session-1',
      });

      expect(linearSessionRepository.saveFilePath).toHaveBeenCalledWith(
        'linear-session-1',
        '/sessions/test-session.jsonl',
      );
    });

    it('should not query repository when no sessionKey is provided', async () => {
      const { SessionManager } = await import('@mariozechner/pi-coding-agent');

      await service.execute({ repo: 'core', prompt: 'hello' });

      expect(linearSessionRepository.findFilePath).not.toHaveBeenCalled();
      expect(linearSessionRepository.saveFilePath).not.toHaveBeenCalled();
      expect(SessionManager.create).toHaveBeenCalled();
      expect(SessionManager.open).not.toHaveBeenCalled();
    });
  });

  describe('active session tracking', () => {
    it('should track and untrack active session via tracker', async () => {
      await service.execute({
        repo: 'core',
        prompt: 'hello',
        sessionKey: 'linear-session-1',
      });

      expect(activeSessionTracker.track).toHaveBeenCalledWith(
        'linear-session-1',
        mockSession,
      );
      expect(activeSessionTracker.untrack).toHaveBeenCalledWith(
        'linear-session-1',
      );
    });

    it('should untrack on error', async () => {
      mockSession.prompt.mockRejectedValueOnce(new Error('boom'));

      await expect(
        service.execute({
          repo: 'core',
          prompt: 'hello',
          sessionKey: 'linear-session-1',
        }),
      ).rejects.toThrow();

      expect(activeSessionTracker.untrack).toHaveBeenCalledWith(
        'linear-session-1',
      );
    });

    it('should delegate abort to the tracker', async () => {
      await service.abortSession('linear-session-1');

      expect(activeSessionTracker.abort).toHaveBeenCalledWith(
        'linear-session-1',
      );
    });
  });
});
