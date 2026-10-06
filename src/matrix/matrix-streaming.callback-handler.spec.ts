import { MatrixStreamingCallbackHandler } from './matrix-streaming.callback-handler.js';
import type { MatrixService } from './matrix.service.js';
import { MAX_MESSAGE_CHARS } from './matrix-content.js';
import {
  assistantText,
  assistantToolCall,
  messageUpdate,
  toolResult,
} from '../callbacks/handlers/__tests__/pi-event.fixtures.js';

describe('MatrixStreamingCallbackHandler', () => {
  let sendMessage: jest.Mock;
  let matrixService: {
    getClient: jest.Mock;
    stopTyping: jest.Mock;
    isVoiceEnabled: jest.Mock;
    sendVoiceNote: jest.Mock;
  };
  let handler: MatrixStreamingCallbackHandler;
  const target = {
    botName: 'assistant',
    roomId: '!r:hs',
    threadRootId: '$root',
  };

  beforeEach(() => {
    jest.useFakeTimers();
    let n = 0;
    sendMessage = jest
      .fn()
      .mockImplementation(() => Promise.resolve(`$m${++n}`));
    matrixService = {
      getClient: jest.fn().mockReturnValue({ sendMessage }),
      stopTyping: jest.fn(),
      isVoiceEnabled: jest.fn().mockResolvedValue(false),
      sendVoiceNote: jest.fn().mockResolvedValue(undefined),
    };
    handler = new MatrixStreamingCallbackHandler(
      matrixService as unknown as MatrixService,
      target,
      'matrix:assistant:!r:hs:$root',
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('ignores non-assistant events, streaming partials, and text-less turns', async () => {
    handler.onEvent(toolResult('tc-1', 'output'));
    handler.onEvent(messageUpdate());
    handler.onEvent(assistantToolCall('bash', { command: 'ls' }));
    await jest.advanceTimersByTimeAsync(1500);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('posts into the thread first, then edits in place', async () => {
    handler.onEvent(assistantText('first'));
    await jest.advanceTimersByTimeAsync(1001);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [roomId, posted] = sendMessage.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(roomId).toBe('!r:hs');
    expect(posted['body']).toBe('first');
    expect(posted['m.relates_to']).toMatchObject({
      rel_type: 'm.thread',
      event_id: '$root',
    });

    handler.onEvent(assistantText('second'));
    await handler.finalize();
    const edit = sendMessage.mock.calls[1][1] as Record<string, unknown>;
    expect(edit['m.relates_to']).toEqual({
      rel_type: 'm.replace',
      event_id: '$m1',
    });
    expect((edit['m.new_content'] as Record<string, unknown>)['body']).toBe(
      'first\n\nsecond',
    );
    expect(matrixService.stopTyping).toHaveBeenCalledWith(
      'matrix:assistant:!r:hs:$root',
    );
  });

  it('sends a fallback when the run produced no text', async () => {
    await handler.finalize();
    expect(
      (sendMessage.mock.calls[0][1] as Record<string, unknown>)['body'],
    ).toBe('Completed.');
  });

  it('continues oversized output in a new message', async () => {
    const line = 'y'.repeat(1000);
    const long = Array.from({ length: 20 }, () => line).join('\n');
    handler.onEvent(assistantText(long));
    await handler.finalize();
    const bodies = sendMessage.mock.calls.map(
      (call) => (call[1] as Record<string, unknown>)['body'] as string,
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0].length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(`${bodies[0]}\n${bodies[1]}`).toBe(long);
  });

  it('appends errors to the streamed message', async () => {
    handler.onEvent(assistantText('partial'));
    await jest.advanceTimersByTimeAsync(1001);
    await handler.emitError('boom');
    const edit = sendMessage.mock.calls[1][1] as Record<string, unknown>;
    expect((edit['m.new_content'] as Record<string, unknown>)['body']).toBe(
      'partial\n\n⚠️ boom',
    );
  });

  it('speaks the last assistant message when voice mode is on', async () => {
    matrixService.isVoiceEnabled.mockResolvedValue(true);
    handler.onEvent(assistantText('thinking out loud'));
    handler.onEvent(assistantText('the answer'));
    await handler.finalize();
    expect(matrixService.sendVoiceNote).toHaveBeenCalledWith(
      target,
      'the answer',
    );
  });
});
