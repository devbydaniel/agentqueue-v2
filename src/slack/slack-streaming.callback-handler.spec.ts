import { SlackStreamingCallbackHandler } from './slack-streaming.callback-handler.js';
import { SlackService } from './slack.service.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

function assistantMessage(text: string): SDKMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
    parent_tool_use_id: null,
  } as unknown as SDKMessage;
}

function subagentMessage(text: string): SDKMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
    parent_tool_use_id: 'tool-123',
  } as unknown as SDKMessage;
}

describe('SlackStreamingCallbackHandler', () => {
  let slackService: SlackService;
  let postMessage: jest.Mock;
  let chatUpdate: jest.Mock;
  let setStatus: jest.Mock;
  let handler: SlackStreamingCallbackHandler;

  beforeEach(() => {
    jest.useFakeTimers();
    postMessage = jest.fn().mockResolvedValue({ ok: true, ts: 'msg-1' });
    chatUpdate = jest.fn().mockResolvedValue({ ok: true });
    setStatus = jest.fn().mockResolvedValue({ ok: true });
    const client = {
      chat: { postMessage, update: chatUpdate },
      assistant: { threads: { setStatus } },
    };
    slackService = new SlackService();
    slackService.registerClient(
      'main-bot',
      client as unknown as Parameters<SlackService['registerClient']>[1],
    );
    handler = new SlackStreamingCallbackHandler(
      slackService,
      'main-bot',
      'C123',
      '111.222',
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('skips non-assistant messages', () => {
    handler.onMessage({ type: 'user' } as unknown as SDKMessage);
    jest.advanceTimersByTime(2000);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('skips subagent messages', () => {
    handler.onMessage(subagentMessage('subagent'));
    jest.advanceTimersByTime(2000);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('posts the first chunk and updates on subsequent chunks', async () => {
    handler.onMessage(assistantMessage('first'));
    await jest.advanceTimersByTimeAsync(1001);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      text: 'first',
      thread_ts: '111.222',
    });

    handler.onMessage(assistantMessage('second'));
    await jest.advanceTimersByTimeAsync(1001);
    expect(chatUpdate).toHaveBeenCalledTimes(1);
    expect(chatUpdate).toHaveBeenCalledWith({
      channel: 'C123',
      ts: 'msg-1',
      text: 'first\n\nsecond',
    });
  });

  it('finalize flushes any pending buffer and clears status', async () => {
    handler.onMessage(assistantMessage('hello'));
    await handler.finalize();

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello' }),
    );
    expect(setStatus).toHaveBeenCalledWith({
      channel_id: 'C123',
      thread_ts: '111.222',
      status: '',
    });
  });

  it('emitError appends a warning block and clears status', async () => {
    handler.onMessage(assistantMessage('partial'));
    await handler.emitError('boom');

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'partial\n\n:warning: boom',
      }),
    );
    expect(setStatus).toHaveBeenCalledWith({
      channel_id: 'C123',
      thread_ts: '111.222',
      status: '',
    });
  });

  it('emitError without prior content still posts a warning', async () => {
    await handler.emitError('boom');

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: ':warning: boom' }),
    );
  });
});
