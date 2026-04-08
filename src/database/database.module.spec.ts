import { Test } from '@nestjs/testing';
import { DatabaseModule } from './database.module.js';
import { PG_POOL, DRIZZLE } from './database.tokens.js';
import { ConfigModule } from '../config/config.module.js';

describe('DatabaseModule', () => {
  it('should provide PG_POOL and DRIZZLE tokens', async () => {
    const mockPool = { query: jest.fn(), end: jest.fn() };

    const module = await Test.createTestingModule({
      imports: [ConfigModule, DatabaseModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(mockPool)
      .overrideProvider(DRIZZLE)
      .useValue({ select: jest.fn() })
      .compile();

    const pool = module.get(PG_POOL);
    const drizzle = module.get(DRIZZLE);

    expect(pool).toBeDefined();
    expect(drizzle).toBeDefined();
  });
});
