import { Injectable } from '@nestjs/common';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent' with {
  'resolution-mode': 'import',
};
import type { RunEventHandler } from '../callbacks/run-event-handler.interface.js';
import { SentenceChunker } from '../speech/sentence-chunker.js';
import { MatrixActiveCallsService } from './matrix-active-calls.service.js';

/**
 * Speaks a run's reply into the live call of its session as it streams:
 * text deltas are cut into sentences and each sentence is queued for speech
 * as soon as it is complete. The text itself still reaches the thread via
 * MatrixStreamingCallbackHandler.
 *
 * The call is looked up per sentence, so a hang-up mid-run just silences the
 * rest of the reply.
 */
export class MatrixCallCallbackHandler implements RunEventHandler {
  readonly name = 'matrix-call';
  private chunker = new SentenceChunker();

  constructor(
    private readonly activeCalls: MatrixActiveCallsService,
    private readonly sessionKey: string,
  ) {}

  onEvent(event: AgentSessionEvent): void {
    if (event.type === 'message_end') {
      if (event.message.role === 'assistant') this.flush();
      return;
    }
    if (event.type !== 'message_update') return;
    const update = event.assistantMessageEvent;
    if (update.type === 'text_start') this.flush();
    if (update.type === 'text_delta') this.say(this.chunker.push(update.delta));
  }

  onComplete(): void {
    this.flush();
  }

  private flush(): void {
    const rest = this.chunker.flush();
    if (rest) this.say([rest]);
    this.chunker = new SentenceChunker();
  }

  private say(chunks: string[]): void {
    if (chunks.length === 0) return;
    const voice = this.activeCalls.get(this.sessionKey);
    for (const chunk of chunks) voice?.speak(chunk);
  }
}

@Injectable()
export class MatrixCallCallbackHandlerFactory {
  constructor(private readonly activeCalls: MatrixActiveCallsService) {}

  /** A handler if the session is a call in progress, else undefined. */
  createForRun(sessionKey: string): MatrixCallCallbackHandler | undefined {
    if (!this.activeCalls.get(sessionKey)) return undefined;
    return new MatrixCallCallbackHandler(this.activeCalls, sessionKey);
  }
}
