import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import type { AgentSession } from '@mariozechner/pi-coding-agent';
import { RunsService } from './runs.service.js';
import { AgentfilesConfigService } from '../config/agentfiles-config.service.js';
import { PiSessionFactory } from './pi-session.factory.js';
import { ActiveSessionTrackerService } from './active-session-tracker.service.js';
import { CALLBACK_HANDLERS } from '../callbacks/constants.js';
import type { CallbackHandler } from '../callbacks/callback-handler.interface.js';

describe('RunsService', () => {
  let service: RunsService;
  let configService: AgentfilesConfigService;
  let piSessionFactory: PiSessionFactory;
  let activeSessionTracker: ActiveSessionTrackerService;
  let mockSession: jest.Mocked<Pick<AgentSession, 'prompt' | 'subscribe'>> & {
    dispose: jest.Mock;
  };
  let mockDispose: jest.Mock;
  let subscribeFn: ((event: unknown) => void) | undefined;

  const mockGlobalHandler: CallbackHandler = {
    name: 'test-global',
    onEvent: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    subscribeFn = undefined;

    const unsubscribe = jest.fn();
    mockSession = {
      prompt: jest.fn().mockResolvedValue(undefined),
      subscribe: jest
        .fn()
        .mockImplementation((fn: (event: unknown) => void) => {
          subscribeFn = fn;
          return unsubscribe;
        }),
      dispose: jest.fn(),
    };
    mockDispose = jest.fn();

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
          provide: PiSessionFactory,
          useValue: {
            create: jest.fn().mockResolvedValue({
              session: mockSession,
              dispose: mockDispose,
            }),
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
    piSessionFactory = module.get(PiSessionFactory);
    activeSessionTracker = module.get(ActiveSessionTrackerService);
  });

  it('should resolve the repo via config service', async () => {
    await service.execute({ repo: 'core', prompt: 'do something' });

    expect(configService.resolveRepo).toHaveBeenCalledWith('core');
  });

  it('should call the factory with cwd + system prompt options', async () => {
    await service.execute({
      repo: 'core',
      prompt: 'do something',
      sessionKey: 'session-1',
      prependSystemPrompt: 'prepend',
      appendSystemPrompt: 'append',
    });

    expect(piSessionFactory.create).toHaveBeenCalledWith({
      cwd: '/home/user/dev/my-repo',
      sessionKey: 'session-1',
      prependSystemPrompt: 'prepend',
      appendSystemPrompt: 'append',
    });
  });

  it('should call session.prompt with the provided prompt', async () => {
    await service.execute({ repo: 'core', prompt: 'fix the tests' });

    expect(mockSession.prompt).toHaveBeenCalledWith('fix the tests');
  });

  it('should return success true on completion', async () => {
    const result = await service.execute({ repo: 'core', prompt: 'hello' });

    expect(result).toEqual({ success: true });
  });

  it('should call dispose() on success', async () => {
    await service.execute({ repo: 'core', prompt: 'hello' });

    expect(mockDispose).toHaveBeenCalled();
  });

  it('should call dispose() on error', async () => {
    mockSession.prompt.mockRejectedValueOnce(new Error('boom'));

    await expect(
      service.execute({ repo: 'core', prompt: 'hello' }),
    ).rejects.toThrow();

    expect(mockDispose).toHaveBeenCalled();
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

  describe('callback handlers', () => {
    it('should call additionalHandlers on session events', async () => {
      const additionalHandler: CallbackHandler = {
        name: 'test-additional',
        onEvent: jest.fn(),
      };

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

    it('should not crash if a handler throws synchronously', async () => {
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
      expect(safeHandler.onEvent).toHaveBeenCalled();
    });

    it('should not crash if a handler rejects asynchronously', async () => {
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

    it('should not track when no sessionKey is provided', async () => {
      await service.execute({ repo: 'core', prompt: 'hello' });

      expect(activeSessionTracker.track).not.toHaveBeenCalled();
      expect(activeSessionTracker.untrack).not.toHaveBeenCalled();
    });

    it('should delegate abort to the tracker', async () => {
      await service.abortSession('linear-session-1');

      expect(activeSessionTracker.abort).toHaveBeenCalledWith(
        'linear-session-1',
      );
    });
  });
});
