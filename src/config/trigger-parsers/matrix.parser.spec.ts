import type { Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseMatrixTriggers } from './matrix.parser.js';

describe('parseMatrixTriggers', () => {
  const logger = { warn: jest.fn() } as unknown as Logger;
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-parser-'));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    delete process.env['TEST_MATRIX_TOKEN'];
  });

  it('parses a trigger, interpolating the token and trimming the URL', () => {
    process.env['TEST_MATRIX_TOKEN'] = 'secret-token';
    const [trigger] = parseMatrixTriggers(
      [
        {
          name: 'matrix-daniel',
          type: 'matrix',
          bot_name: 'assistant',
          homeserver_url: 'https://synapse.example:8448//',
          access_token: '${TEST_MATRIX_TOKEN}',
          user_id: '@daniel:hs',
          room_id: '!r:hs',
          cwd,
        },
      ],
      logger,
    );
    expect(trigger).toMatchObject({
      type: 'matrix',
      homeserver_url: 'https://synapse.example:8448',
      access_token: 'secret-token',
      user_id: '@daniel:hs',
      room_id: '!r:hs',
    });
  });

  it('skips triggers of other types and with missing fields', () => {
    const triggers = parseMatrixTriggers(
      [
        { name: 'tg', type: 'telegram', cwd },
        { name: 'incomplete', type: 'matrix', bot_name: 'a', cwd },
      ],
      logger,
    );
    expect(triggers).toEqual([]);
  });
});
