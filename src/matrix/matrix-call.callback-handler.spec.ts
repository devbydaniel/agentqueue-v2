import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent' with {
  'resolution-mode': 'import',
};
import {
  assistantMessage,
  assistantText,
  userText,
} from '../callbacks/handlers/__tests__/pi-event.fixtures.js';
import { MatrixActiveCallsService } from './matrix-active-calls.service.js';
import { MatrixCallCallbackHandlerFactory } from './matrix-call.callback-handler.js';

const SESSION = 'matrix:assistant:!call:hs:$root';

function update(
  assistantMessageEvent: Record<string, unknown>,
): AgentSessionEvent {
  const message = assistantMessage([]);
  return {
    type: 'message_update',
    message,
    assistantMessageEvent: {
      contentIndex: 0,
      partial: message,
      ...assistantMessageEvent,
    },
  } as AgentSessionEvent;
}

const delta = (text: string): AgentSessionEvent =>
  update({ type: 'text_delta', delta: text });

describe('MatrixCallCallbackHandler', () => {
  let activeCalls: MatrixActiveCallsService;
  let factory: MatrixCallCallbackHandlerFactory;
  let speak: jest.Mock;

  beforeEach(() => {
    activeCalls = new MatrixActiveCallsService();
    factory = new MatrixCallCallbackHandlerFactory(activeCalls);
    speak = jest.fn();
  });

  it('is only created for sessions with a call in progress', () => {
    expect(factory.createForRun(SESSION)).toBeUndefined();
    activeCalls.register(SESSION, { speak });
    expect(factory.createForRun(SESSION)).toBeDefined();
  });

  it('speaks each sentence as soon as it is complete', () => {
    activeCalls.register(SESSION, { speak });
    const handler = factory.createForRun(SESSION)!;

    handler.onEvent(delta('Morgen wird es sonnig '));
    handler.onEvent(delta('und warm. Am Abend '));
    expect(speak.mock.calls).toEqual([['Morgen wird es sonnig und warm.']]);

    handler.onEvent(delta('regnet es.'));
    handler.onEvent(
      assistantText('Morgen wird es sonnig und warm. Am Abend regnet es.'),
    );
    expect(speak.mock.calls).toEqual([
      ['Morgen wird es sonnig und warm.'],
      ['Am Abend regnet es.'],
    ]);
  });

  it('flushes text left over at a new text block and at the end of the run', () => {
    activeCalls.register(SESSION, { speak });
    const handler = factory.createForRun(SESSION)!;

    handler.onEvent(delta('Ich schaue nach'));
    handler.onEvent(update({ type: 'text_start' }));
    handler.onEvent(delta('Gefunden'));
    handler.onComplete();
    expect(speak.mock.calls).toEqual([['Ich schaue nach'], ['Gefunden']]);
  });

  it('ignores thinking, user messages and other events', () => {
    activeCalls.register(SESSION, { speak });
    const handler = factory.createForRun(SESSION)!;

    handler.onEvent(
      update({ type: 'thinking_delta', delta: 'Hmm. Lass mich überlegen. ' }),
    );
    handler.onEvent(userText('Neue Frage'));
    handler.onComplete();
    expect(speak).not.toHaveBeenCalled();
  });

  it('goes silent once the call has ended', () => {
    const voice = { speak };
    activeCalls.register(SESSION, voice);
    const handler = factory.createForRun(SESSION)!;
    activeCalls.unregister(SESSION, voice);

    handler.onEvent(delta('Noch ein Satz für niemanden. '));
    handler.onComplete();
    expect(speak).not.toHaveBeenCalled();
  });
});
