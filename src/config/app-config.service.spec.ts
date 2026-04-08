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

  describe('databaseUrl', () => {
    it('should default to local postgres in non-production', () => {
      delete process.env.DATABASE_URL;
      delete process.env.NODE_ENV;
      expect(service.databaseUrl).toBe(
        'postgres://agentqueue:agentqueue@localhost:5433/agentqueue',
      );
    });

    it('should return the url when set', () => {
      process.env.DATABASE_URL = 'postgres://custom:5432/db';
      expect(service.databaseUrl).toBe('postgres://custom:5432/db');
      delete process.env.DATABASE_URL;
    });

    it('should throw in production when not set', () => {
      delete process.env.DATABASE_URL;
      process.env.NODE_ENV = 'production';
      expect(() => service.databaseUrl).toThrow(
        'DATABASE_URL environment variable is required',
      );
      delete process.env.NODE_ENV;
    });
  });

  describe('queueConcurrency', () => {
    it('should default to 5', () => {
      delete process.env.QUEUE_CONCURRENCY;
      expect(service.queueConcurrency).toBe(5);
    });

    it('should read from QUEUE_CONCURRENCY env var', () => {
      process.env.QUEUE_CONCURRENCY = '10';
      expect(service.queueConcurrency).toBe(10);
      delete process.env.QUEUE_CONCURRENCY;
    });
  });

  describe('queueRetryLimit', () => {
    it('should default to 3', () => {
      delete process.env.QUEUE_RETRY_LIMIT;
      expect(service.queueRetryLimit).toBe(3);
    });

    it('should read from QUEUE_RETRY_LIMIT env var', () => {
      process.env.QUEUE_RETRY_LIMIT = '5';
      expect(service.queueRetryLimit).toBe(5);
      delete process.env.QUEUE_RETRY_LIMIT;
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
