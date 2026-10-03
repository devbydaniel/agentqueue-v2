import { randomUUID } from 'node:crypto';

/** Long-poll window for /sync; Synapse holds the request open this long. */
export const SYNC_TIMEOUT_MS = 30_000;

// Only room messages and membership matter to the bot; everything else is
// filtered server-side to keep sync responses small.
const SYNC_FILTER = JSON.stringify({
  presence: { types: [] },
  account_data: { types: [] },
  room: {
    state: { types: ['m.room.member'], lazy_load_members: true },
    timeline: { types: ['m.room.message'], limit: 50 },
    ephemeral: { types: [] },
    account_data: { types: [] },
  },
});

export interface MatrixEvent {
  event_id: string;
  type: string;
  sender: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  state_key?: string;
}

interface SyncRoom {
  timeline?: { events?: MatrixEvent[] };
}

interface InvitedRoom {
  invite_state?: { events?: MatrixEvent[] };
}

export interface SyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, SyncRoom>;
    invite?: Record<string, InvitedRoom>;
  };
}

export interface DownloadedMedia {
  data: Buffer;
  contentType: string | undefined;
}

export class MatrixApiError extends Error {
  constructor(
    readonly status: number,
    readonly errcode: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Minimal Matrix client-server API client for an unencrypted bot account.
 * Covers exactly what the connector needs: sync, send/edit, typing, media,
 * room account data. No E2EE — the homeserver is tailnet-only.
 */
export class MatrixClient {
  constructor(
    private readonly homeserverUrl: string,
    private readonly accessToken: string,
  ) {}

  async whoami(): Promise<string> {
    const body = await this.request<{ user_id: string }>(
      'GET',
      '/_matrix/client/v3/account/whoami',
    );
    return body.user_id;
  }

  sync(since: string | undefined, signal: AbortSignal): Promise<SyncResponse> {
    const params = new URLSearchParams({
      filter: SYNC_FILTER,
      timeout: String(since ? SYNC_TIMEOUT_MS : 0),
    });
    if (since) params.set('since', since);
    return this.request<SyncResponse>(
      'GET',
      `/_matrix/client/v3/sync?${params.toString()}`,
      undefined,
      signal,
    );
  }

  async joinRoom(roomId: string): Promise<void> {
    await this.request('POST', `/_matrix/client/v3/join/${enc(roomId)}`, {});
  }

  async sendMessage(
    roomId: string,
    content: Record<string, unknown>,
  ): Promise<string> {
    const body = await this.request<{ event_id: string }>(
      'PUT',
      `/_matrix/client/v3/rooms/${enc(roomId)}/send/m.room.message/${randomUUID()}`,
      content,
    );
    return body.event_id;
  }

  async setTyping(
    roomId: string,
    userId: string,
    typing: boolean,
    timeoutMs: number,
  ): Promise<void> {
    await this.request(
      'PUT',
      `/_matrix/client/v3/rooms/${enc(roomId)}/typing/${enc(userId)}`,
      typing ? { typing: true, timeout: timeoutMs } : { typing: false },
    );
  }

  getEvent(roomId: string, eventId: string): Promise<MatrixEvent> {
    return this.request<MatrixEvent>(
      'GET',
      `/_matrix/client/v3/rooms/${enc(roomId)}/event/${enc(eventId)}`,
    );
  }

  async getRoomAccountData<T>(
    userId: string,
    roomId: string,
    type: string,
  ): Promise<T | undefined> {
    try {
      return await this.request<T>(
        'GET',
        `/_matrix/client/v3/user/${enc(userId)}/rooms/${enc(roomId)}/account_data/${enc(type)}`,
      );
    } catch (error) {
      if (error instanceof MatrixApiError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async setRoomAccountData(
    userId: string,
    roomId: string,
    type: string,
    content: Record<string, unknown>,
  ): Promise<void> {
    await this.request(
      'PUT',
      `/_matrix/client/v3/user/${enc(userId)}/rooms/${enc(roomId)}/account_data/${enc(type)}`,
      content,
    );
  }

  /** Download via the authenticated media API (`mxc://server/mediaId`). */
  async downloadMedia(mxcUrl: string): Promise<DownloadedMedia> {
    const match = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(mxcUrl);
    if (!match) throw new Error(`Not an mxc:// URL: ${mxcUrl}`);
    const response = await fetch(
      `${this.homeserverUrl}/_matrix/client/v1/media/download/${enc(match[1])}/${enc(match[2])}`,
      { headers: this.authHeaders() },
    );
    if (!response.ok) {
      throw new MatrixApiError(
        response.status,
        undefined,
        `Matrix media download failed (${response.status})`,
      );
    }
    return {
      data: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? undefined,
    };
  }

  async uploadMedia(
    data: Buffer,
    contentType: string,
    fileName: string,
  ): Promise<string> {
    const response = await fetch(
      `${this.homeserverUrl}/_matrix/media/v3/upload?filename=${enc(fileName)}`,
      {
        method: 'POST',
        headers: { ...this.authHeaders(), 'Content-Type': contentType },
        body: new Uint8Array(data),
      },
    );
    const body = (await response.json()) as {
      content_uri?: string;
      errcode?: string;
      error?: string;
    };
    if (!response.ok || !body.content_uri) {
      throw new MatrixApiError(
        response.status,
        body.errcode,
        `Matrix media upload failed (${response.status}): ${body.error ?? 'unknown error'}`,
      );
    }
    return body.content_uri;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetch(`${this.homeserverUrl}${path}`, {
      method,
      headers: {
        ...this.authHeaders(),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    const parsed = (text ? JSON.parse(text) : {}) as T & {
      errcode?: string;
      error?: string;
    };
    if (!response.ok) {
      throw new MatrixApiError(
        response.status,
        parsed.errcode,
        `Matrix ${method} ${path.split('?')[0]} failed (${response.status}): ${parsed.error ?? text}`,
      );
    }
    return parsed;
  }
}

function enc(value: string): string {
  return encodeURIComponent(value);
}
