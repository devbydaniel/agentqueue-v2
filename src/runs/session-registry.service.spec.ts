import { Test } from '@nestjs/testing';
import { SessionRegistryService } from './session-registry.service.js';

describe('SessionRegistryService', () => {
  let service: SessionRegistryService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [SessionRegistryService],
    }).compile();

    service = module.get(SessionRegistryService);
  });

  describe('session file mapping', () => {
    it('should return undefined for unknown session key', () => {
      expect(service.getSessionFile('unknown')).toBeUndefined();
    });

    it('should store and retrieve a session file path', () => {
      service.storeSessionFile('key-1', '/sessions/abc.jsonl');

      expect(service.getSessionFile('key-1')).toBe('/sessions/abc.jsonl');
    });

    it('should overwrite an existing mapping', () => {
      service.storeSessionFile('key-1', '/sessions/old.jsonl');
      service.storeSessionFile('key-1', '/sessions/new.jsonl');

      expect(service.getSessionFile('key-1')).toBe('/sessions/new.jsonl');
    });
  });

  describe('active session tracking', () => {
    it('should abort a tracked session and return true', async () => {
      const mockSession = { abort: jest.fn().mockResolvedValue(undefined) };
      service.trackActive('key-1', mockSession as never);

      const result = await service.abort('key-1');

      expect(result).toBe(true);
      expect(mockSession.abort).toHaveBeenCalled();
    });

    it('should return false when aborting an unknown session', async () => {
      const result = await service.abort('unknown');

      expect(result).toBe(false);
    });

    it('should not abort after untracking', async () => {
      const mockSession = { abort: jest.fn().mockResolvedValue(undefined) };
      service.trackActive('key-1', mockSession as never);
      service.untrackActive('key-1');

      const result = await service.abort('key-1');

      expect(result).toBe(false);
      expect(mockSession.abort).not.toHaveBeenCalled();
    });
  });
});
