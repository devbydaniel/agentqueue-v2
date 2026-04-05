import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { FlowConfigService } from './flow-config.service.js';

describe('FlowConfigService', () => {
  let service: FlowConfigService;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-config-test-'));
    service = new FlowConfigService();
    // Override the private getFlowsRoot to use tmpDir
    jest
      .spyOn(service as never, 'getFlowsRoot' as never)
      .mockReturnValue(tmpDir as never);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createFlowDir(name: string, config?: object): string {
    const dir = path.join(tmpDir, name);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test helper using temp dir
    fs.mkdirSync(dir, { recursive: true });
    if (config) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test helper using temp dir
      fs.writeFileSync(path.join(dir, 'config.yaml'), yaml.dump(config));
    }
    return dir;
  }

  const validConfig = {
    resolver: './resolve.ts',
    agents: [
      { name: 'dev', target: 'my-repo', prompt: 'Do the work on {{task}}' },
      { name: 'qa', target: 'my-repo', prompt: 'Review {{task}}' },
    ],
  };

  // --- listFlows ---

  describe('listFlows', () => {
    it('should return flows from directories containing config.yaml', () => {
      createFlowDir('factory', validConfig);
      createFlowDir('bugfix', validConfig);

      const flows = service.listFlows();
      expect(flows).toHaveLength(2);

      const names = flows.map((f) => f.name);
      const sorted = names.toSorted((a, b) => a.localeCompare(b));
      expect(sorted).toEqual(['bugfix', 'factory']);

      for (const flow of flows) {
        expect(flow.configPath).toContain('config.yaml');
      }
    });

    it('should skip directories without config.yaml', () => {
      createFlowDir('valid', validConfig);
      createFlowDir('no-config'); // no config.yaml

      const flows = service.listFlows();
      expect(flows).toHaveLength(1);
      expect(flows[0].name).toBe('valid');
    });

    it('should return empty array when flows root does not exist', () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      expect(service.listFlows()).toEqual([]);
    });
  });

  // --- loadFlow ---

  describe('loadFlow', () => {
    it('should parse a valid config correctly', () => {
      createFlowDir('factory', validConfig);

      const config = service.loadFlow('factory');
      expect(config.resolver).toBe('./resolve.ts');
      expect(config.agents).toHaveLength(2);
      expect(config.agents[0]).toEqual({
        name: 'dev',
        target: 'my-repo',
        prompt: 'Do the work on {{task}}',
      });
      expect(config.agents[1]).toEqual({
        name: 'qa',
        target: 'my-repo',
        prompt: 'Review {{task}}',
      });
    });

    it('should throw on missing resolver field', () => {
      createFlowDir('bad', {
        agents: [{ name: 'dev', target: 'repo', prompt: 'do stuff' }],
      });

      expect(() => service.loadFlow('bad')).toThrow(
        /missing a valid "resolver"/,
      );
    });

    it('should throw on empty agents list', () => {
      createFlowDir('bad', {
        resolver: './resolve.ts',
        agents: [],
      });

      expect(() => service.loadFlow('bad')).toThrow(
        /empty or missing "agents"/,
      );
    });

    it('should throw on missing agents field', () => {
      createFlowDir('bad', {
        resolver: './resolve.ts',
      });

      expect(() => service.loadFlow('bad')).toThrow(
        /empty or missing "agents"/,
      );
    });

    it('should throw on agent missing name', () => {
      createFlowDir('bad', {
        resolver: './resolve.ts',
        agents: [{ target: 'repo', prompt: 'do stuff' }],
      });

      expect(() => service.loadFlow('bad')).toThrow(/missing required fields/);
    });

    it('should throw on agent missing target', () => {
      createFlowDir('bad', {
        resolver: './resolve.ts',
        agents: [{ name: 'dev', prompt: 'do stuff' }],
      });

      expect(() => service.loadFlow('bad')).toThrow(/missing required fields/);
    });

    it('should throw on agent missing prompt', () => {
      createFlowDir('bad', {
        resolver: './resolve.ts',
        agents: [{ name: 'dev', target: 'repo' }],
      });

      expect(() => service.loadFlow('bad')).toThrow(/missing required fields/);
    });

    it('should throw on non-existent flow name', () => {
      expect(() => service.loadFlow('nonexistent')).toThrow(/not found/);
    });
  });

  // --- getFlowDir ---

  describe('getFlowDir', () => {
    it('should return the absolute path to the flow folder', () => {
      const dir = service.getFlowDir('factory');
      expect(dir).toBe(path.join(tmpDir, 'factory'));
    });
  });
});
