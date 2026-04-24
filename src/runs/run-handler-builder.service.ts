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
import { TracingEnrichmentHandlerFactory } from '../callbacks/handlers/tracing-enrichment.callback-handler.js';
import { RunEventCallbackHandler } from '../callbacks/handlers/run-event.callback-handler.js';
import { RunEventRepository } from './run-event.repository.js';

export interface RunHandlerBundle {
  additionalHandlers: RunEventHandler[];
  linearHandler: LinearCallbackHandler | undefined;
  assistantMessageHandler: AssistantMessageCallbackHandler | undefined;
  slackStreamingHandler: SlackStreamingCallbackHandler | undefined;
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
    private readonly tracingFactory: TracingEnrichmentHandlerFactory,
    private readonly runEventRepository: RunEventRepository,
  ) {}

  buildForRun(run: BuildableRun): RunHandlerBundle {
    const additionalHandlers: RunEventHandler[] = [];
    let linearHandler: LinearCallbackHandler | undefined;
    let assistantMessageHandler: AssistantMessageCallbackHandler | undefined;
    let slackStreamingHandler: SlackStreamingCallbackHandler | undefined;

    if (run.source === 'linear' && run.externalSessionId && run.triggerName) {
      linearHandler = this.linearFactory.createForRun(
        run.triggerName,
        run.externalSessionId,
      );
      if (linearHandler) {
        additionalHandlers.push(linearHandler);
      }
    }

    if (run.source === 'telegram' && run.externalSessionId && run.triggerName) {
      assistantMessageHandler = new AssistantMessageCallbackHandler();
      additionalHandlers.push(assistantMessageHandler);
    }

    if (run.source === 'slack' && run.externalSessionId && run.triggerName) {
      slackStreamingHandler = this.slackStreamingFactory.createForRun(
        run.triggerName,
        run.externalSessionId,
      );
      if (slackStreamingHandler) {
        additionalHandlers.push(slackStreamingHandler);
      }
    }

    const { handler: tracingHandler, traceContext } =
      this.tracingFactory.createForRun(run);
    additionalHandlers.push(tracingHandler);
    additionalHandlers.push(
      new RunEventCallbackHandler(run.id, this.runEventRepository),
    );

    return {
      additionalHandlers,
      linearHandler,
      assistantMessageHandler,
      slackStreamingHandler,
      traceContext,
    };
  }

  wrapWithTraceContext<T>(
    traceContext: TraceContext,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.tracingFactory.wrapWithContext(traceContext, fn);
  }
}
