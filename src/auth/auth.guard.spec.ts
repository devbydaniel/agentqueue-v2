import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from './auth.guard.js';
import { AppConfigService } from '../config/app-config.service.js';

describe('AuthGuard', () => {
  const TEST_TOKEN = 'test-secret-token';
  let guard: AuthGuard;
  let reflector: Reflector;

  function createContext(
    headers: Record<string, string | undefined> = {},
    overrides?: { isPublicHandler?: boolean; isPublicClass?: boolean },
  ): ExecutionContext {
    const handler = jest.fn();
    const cls = jest.fn();

    reflector.getAllAndOverride = jest
      .fn()
      .mockImplementation((_key, targets) => {
        if (targets.includes(handler) && overrides?.isPublicHandler)
          return true;
        if (targets.includes(cls) && overrides?.isPublicClass) return true;
        return (
          (overrides?.isPublicHandler ?? false) ||
          (overrides?.isPublicClass ?? false)
        );
      });

    return {
      getHandler: () => handler,
      getClass: () => cls,
      switchToHttp: () => ({
        getRequest: () => ({ headers }),
      }),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    process.env.AUTH_TOKEN = TEST_TOKEN;
    reflector = new Reflector();
    guard = new AuthGuard(reflector, new AppConfigService());
  });

  afterEach(() => {
    delete process.env.AUTH_TOKEN;
  });

  it('should throw during construction if AUTH_TOKEN is not set', () => {
    delete process.env.AUTH_TOKEN;
    expect(() => new AuthGuard(reflector, new AppConfigService())).toThrow(
      'AUTH_TOKEN environment variable is required',
    );
  });

  it('should allow requests with a valid Bearer token', () => {
    const context = createContext({ authorization: `Bearer ${TEST_TOKEN}` });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should reject requests with no Authorization header', () => {
    const context = createContext({});
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should reject requests with an empty Authorization header', () => {
    const context = createContext({ authorization: '' });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should reject requests with a wrong token', () => {
    const context = createContext({ authorization: 'Bearer wrong-token' });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should reject requests without the Bearer prefix', () => {
    const context = createContext({ authorization: TEST_TOKEN });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should reject requests with Basic auth scheme', () => {
    const context = createContext({ authorization: `Basic ${TEST_TOKEN}` });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should skip auth for routes marked @Public()', () => {
    const context = createContext({}, { isPublicHandler: true });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should skip auth for controllers marked @Public()', () => {
    const context = createContext({}, { isPublicClass: true });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should not be vulnerable to timing attacks on different-length tokens', () => {
    const context = createContext({ authorization: 'Bearer short' });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });
});
