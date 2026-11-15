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
  describe('call config', () => {
    const base = (extra: Record<string, unknown>) => ({
      name: 'matrix-daniel',
      type: 'matrix',
      bot_name: 'assistant',
      homeserver_url: 'https://synapse.example',
      access_token: 'token',
      user_id: '@daniel:hs',
      cwd,
      ...extra,
    });

    it('parses the call room and both LiveKit URLs', () => {
      const [trigger] = parseMatrixTriggers(
        [
          base({
            call_room_id: '!call:hs',
            livekit_url: 'wss://livekit.example',
            livekit_internal_url: 'ws://livekit.livekit.svc:7880',
          }),
        ],
        logger,
      );
      expect(trigger).toMatchObject({
        call_room_id: '!call:hs',
        livekit_url: 'wss://livekit.example',
        livekit_internal_url: 'ws://livekit.livekit.svc:7880',
      });
    });

    it('connects to the advertised URL when no internal URL is set', () => {
      const [trigger] = parseMatrixTriggers(
        [base({ call_room_id: '!call:hs', livekit_url: 'wss://lk.example' })],
        logger,
      );
      expect(trigger.livekit_internal_url).toBe('wss://lk.example');
    });

    it('leaves calls off without a call room', () => {
      const [trigger] = parseMatrixTriggers(
        [base({ livekit_url: 'wss://lk.example' })],
        logger,
      );
      expect(trigger.call_room_id).toBeUndefined();
      expect(trigger.livekit_url).toBeUndefined();
    });

    it.each([
      [{ call_room_id: '#alias:hs', livekit_url: 'wss://lk.example' }],
      [{ call_room_id: '!call:hs' }],
      [{ call_room_id: '!call:hs', livekit_url: 'https://lk.example' }],
      [
        {
          call_room_id: '!call:hs',
          livekit_url: 'wss://lk.example',
          livekit_internal_url: 'lk:7880',
        },
      ],
    ])('disables calls but keeps the trigger for %j', (extra) => {
      const warn = jest.fn();
      const [trigger] = parseMatrixTriggers([base(extra)], {
        warn,
      } as unknown as Logger);
      expect(trigger.name).toBe('matrix-daniel');
      expect(trigger.call_room_id).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('calls disabled'),
      );
    });
  });
});
