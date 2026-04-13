import { detectTracingProvider } from './detect-tracing-provider.js';

describe('detectTracingProvider', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    envBackup.TRACING_PROVIDER = process.env.TRACING_PROVIDER;
    envBackup.LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY;
    envBackup.PHOENIX_COLLECTOR_ENDPOINT =
      process.env.PHOENIX_COLLECTOR_ENDPOINT;

    delete process.env.TRACING_PROVIDER;
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.PHOENIX_COLLECTOR_ENDPOINT;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('should return "langfuse" when TRACING_PROVIDER=langfuse', () => {
    process.env.TRACING_PROVIDER = 'langfuse';
    expect(detectTracingProvider()).toBe('langfuse');
  });

  it('should return "phoenix" when TRACING_PROVIDER=phoenix', () => {
    process.env.TRACING_PROVIDER = 'phoenix';
    expect(detectTracingProvider()).toBe('phoenix');
  });

  it('should return "none" when TRACING_PROVIDER=none', () => {
    process.env.TRACING_PROVIDER = 'none';
    expect(detectTracingProvider()).toBe('none');
  });

  it('should auto-detect "langfuse" when LANGFUSE_SECRET_KEY is set', () => {
    process.env.LANGFUSE_SECRET_KEY = 'lf-secret';
    expect(detectTracingProvider()).toBe('langfuse');
  });

  it('should auto-detect "phoenix" when PHOENIX_COLLECTOR_ENDPOINT is set', () => {
    process.env.PHOENIX_COLLECTOR_ENDPOINT = 'http://localhost:6006/v1/traces';
    expect(detectTracingProvider()).toBe('phoenix');
  });

  it('should return "none" when nothing is set', () => {
    expect(detectTracingProvider()).toBe('none');
  });

  it('should prefer explicit TRACING_PROVIDER over auto-detection', () => {
    process.env.TRACING_PROVIDER = 'none';
    process.env.LANGFUSE_SECRET_KEY = 'lf-secret';
    process.env.PHOENIX_COLLECTOR_ENDPOINT = 'http://localhost:6006/v1/traces';
    expect(detectTracingProvider()).toBe('none');
  });
});
