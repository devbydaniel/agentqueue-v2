import { AppConfigService } from './app-config.service.js';

describe('AppConfigService', () => {
  let service: AppConfigService;

  beforeEach(() => {
    service = new AppConfigService();
  });

  describe('port', () => {
    it('should default to 3000', () => {
      delete process.env.PORT;
      expect(service.port).toBe(3000);
    });

    it('should read from PORT env var', () => {
      process.env.PORT = '8080';
      expect(service.port).toBe(8080);
      delete process.env.PORT;
    });
  });

  describe('authToken', () => {
    it('should return the token when set', () => {
      process.env.AUTH_TOKEN = 'test-token';
      expect(service.authToken).toBe('test-token');
      delete process.env.AUTH_TOKEN;
    });

    it('should throw when not set', () => {
      delete process.env.AUTH_TOKEN;
      expect(() => service.authToken).toThrow(
        'AUTH_TOKEN environment variable is required',
      );
    });
  });

  describe('githubWebhookSecret', () => {
    it('should return undefined when not set', () => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
      expect(service.githubWebhookSecret).toBeUndefined();
    });

    it('should return the secret when set', () => {
      process.env.GITHUB_WEBHOOK_SECRET = 'gh-secret';
      expect(service.githubWebhookSecret).toBe('gh-secret');
      delete process.env.GITHUB_WEBHOOK_SECRET;
    });
  });

  describe('beforeHookTimeout', () => {
    it('should default to 30000', () => {
      delete process.env.BEFORE_HOOK_TIMEOUT;
      expect(service.beforeHookTimeout).toBe(30000);
    });

    it('should read from BEFORE_HOOK_TIMEOUT env var', () => {
      process.env.BEFORE_HOOK_TIMEOUT = '5000';
      expect(service.beforeHookTimeout).toBe(5000);
      delete process.env.BEFORE_HOOK_TIMEOUT;
    });
  });

  describe('langfuseEnabled', () => {
    it('should return false when not set', () => {
      delete process.env.LANGFUSE_SECRET_KEY;
      expect(service.langfuseEnabled).toBe(false);
    });

    it('should return true when set', () => {
      process.env.LANGFUSE_SECRET_KEY = 'lf-key';
      expect(service.langfuseEnabled).toBe(true);
      delete process.env.LANGFUSE_SECRET_KEY;
    });
  });
});
