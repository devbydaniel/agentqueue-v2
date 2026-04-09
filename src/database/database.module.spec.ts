import { Test } from '@nestjs/testing';
import { DatabaseModule } from './database.module.js';
import { PG_POOL } from './database.tokens.js';
import { ConfigModule } from '../config/config.module.js';

describe('DatabaseModule', () => {
  it('should provide PG_POOL token', async () => {
    const mockPool = { query: jest.fn(), end: jest.fn() };

    const module = await Test.createTestingModule({
      imports: [ConfigModule, DatabaseModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(mockPool)
      .compile();

    const pool = module.get(PG_POOL);

    expect(pool).toBeDefined();
  });
});
