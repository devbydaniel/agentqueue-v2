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

/**
 * Phoenix is initialized in `register-instrumentation.ts` (before
 * `registerInstrumentations()`) so the Claude SDK instrumentation captures
 * a real tracer instead of a no-op. We only handle Langfuse here.
 *
 * Claude SDK auto-instrumentation lives in `register-instrumentation.ts`,
 * loaded by Node's `--import` flag. See that file for the rationale and
 * exit criteria.
 */

async function initTracing(): Promise<void> {
  const provider = detectTracingProvider();

  if (provider === 'none') return;

  if (provider === 'langfuse') await initLangfuse();
  // phoenix: already initialized in register-instrumentation.ts
}

export const tracingReady = initTracing();
