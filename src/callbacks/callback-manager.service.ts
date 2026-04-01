import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AgentSession } from '@mariozechner/pi-coding-agent';
import { CallbackHandler } from './callback-handler.interface.js';

export const CALLBACK_HANDLERS = Symbol('CALLBACK_HANDLERS');

@Injectable()
export class CallbackManager {
  private readonly logger = new Logger(CallbackManager.name);

  constructor(
    @Inject(CALLBACK_HANDLERS)
    private readonly handlers: CallbackHandler[],
  ) {
    this.logger.log('Registered callback handlers', {
      handlers: this.handlers.map((h) => h.name),
    });
  }

  /**
   * Subscribe all registered handlers to a session's event stream.
   *
   * @returns An unsubscribe function that detaches all handlers.
   */
  attachToSession(session: AgentSession): () => void {
    const unsubscribe = session.subscribe((event) => {
      for (const handler of this.handlers) {
        try {
          const result = handler.onEvent(event);
          if (result instanceof Promise) {
            result.catch((err) => {
              this.logger.error(
                `Async callback handler "${handler.name}" rejected`,
                { error: err as Error, eventType: event.type },
              );
            });
          }
        } catch (error) {
          this.logger.error(`Callback handler "${handler.name}" threw`, {
            error: error as Error,
            eventType: event.type,
          });
        }
      }
    });

    this.logger.debug('Attached callback handlers to session', {
      count: this.handlers.length,
    });

    return unsubscribe;
  }
}
