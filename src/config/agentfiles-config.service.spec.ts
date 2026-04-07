import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AgentfilesConfigService } from './agentfiles-config.service.js';

jest.mock('node:fs');

const SAMPLE_TOML = `
default_store = "work"

[[repos]]
name = "core"
path = "~/dev/ayunis/ayunis-core"
store = "work"

[[repos]]
name = "assistant"
path = "~/agents/assistant"
store = "private"
`;

describe('AgentfilesConfigService', () => {
  let service: AgentfilesConfigService;

  beforeEach(() => {
    service = new AgentfilesConfigService();
    jest.restoreAllMocks();
  });

  describe('onModuleInit', () => {
    it('should load and parse the config file', () => {
      (fs.readFileSync as jest.Mock).mockReturnValue(SAMPLE_TOML);

      service.onModuleInit();

      expect(fs.readFileSync).toHaveBeenCalledWith(
        path.join(os.homedir(), '.config', 'agentfiles', 'config.toml'),
        'utf-8',
      );
    });

    it('should throw InternalServerErrorException if the file cannot be read', () => {
      (fs.readFileSync as jest.Mock).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      expect(() => service.onModuleInit()).toThrow(
        InternalServerErrorException,
      );
    });

    it('should throw InternalServerErrorException if TOML is invalid', () => {
      (fs.readFileSync as jest.Mock).mockReturnValue('not valid toml [[[');

      expect(() => service.onModuleInit()).toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('resolveRepo', () => {
    beforeEach(() => {
      (fs.readFileSync as jest.Mock).mockReturnValue(SAMPLE_TOML);
      service.onModuleInit();
    });

    it('should resolve a known repo to its expanded absolute path', () => {
      const result = service.resolveRepo('core');

      expect(result).toBe(
        path.join(os.homedir(), 'dev', 'ayunis', 'ayunis-core'),
      );
    });

    it('should expand ~ in paths to os.homedir()', () => {
      const result = service.resolveRepo('assistant');

      expect(result).toBe(path.join(os.homedir(), 'agents', 'assistant'));
    });

    it('should throw NotFoundException for unknown repo', () => {
      expect(() => service.resolveRepo('nonexistent')).toThrow(
        NotFoundException,
      );
    });
  });
});
