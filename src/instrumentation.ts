import 'dotenv/config';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';

/**
 * Initialize OpenTelemetry with the Langfuse span processor.
 *
 * Must be imported before any traced code runs.
 * When LANGFUSE_* env vars are not set, the processor will log warnings
 * but won't break the application.
 */
const sdk = new NodeSDK({
  spanProcessors: [new LangfuseSpanProcessor()],
});

sdk.start();
