export default async function globalTeardown() {
  const container = (globalThis as Record<string, unknown>)
    .__POSTGRES_CONTAINER__ as { stop(): Promise<void> } | undefined;
  if (container) {
    await container.stop();
  }
}
