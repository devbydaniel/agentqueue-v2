import { Test } from '@nestjs/testing';
import { PiSessionFactory } from './pi-session.factory.js';
import { ExternalSessionRepository } from './external-session.repository.js';

// Mock the pi SDK module
const mockSession = {
  prompt: jest.fn().mockResolvedValue(undefined),
  subscribe: jest.fn(),
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
    AuthStorage: { create: jest.fn().mockReturnValue(mockAuthStorage) },
    ModelRegistry: { create: jest.fn().mockReturnValue(mockModelRegistry) },
    SettingsManager: { create: jest.fn().mockReturnValue(mockSettingsManager) },
    DefaultResourceLoader: jest.fn().mockReturnValue(mockResourceLoader),
  }),
  { virtual: true },
);

describe('PiSessionFactory', () => {
  let factory: PiSessionFactory;
  let externalSessionRepository: ExternalSessionRepository;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module = await Test.createTestingModule({
      providers: [
        PiSessionFactory,
        {
          provide: ExternalSessionRepository,
          useValue: {
            findFilePath: jest.fn().mockResolvedValue(null),
            upsertSession: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    factory = module.get(PiSessionFactory);
    externalSessionRepository = module.get(ExternalSessionRepository);
  });

  it('should create a fresh session when no externalSessionId is provided', async () => {
    const { SessionManager, createAgentSession } = await import(
      '@mariozechner/pi-coding-agent'
    );

    const result = await factory.create({ cwd: '/home/user/dev/my-repo' });

    expect(SessionManager.create).toHaveBeenCalledWith(
      '/home/user/dev/my-repo',
    );
    expect(SessionManager.open).not.toHaveBeenCalled();
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/home/user/dev/my-repo',
        sessionManager: mockSessionManager,
      }),
    );
    expect(result.session).toBe(mockSession);
  });

  it('should expose a dispose function that disposes the underlying session', async () => {
    const result = await factory.create({ cwd: '/home/user/dev/my-repo' });

    result.dispose();

    expect(mockSession.dispose).toHaveBeenCalled();
  });

  describe('system prompt overrides', () => {
    it('should pass systemPromptOverride when prependSystemPrompt is provided', async () => {
      const { DefaultResourceLoader } = await import(
        '@mariozechner/pi-coding-agent'
      );

      await factory.create({
        cwd: '/home/user/dev/my-repo',
        prependSystemPrompt: 'You are a Linear agent.',
      });

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

    it('should pass appendSystemPromptOverride when appendSystemPrompt is provided', async () => {
      const { DefaultResourceLoader } = await import(
        '@mariozechner/pi-coding-agent'
      );

      await factory.create({
        cwd: '/home/user/dev/my-repo',
        appendSystemPrompt: 'Always be concise.',
      });

      const options = (DefaultResourceLoader as jest.Mock).mock.calls.at(
        -1,
      )[0] as Record<string, unknown>;
      const override = options['appendSystemPromptOverride'] as (
        base: string[],
      ) => string[];
      expect(override(['existing'])).toEqual([
        'existing',
        'Always be concise.',
      ]);
      expect(override([])).toEqual(['Always be concise.']);
    });

    it('should not pass override functions when neither prompt is provided', async () => {
      const { DefaultResourceLoader } = await import(
        '@mariozechner/pi-coding-agent'
      );

      await factory.create({ cwd: '/home/user/dev/my-repo' });

      const options = (DefaultResourceLoader as jest.Mock).mock.calls.at(
        -1,
      )[0] as Record<string, unknown>;
      expect(options).not.toHaveProperty('systemPromptOverride');
      expect(options).not.toHaveProperty('appendSystemPromptOverride');
    });
  });

  describe('session resumption', () => {
    it('should open existing session when repository has a stored file', async () => {
      const { SessionManager } = await import('@mariozechner/pi-coding-agent');
      (
        externalSessionRepository.findFilePath as jest.Mock
      ).mockResolvedValueOnce('/sessions/existing.jsonl');

      await factory.create({
        cwd: '/home/user/dev/my-repo',
        externalSessionId: 'linear-session-1',
        externalSessionProvider: 'linear',
      });

      expect(externalSessionRepository.findFilePath).toHaveBeenCalledWith(
        'linear-session-1',
      );
      expect(SessionManager.open).toHaveBeenCalledWith(
        '/sessions/existing.jsonl',
      );
      expect(SessionManager.create).not.toHaveBeenCalled();
    });

    it('should fall back to create when open fails', async () => {
      const { SessionManager } = await import('@mariozechner/pi-coding-agent');
      (
        externalSessionRepository.findFilePath as jest.Mock
      ).mockResolvedValueOnce('/sessions/missing.jsonl');
      (SessionManager.open as jest.Mock).mockImplementationOnce(() => {
        throw new Error('file not found');
      });

      await factory.create({
        cwd: '/home/user/dev/my-repo',
        externalSessionId: 'linear-session-1',
        externalSessionProvider: 'linear',
      });

      expect(SessionManager.open).toHaveBeenCalled();
      expect(SessionManager.create).toHaveBeenCalled();
    });

    it('should store session file in repository after creation', async () => {
      await factory.create({
        cwd: '/home/user/dev/my-repo',
        externalSessionId: 'linear-session-1',
        externalSessionProvider: 'linear',
      });

      expect(externalSessionRepository.upsertSession).toHaveBeenCalledWith({
        provider: 'linear',
        sessionKey: 'linear-session-1',
        filePath: '/sessions/test-session.jsonl',
      });
    });

    it('should not query repository when no externalSessionId is provided', async () => {
      const { SessionManager } = await import('@mariozechner/pi-coding-agent');

      await factory.create({ cwd: '/home/user/dev/my-repo' });

      expect(externalSessionRepository.findFilePath).not.toHaveBeenCalled();
      expect(externalSessionRepository.upsertSession).not.toHaveBeenCalled();
      expect(SessionManager.create).toHaveBeenCalled();
      expect(SessionManager.open).not.toHaveBeenCalled();
    });
  });
});
