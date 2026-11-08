import { AuthenticationLinearError, type LinearClient } from '@linear/sdk';
import { LinearAuthService } from './linear-auth.service.js';
import type { LinearTrigger } from '../config/trigger-config.interface.js';

const DAY_SECONDS = 24 * 60 * 60;

function makeTrigger(overrides: Partial<LinearTrigger> = {}): LinearTrigger {
  return {
    name: 'ayc-dev',
    type: 'linear',
    cwd: '/tmp',
    signing_secret: 'signing',
    client_id: 'client-id',
    client_secret: 'client-secret',
    ...overrides,
  };
}

function tokenResponse(token: string, expiresIn = 30 * DAY_SECONDS): Response {
  return new Response(
    JSON.stringify({ access_token: token, expires_in: expiresIn }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('LinearAuthService', () => {
  let service: LinearAuthService;
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    service = new LinearAuthService();
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('getApiKey', () => {
    it('returns a static api_key without requesting a token', async () => {
      const trigger = makeTrigger({
        api_key: 'lin_api_static',
        client_id: undefined,
        client_secret: undefined,
      });

      await expect(service.getApiKey(trigger)).resolves.toBe('lin_api_static');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('requests a client-credentials token with basic auth and fixed scopes', async () => {
      fetchMock.mockResolvedValue(tokenResponse('tok-1'));

      await expect(service.getApiKey(makeTrigger())).resolves.toBe('tok-1');

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.linear.app/oauth/token');
      expect(init?.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
      });
      const body = init?.body as URLSearchParams;
      expect(body.get('grant_type')).toBe('client_credentials');
      expect(body.get('scope')).toBe(
        'read,write,app:assignable,app:mentionable',
      );
    });

    it('reuses the cached token while it is far from expiry', async () => {
      fetchMock.mockResolvedValue(tokenResponse('tok-1'));

      await service.getApiKey(makeTrigger());
      await service.getApiKey(makeTrigger());

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('renews the token shortly before it expires', async () => {
      jest.useFakeTimers({ now: 0 });
      fetchMock
        .mockResolvedValueOnce(tokenResponse('tok-1'))
        .mockResolvedValueOnce(tokenResponse('tok-2'));

      await service.getApiKey(makeTrigger());
      jest.setSystemTime(29 * DAY_SECONDS * 1000);

      await expect(service.getApiKey(makeTrigger())).resolves.toBe('tok-2');
    });

    it('shares one token request between concurrent callers', async () => {
      fetchMock.mockResolvedValue(tokenResponse('tok-1'));

      const keys = await Promise.all([
        service.getApiKey(makeTrigger()),
        service.getApiKey(makeTrigger()),
      ]);

      expect(keys).toEqual(['tok-1', 'tok-1']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws when Linear refuses the token request', async () => {
      fetchMock.mockResolvedValue(
        new Response('invalid_client', { status: 401 }),
      );

      await expect(service.getApiKey(makeTrigger())).rejects.toThrow(
        'Linear token request failed (401): invalid_client',
      );
    });
  });

  describe('withClient', () => {
    it('retries once with a new token when Linear rejects the cached one', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenResponse('tok-1'))
        .mockResolvedValueOnce(tokenResponse('tok-2'));
      const usedKeys: string[] = [];
      const fn = jest.fn((client: LinearClient) => {
        usedKeys.push(
          new Headers(client.options.headers).get('Authorization') ?? '',
        );
        if (usedKeys.length === 1) {
          return Promise.reject(new AuthenticationLinearError());
        }
        return Promise.resolve('ok');
      });

      await expect(service.withClient(makeTrigger(), fn)).resolves.toBe('ok');
      expect(usedKeys).toEqual(['tok-1', 'tok-2']);
    });

    it('does not retry other errors', async () => {
      fetchMock.mockResolvedValue(tokenResponse('tok-1'));
      const fn = jest.fn(() => Promise.reject(new Error('boom')));

      await expect(service.withClient(makeTrigger(), fn)).rejects.toThrow(
        'boom',
      );
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});
