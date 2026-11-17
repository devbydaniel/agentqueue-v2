import type { QueueConfig } from '../trigger-config.interface.js';
import { RUNS_QUEUE_NAME } from '../../runs/runs.constants.js';

// pg-boss allows these characters in queue names (see its assertObjectName).
const QUEUE_NAME_PATTERN = /^[\w.\-/]+$/;

const parseQueue = (name: string, value: unknown): QueueConfig => {
  if (name === RUNS_QUEUE_NAME) {
    throw new Error(
      `Queue "${RUNS_QUEUE_NAME}" is the default queue; set its concurrency with QUEUE_CONCURRENCY`,
    );
  }
  if (!QUEUE_NAME_PATTERN.test(name)) {
    throw new Error(
      `Queue "${name}" may only contain letters, digits, "_", "-", "." and "/"`,
    );
  }
  const concurrency = (value as { concurrency?: unknown } | null)?.concurrency;
  if (
    typeof concurrency !== 'number' ||
    !Number.isInteger(concurrency) ||
    concurrency < 1
  ) {
    throw new Error(`Queue "${name}" needs a concurrency of at least 1`);
  }
  return { name, concurrency };
};

/**
 * Parses the top-level `queues` map. Throws on a malformed definition, which
 * fails loading the whole config.
 */
export const parseQueues = (raw: unknown): QueueConfig[] => {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('"queues" must be a map of queue name to { concurrency }');
  }
  return Object.entries(raw as Record<string, unknown>).map(([name, value]) =>
    parseQueue(name, value),
  );
};

/**
 * Throws if a trigger names a queue that is neither defined under `queues`
 * nor the default queue. There is no fallback to the default queue.
 */
export const assertKnownQueues = (
  triggers: Record<string, unknown>[],
  queues: QueueConfig[],
): void => {
  const known = new Set([RUNS_QUEUE_NAME, ...queues.map((q) => q.name)]);
  for (const trigger of triggers) {
    const queue = trigger['queue'];
    if (queue === undefined || queue === null) continue;
    if (typeof queue !== 'string' || !known.has(queue)) {
      throw new Error(
        `Trigger "${String(trigger['name'])}" names undefined queue ${JSON.stringify(queue)}; define it under "queues"`,
      );
    }
  }
};
