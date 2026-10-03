import { Injectable } from '@nestjs/common';
import type { RunEventHandler } from '../callbacks/run-event-handler.interface.js';
import type {
  TraceContext,
  TraceableRun,
} from '../callbacks/build-trace-context.js';
import { AssistantMessageCallbackHandler } from '../callbacks/handlers/assistant-message.callback-handler.js';
import {
  LinearCallbackHandler,
  LinearCallbackHandlerFactory,
} from '../callbacks/handlers/linear.callback-handler.js';
import {
  SlackStreamingCallbackHandler,
  SlackStreamingCallbackHandlerFactory,
} from '../slack/slack-streaming.callback-handler.js';
import {
  MatrixStreamingCallbackHandler,
  MatrixStreamingCallbackHandlerFactory,
} from '../matrix/matrix-streaming.callback-handler.js';
import { TracingEnrichmentHandlerFactory } from '../callbacks/handlers/tracing-enrichment.callback-handler.js';
import { RunEventCallbackHandler } from '../callbacks/handlers/run-event.callback-handler.js';
import { RunEventRepository } from './run-event.repository.js';

interface SourceHandlers {
  linearHandler: LinearCallbackHandler | undefined;
  assistantMessageHandler: AssistantMessageCallbackHandler | undefined;
  slackStreamingHandler: SlackStreamingCallbackHandler | undefined;
  matrixStreamingHandler: MatrixStreamingCallbackHandler | undefined;
}

export interface RunHandlerBundle extends SourceHandlers {
  additionalHandlers: RunEventHandler[];
  traceContext: TraceContext;
}

type BuildableRun = TraceableRun & {
  id: string;
  source: string;
  externalSessionId: string | null;
  triggerName: string | null;
};

@Injectable()
export class RunHandlerBuilder {
  constructor(
    private readonly linearFactory: LinearCallbackHandlerFactory,
    private readonly slackStreamingFactory: SlackStreamingCallbackHandlerFactory,
    private readonly matrixStreamingFactory: MatrixStreamingCallbackHandlerFactory,
    private readonly tracingFactory: TracingEnrichmentHandlerFactory,
    private readonly runEventRepository: RunEventRepository,
  ) {}

  buildForRun(run: BuildableRun): RunHandlerBundle {
    const sourceHandlers = this.buildSourceHandlers(run);
    const { handler: tracingHandler, traceContext } =
      this.tracingFactory.createForRun(run);
    const additionalHandlers: RunEventHandler[] = [
      ...Object.values(sourceHandlers).filter(
        (h): h is RunEventHandler => h !== undefined,
      ),
      tracingHandler,
      new RunEventCallbackHandler(run.id, this.runEventRepository),
    ];

    return { additionalHandlers, ...sourceHandlers, traceContext };
  }

  /** Handlers that deliver a run's output back to the channel it came from. */
  private buildSourceHandlers(run: BuildableRun): SourceHandlers {
    const handlers: SourceHandlers = {
      linearHandler: undefined,
      assistantMessageHandler: undefined,
      slackStreamingHandler: undefined,
      matrixStreamingHandler: undefined,
    };
    const { externalSessionId, triggerName } = run;
    if (!externalSessionId || !triggerName) return handlers;

    switch (run.source) {
      case 'linear':
        handlers.linearHandler = this.linearFactory.createForRun(
          triggerName,
          externalSessionId,
        );
        break;
      case 'telegram':
        handlers.assistantMessageHandler =
          new AssistantMessageCallbackHandler();
        break;
      case 'slack':
        handlers.slackStreamingHandler =
          this.slackStreamingFactory.createForRun(
            triggerName,
            externalSessionId,
          );
        break;
      case 'matrix':
        handlers.matrixStreamingHandler =
          this.matrixStreamingFactory.createForRun(
            triggerName,
            externalSessionId,
          );
        break;
    }
    return handlers;
  }

  wrapWithTraceContext<T>(
    traceContext: TraceContext,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.tracingFactory.wrapWithContext(traceContext, fn);
  }
}
