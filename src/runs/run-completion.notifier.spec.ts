import {
  RunCompletionNotifier,
  RUN_COMPLETED_CHANNEL,
} from './run-completion.notifier.js';
import type { PgPool } from '../database/database.tokens.js';

describe('RunCompletionNotifier', () => {
  it('should notify using pg_notify with parameterized values', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue(undefined),
    } as unknown as PgPool;

    const notifier = new RunCompletionNotifier(pool);

    await notifier.notify('run-123');

    expect(pool.query).toHaveBeenCalledWith('SELECT pg_notify($1, $2)', [
      RUN_COMPLETED_CHANNEL,
      'run-123',
    ]);
  });

  it('should swallow database errors', async () => {
    const pool = {
      query: jest.fn().mockRejectedValue(new Error('boom')),
    } as unknown as PgPool;

    const notifier = new RunCompletionNotifier(pool);

    await expect(notifier.notify('run-123')).resolves.toBeUndefined();
  });
});
