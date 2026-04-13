export type TracingProvider = 'langfuse' | 'phoenix' | 'none';

export function detectTracingProvider(): TracingProvider {
  const explicit = process.env.TRACING_PROVIDER;
  if (explicit === 'langfuse' || explicit === 'phoenix' || explicit === 'none')
    return explicit;
  if (process.env.LANGFUSE_SECRET_KEY) return 'langfuse';
  if (process.env.PHOENIX_COLLECTOR_ENDPOINT) return 'phoenix';
  return 'none';
}
