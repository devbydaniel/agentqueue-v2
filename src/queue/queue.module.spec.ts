import { Test } from '@nestjs/testing';
import { BOSS } from './queue.tokens.js';
import { ConfigModule } from '../config/config.module.js';

// pg-boss is ESM-only; mock it so unit tests don't need to load it
jest.mock('pg-boss', () => ({
  PgBoss: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    stop: jest.fn(),
    send: jest.fn(),
    work: jest.fn(),
  })),
}));

describe('QueueModule', () => {
  it('should provide the BOSS token', async () => {
    const mockBoss = {
      start: jest.fn(),
      stop: jest.fn(),
      send: jest.fn(),
      work: jest.fn(),
    };

    // Import QueueModule after mock is set up
    const { QueueModule } = await import('./queue.module.js');

    const module = await Test.createTestingModule({
      imports: [ConfigModule, QueueModule],
    })
      .overrideProvider(BOSS)
      .useValue(mockBoss)
      .compile();

    const boss = module.get(BOSS);
    expect(boss).toBeDefined();
    expect(boss.start).toBeDefined();
    expect(boss.stop).toBeDefined();
  });
});
