import { Injectable, Logger } from '@nestjs/common';
import { AuthenticationLinearError, LinearClient } from '@linear/sdk';
import type { LinearTrigger } from '../config/trigger-config.interface.js';

const TOKEN_URL = 'https://api.linear.app/oauth/token';

/**
 * Scopes for every client-credentials token. Linear replaces an app's existing
 * tokens when a request asks for a different scope set, so this stays fixed.
 */
const SCOPES = 'read,write,app:assignable,app:mentionable';

/** Renew this long before expiry, so a run never starts on a token about to lapse. */
const RENEW_BEFORE_MS = 2 * 24 * 60 * 60 * 1000;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

/** The part of the Linear client the agent-session callbacks use. */
export interface LinearActivityClient {
  createAgentActivity(
    input: Parameters<LinearClient['createAgentActivity']>[0],
  ): Promise<unknown>;
}

/**
 * Resolves the Linear credential for a trigger: its static `api_key`, or a
 * client-credentials token for its OAuth app. Tokens are cached per app,
 * renewed before they expire, and re-requested once when Linear rejects one
 * (Linear can revoke tokens early, e.g. on secret rotation).
 */
@Injectable()
export class LinearAuthService {
  private readonly logger = new Logger(LinearAuthService.name);
  private readonly tokens = new Map<string, CachedToken>();
  private readonly pending = new Map<string, Promise<CachedToken>>();

  async getApiKey(trigger: LinearTrigger): Promise<string> {
    if (trigger.api_key) return trigger.api_key;
    const credentials = this.clientCredentialsOf(trigger);
    const cached = this.tokens.get(credentials.clientId);
    if (cached && cached.expiresAt - Date.now() > RENEW_BEFORE_MS) {
      return cached.accessToken;
    }
    return (await this.requestToken(credentials)).accessToken;
  }

  /** Runs `fn` with a client for the trigger, retrying once with a fresh token on an auth error. */
  async withClient<T>(
    trigger: LinearTrigger,
    fn: (client: LinearClient) => Promise<T>,
  ): Promise<T> {
    const apiKey = await this.getApiKey(trigger);
    try {
      return await fn(new LinearClient({ apiKey }));
    } catch (error) {
      if (trigger.api_key || !(error instanceof AuthenticationLinearError)) {
        throw error;
      }
      this.logger.warn(
        'Linear rejected the cached token, requesting a new one',
        {
          trigger: trigger.name,
        },
      );
      this.tokens.delete(this.clientCredentialsOf(trigger).clientId);
      return fn(new LinearClient({ apiKey: await this.getApiKey(trigger) }));
    }
  }

  activityClient(trigger: LinearTrigger): LinearActivityClient {
    return {
      createAgentActivity: (input) =>
        this.withClient(trigger, (client) => client.createAgentActivity(input)),
    };
  }

  // Concurrent callers for the same app share one token request.
  private requestToken(credentials: ClientCredentials): Promise<CachedToken> {
    const inflight = this.pending.get(credentials.clientId);
    if (inflight) return inflight;

    const request = this.fetchToken(credentials)
      .then((token) => {
        this.tokens.set(credentials.clientId, token);
        return token;
      })
      .finally(() => this.pending.delete(credentials.clientId));
    this.pending.set(credentials.clientId, request);
    return request;
  }

  private async fetchToken(
    credentials: ClientCredentials,
  ): Promise<CachedToken> {
    const basic = Buffer.from(
      `${credentials.clientId}:${credentials.clientSecret}`,
    ).toString('base64');
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: SCOPES,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Linear token request failed (${response.status}): ${await response.text()}`,
      );
    }
    const body = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.logger.log('Obtained Linear client-credentials token', {
      clientId: credentials.clientId,
      expiresInSeconds: body.expires_in,
    });
    return {
      accessToken: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    };
  }

  private clientCredentialsOf(trigger: LinearTrigger): ClientCredentials {
    if (!trigger.client_id || !trigger.client_secret) {
      throw new Error(
        `Linear trigger "${trigger.name}" has neither api_key nor client credentials`,
      );
    }
    return {
      clientId: trigger.client_id,
      clientSecret: trigger.client_secret,
    };
  }
}
