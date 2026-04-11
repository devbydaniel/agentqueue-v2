/* eslint-disable sonarjs/publicly-writable-directories */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { AgentProfileService } from './agent-profile.service.js';

jest.mock('node:fs');

describe('AgentProfileService', () => {
  const profilesDir = path.join(os.homedir(), '.agentqueue', 'agents');

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  function createService(): AgentProfileService {
    const instance = new AgentProfileService();
    instance.onModuleInit();
    return instance;
  }

  function mockProfileDir(files: Record<string, object>): void {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readdirSync as jest.Mock).mockReturnValue(Object.keys(files));
    (fs.readFileSync as jest.Mock).mockImplementation((filePath: string) => {
      const fileName = path.basename(filePath);

      return yaml.dump(files[fileName]);
    });
    (fs.statSync as jest.Mock).mockReturnValue({ isDirectory: () => true });
  }

  function mockNoDir(): void {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
  }

  it('should return the correct profiles directory', () => {
    mockNoDir();
    const service = createService();
    expect(service.getProfilesDir()).toBe(profilesDir);
  });

  it('should load a valid profile', () => {
    mockProfileDir({
      'reviewer.yaml': {
        name: 'reviewer',
        repo: '/tmp/my-project',
        model: 'claude-sonnet-4-6',
        append_prompt: 'Be thorough.',
        tools: ['Read', 'Grep'],
        max_turns: 25,
      },
    });

    const service = createService();
    const profile = service.getProfile('reviewer');

    expect(profile).toBeDefined();
    expect(profile!.name).toBe('reviewer');
    expect(profile!.repo).toBe('/tmp/my-project');
    expect(profile!.model).toBe('claude-sonnet-4-6');
    expect(profile!.append_prompt).toBe('Be thorough.');
    expect(profile!.tools).toEqual(['Read', 'Grep']);
    expect(profile!.max_turns).toBe(25);
  });

  it('should return undefined for unknown profile name', () => {
    mockNoDir();
    const service = createService();
    expect(service.getProfile('nonexistent')).toBeUndefined();
  });

  it('should skip profile with missing name field', () => {
    mockProfileDir({
      'unnamed.yaml': {
        repo: '/tmp/project',
        model: 'opus',
      },
    });

    const service = createService();
    expect(service.getProfile('unnamed')).toBeUndefined();
    expect(service.getAllProfiles()).toHaveLength(0);
  });

  it('should skip profile where name does not match filename stem', () => {
    mockProfileDir({
      'reviewer.yaml': {
        name: 'different-name',
        repo: '/tmp/project',
      },
    });

    const service = createService();
    expect(service.getProfile('reviewer')).toBeUndefined();
    expect(service.getProfile('different-name')).toBeUndefined();
  });

  it('should handle missing directory gracefully', () => {
    mockNoDir();
    const service = createService();
    expect(service.getAllProfiles()).toEqual([]);
  });

  it('should handle malformed YAML gracefully', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readdirSync as jest.Mock).mockReturnValue(['bad.yaml']);
    (fs.readFileSync as jest.Mock).mockReturnValue(
      ':\n  - :\n  invalid: [unbalanced\n',
    );

    const service = createService();
    expect(service.getAllProfiles()).toEqual([]);
  });

  it('should skip profile with invalid max_turns', () => {
    mockProfileDir({
      'agent.yaml': {
        name: 'agent',
        max_turns: -5,
      },
    });

    const service = createService();
    expect(service.getProfile('agent')).toBeUndefined();
  });

  it('should skip profile with non-integer max_turns', () => {
    mockProfileDir({
      'agent.yaml': {
        name: 'agent',
        max_turns: 2.5,
      },
    });

    const service = createService();
    expect(service.getProfile('agent')).toBeUndefined();
  });

  it('should load multiple profiles', () => {
    mockProfileDir({
      'reviewer.yaml': { name: 'reviewer' },
      'assistant.yaml': { name: 'assistant', model: 'opus' },
    });

    const service = createService();
    expect(service.getAllProfiles()).toHaveLength(2);
    expect(service.getProfile('reviewer')).toBeDefined();
    expect(service.getProfile('assistant')).toBeDefined();
  });

  it('should expand ~ in repo path', () => {
    mockProfileDir({
      'agent.yaml': {
        name: 'agent',
        repo: '~/dev/my-project',
      },
    });

    const service = createService();
    const profile = service.getProfile('agent');

    expect(profile).toBeDefined();
    expect(profile!.repo).toBe(path.join(os.homedir(), 'dev', 'my-project'));
  });

  it('should skip profile with relative repo path', () => {
    mockProfileDir({
      'agent.yaml': {
        name: 'agent',
        repo: 'relative/path',
      },
    });

    const service = createService();
    expect(service.getProfile('agent')).toBeUndefined();
  });

  it('should skip profile when repo directory does not exist', () => {
    (fs.existsSync as jest.Mock).mockImplementation(
      // Profiles dir exists, but the repo path does not
      (p: string) => p === profilesDir,
    );
    (fs.readdirSync as jest.Mock).mockReturnValue(['agent.yaml']);
    (fs.readFileSync as jest.Mock).mockReturnValue(
      yaml.dump({ name: 'agent', repo: '/tmp/nonexistent' }),
    );

    const service = createService();
    expect(service.getProfile('agent')).toBeUndefined();
  });

  it('should load .yml extension files', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readdirSync as jest.Mock).mockReturnValue(['agent.yml']);
    (fs.readFileSync as jest.Mock).mockReturnValue(
      yaml.dump({ name: 'agent' }),
    );

    const service = createService();
    expect(service.getProfile('agent')).toBeDefined();
  });

  describe('subagent validation', () => {
    it('should load valid subagents', () => {
      mockProfileDir({
        'agent.yaml': {
          name: 'agent',
          subagents: {
            researcher: {
              description: 'Researches topics',
              prompt: 'You are a researcher.',
              model: 'haiku',
              tools: ['WebSearch'],
              max_turns: 10,
            },
          },
        },
      });

      const service = createService();
      const profile = service.getProfile('agent');

      expect(profile).toBeDefined();
      expect(profile!.subagents!['researcher'].description).toBe(
        'Researches topics',
      );
      expect(profile!.subagents!['researcher'].prompt).toBe(
        'You are a researcher.',
      );
      expect(profile!.subagents!['researcher'].model).toBe('haiku');
    });

    it('should reject subagent missing description', () => {
      mockProfileDir({
        'agent.yaml': {
          name: 'agent',
          subagents: {
            bad: { prompt: 'A prompt' },
          },
        },
      });

      const service = createService();
      expect(service.getProfile('agent')).toBeUndefined();
    });

    it('should reject subagent missing prompt', () => {
      mockProfileDir({
        'agent.yaml': {
          name: 'agent',
          subagents: {
            bad: { description: 'A description' },
          },
        },
      });

      const service = createService();
      expect(service.getProfile('agent')).toBeUndefined();
    });

    it('should reject subagent with invalid max_turns', () => {
      mockProfileDir({
        'agent.yaml': {
          name: 'agent',
          subagents: {
            bad: { description: 'Desc', prompt: 'Prompt', max_turns: -1 },
          },
        },
      });

      const service = createService();
      expect(service.getProfile('agent')).toBeUndefined();
    });

    it('should reject subagent with non-integer max_turns', () => {
      mockProfileDir({
        'agent.yaml': {
          name: 'agent',
          subagents: {
            bad: { description: 'Desc', prompt: 'Prompt', max_turns: 2.5 },
          },
        },
      });

      const service = createService();
      expect(service.getProfile('agent')).toBeUndefined();
    });
  });

  describe('mcp_servers validation', () => {
    it('should load valid stdio mcp server', () => {
      mockProfileDir({
        'agent.yaml': {
          name: 'agent',
          mcp_servers: {
            postgres: {
              type: 'stdio',
              command: 'node',
              args: ['./server.js'],
              env: { PG_HOST: 'localhost' },
            },
          },
        },
      });

      const service = createService();
      const profile = service.getProfile('agent');

      expect(profile).toBeDefined();
      expect(profile!.mcp_servers!['postgres'].type).toBe('stdio');
      expect(profile!.mcp_servers!['postgres'].command).toBe('node');
      expect(profile!.mcp_servers!['postgres'].args).toEqual(['./server.js']);
    });

    it('should load valid sse mcp server', () => {
      mockProfileDir({
        'agent.yaml': {
          name: 'agent',
          mcp_servers: {
            remote: {
              type: 'sse',
              url: 'https://mcp.example.com',
              headers: { Authorization: 'Bearer token' },
            },
          },
        },
      });

      const service = createService();
      const profile = service.getProfile('agent');

      expect(profile).toBeDefined();
      expect(profile!.mcp_servers!['remote'].type).toBe('sse');
      expect(profile!.mcp_servers!['remote'].url).toBe(
        'https://mcp.example.com',
      );
    });

    it('should reject stdio server missing command', () => {
      mockProfileDir({
        'agent.yaml': {
          name: 'agent',
          mcp_servers: {
            bad: { type: 'stdio' },
          },
        },
      });

      const service = createService();
      expect(service.getProfile('agent')).toBeUndefined();
    });

    it('should reject sse server missing url', () => {
      mockProfileDir({
        'agent.yaml': {
          name: 'agent',
          mcp_servers: {
            bad: { type: 'sse' },
          },
        },
      });

      const service = createService();
      expect(service.getProfile('agent')).toBeUndefined();
    });

    it('should reject http server missing url', () => {
      mockProfileDir({
        'agent.yaml': {
          name: 'agent',
          mcp_servers: {
            bad: { type: 'http' },
          },
        },
      });

      const service = createService();
      expect(service.getProfile('agent')).toBeUndefined();
    });

    it('should reject server with invalid type', () => {
      mockProfileDir({
        'agent.yaml': {
          name: 'agent',
          mcp_servers: {
            bad: { type: 'websocket', url: 'ws://localhost' },
          },
        },
      });

      const service = createService();
      expect(service.getProfile('agent')).toBeUndefined();
    });
  });
});
