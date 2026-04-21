import 'dotenv/config';
import { detectTracingProvider } from './config/detect-tracing-provider.js';

/**
 * Initialize OpenTelemetry tracing with the configured provider.
 *
 * Must be imported before any traced code runs (first import in main.ts).
 * Provider is selected via TRACING_PROVIDER env var, with auto-detection
 * fallback from LANGFUSE_SECRET_KEY / PHOENIX_COLLECTOR_ENDPOINT.
 */

async function initLangfuse(): Promise<void> {
  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } =
    await import('@opentelemetry/exporter-trace-otlp-http');
  const { SimpleSpanProcessor } = await import('@opentelemetry/sdk-trace-base');

  const baseUrl = process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com';
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY ?? '';
  const secretKey = process.env.LANGFUSE_SECRET_KEY ?? '';

  if (!secretKey) {
    console.warn(
      '[instrumentation] TRACING_PROVIDER=langfuse but LANGFUSE_SECRET_KEY is not set — traces will be rejected',
    );
  }

  const authString = Buffer.from(`${publicKey}:${secretKey}`).toString(
    'base64',
  );

  const exporter = new OTLPTraceExporter({
    url: `${baseUrl}/api/public/otel/v1/traces`,
    headers: { Authorization: `Basic ${authString}` },
  });

  const sdk = new NodeSDK({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  sdk.start();
}

async function initPhoenix(): Promise<void> {
  const { register } = await import('@arizeai/phoenix-otel');

  register({
    projectName: process.env.PHOENIX_PROJECT_NAME ?? 'agentqueue',
    url:
      process.env.PHOENIX_COLLECTOR_ENDPOINT ??
      'http://localhost:6006/v1/traces',
  });
}

async function instrumentClaudeSDK(): Promise<void> {
  const { ClaudeAgentSDKInstrumentation } =
    await import('@arizeai/openinference-instrumentation-claude-agent-sdk');
  const ClaudeAgentSDK = await import('@anthropic-ai/claude-agent-sdk');

  const instrumentation = new ClaudeAgentSDKInstrumentation();
  instrumentation.manuallyInstrument(ClaudeAgentSDK);
}

async function initTracing(): Promise<void> {
  const provider = detectTracingProvider();

  if (provider === 'none') return;

  if (provider === 'langfuse') await initLangfuse();
  if (provider === 'phoenix') await initPhoenix();

  await instrumentClaudeSDK();
}

export const tracingReady = initTracing();
