import { SlackService, parseSlackSessionKey } from './slack.service.js';
import type { WebClient } from '@slack/web-api';

describe('SlackService', () => {
  let service: SlackService;
  let postMessage: jest.Mock;
  let setStatus: jest.Mock;
  let client: WebClient;

  beforeEach(() => {
    postMessage = jest.fn().mockResolvedValue({ ok: true, ts: '123.456' });
    setStatus = jest.fn().mockResolvedValue({ ok: true });
    client = {
      chat: { postMessage },
      assistant: { threads: { setStatus } },
    } as unknown as WebClient;
    service = new SlackService();
    service.registerClient('main-bot', client);
  });

  it('sends a single message below the chunk size', async () => {
    await service.sendDirectMessage({
      botName: 'main-bot',
      channelId: 'C123',
      text: 'hello',
      threadTs: '111.222',
    });

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      text: 'hello',
      thread_ts: '111.222',
    });
  });

  it('splits long text into multiple posts', async () => {
    const longText = 'A' + '\nB'.repeat(20_000);
    await service.sendDirectMessage({
      botName: 'main-bot',
      channelId: 'C123',
      text: longText,
    });
    expect(postMessage.mock.calls.length).toBeGreaterThan(1);
  });

  it('silently no-ops when no client is registered', async () => {
    await service.sendDirectMessage({
      botName: 'unknown',
      channelId: 'C123',
      text: 'hello',
    });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('sets the assistant thread status', async () => {
    await service.setStatus({
      botName: 'main-bot',
      channelId: 'C123',
      threadTs: '111.222',
      status: 'Thinking…',
    });
    expect(setStatus).toHaveBeenCalledWith({
      channel_id: 'C123',
      thread_ts: '111.222',
      status: 'Thinking…',
    });
  });

  it('swallows setStatus errors', async () => {
    setStatus.mockRejectedValueOnce(new Error('not an assistant thread'));
    await expect(
      service.setStatus({
        botName: 'main-bot',
        channelId: 'C123',
        threadTs: '111.222',
        status: 'Thinking…',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('parseSlackSessionKey', () => {
  it('parses a session key with threadTs', () => {
    expect(parseSlackSessionKey('slack:main-bot:C123:111.222')).toEqual({
      botName: 'main-bot',
      channelId: 'C123',
      threadTs: '111.222',
    });
  });

  it('returns undefined threadTs for main sentinel', () => {
    expect(parseSlackSessionKey('slack:main-bot:C123:main')).toEqual({
      botName: 'main-bot',
      channelId: 'C123',
      threadTs: undefined,
    });
  });

  it('returns null for non-slack keys', () => {
    expect(parseSlackSessionKey('telegram:bot:chat:main')).toBeNull();
  });
});
