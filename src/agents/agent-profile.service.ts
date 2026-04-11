import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { ensureDirectoryExists } from '../common/utils/cwd-path.js';
import type {
  AgentProfile,
  McpServerProfile,
  SubagentProfile,
} from './agent-profile.interface.js';

@Injectable()
export class AgentProfileService implements OnModuleInit {
  private readonly logger = new Logger(AgentProfileService.name);
  private readonly profiles = new Map<string, AgentProfile>();

  onModuleInit(): void {
    this.loadProfiles();
  }

  getProfile(name: string): AgentProfile | undefined {
    return this.profiles.get(name);
  }

  getAllProfiles(): AgentProfile[] {
    return [...this.profiles.values()];
  }

  getProfilesDir(): string {
    return path.join(os.homedir(), '.agentqueue', 'agents');
  }

  private loadProfiles(): void {
    const dir = this.getProfilesDir();

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from os.homedir(), not user input
    if (!existsSync(dir)) {
      this.logger.warn(
        `Agent profiles directory not found at ${dir}, no profiles loaded`,
      );
      return;
    }

    let files: string[];
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from os.homedir(), not user input
      files = readdirSync(dir).filter(
        (f) => f.endsWith('.yaml') || f.endsWith('.yml'),
      );
    } catch (error) {
      this.logger.error(
        `Failed to read profiles directory: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    for (const file of files) {
      const filePath = path.join(dir, file);
      const stem = path.basename(file, path.extname(file));

      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from os.homedir(), not user input
        const content = readFileSync(filePath, 'utf-8');
        const parsed = yaml.load(content) as Record<string, unknown> | null;

        if (!parsed) {
          this.logger.warn(`Skipping empty profile: ${file}`);
          continue;
        }

        const profile = this.validateProfile(parsed, stem, file);
        if (profile) {
          this.profiles.set(profile.name, profile);
        }
      } catch (error) {
        this.logger.warn(
          `Skipping invalid profile "${file}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.logger.log(
      `Loaded ${this.profiles.size} agent profile(s) from ${dir}`,
    );
  }

  private validateProfile(
    raw: Record<string, unknown>,
    expectedStem: string,
    fileName: string,
  ): AgentProfile | null {
    const name = raw['name'] as string | undefined;
    if (!name) {
      this.logger.warn(`Profile "${fileName}" missing required "name" field`);
      return null;
    }

    if (name !== expectedStem) {
      this.logger.warn(
        `Profile "${fileName}" name "${name}" does not match filename stem "${expectedStem}"`,
      );
      return null;
    }

    const profile: AgentProfile = { name };

    if (!this.applyRepo(profile, raw)) return null;
    if (!this.applyMaxTurns(profile, raw)) return null;

    if (raw['model']) profile.model = raw['model'] as string;
    if (raw['append_prompt'])
      profile.append_prompt = raw['append_prompt'] as string;
    if (Array.isArray(raw['tools'])) profile.tools = raw['tools'] as string[];

    if (!this.applySubagents(profile, raw)) return null;
    if (!this.applyMcpServers(profile, raw)) return null;

    return profile;
  }

  private applyRepo(
    profile: AgentProfile,
    raw: Record<string, unknown>,
  ): boolean {
    if (!raw['repo']) return true;
    try {
      profile.repo = ensureDirectoryExists(
        raw['repo'] as string,
        `profile "${profile.name}" repo`,
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Skipping profile "${profile.name}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private applyMaxTurns(
    profile: AgentProfile,
    raw: Record<string, unknown>,
  ): boolean {
    if (raw['max_turns'] === undefined) return true;
    const maxTurns = raw['max_turns'] as number;
    if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
      this.logger.warn(
        `Profile "${profile.name}" has invalid max_turns (must be a positive integer)`,
      );
      return false;
    }
    profile.max_turns = maxTurns;
    return true;
  }

  private applySubagents(
    profile: AgentProfile,
    raw: Record<string, unknown>,
  ): boolean {
    if (!raw['subagents'] || typeof raw['subagents'] !== 'object') return true;
    const subagents = this.validateSubagents(
      profile.name,
      raw['subagents'] as Record<string, unknown>,
    );
    if (!subagents) return false;
    profile.subagents = subagents;
    return true;
  }

  private applyMcpServers(
    profile: AgentProfile,
    raw: Record<string, unknown>,
  ): boolean {
    if (!raw['mcp_servers'] || typeof raw['mcp_servers'] !== 'object')
      return true;
    const mcpServers = this.validateMcpServers(
      profile.name,
      raw['mcp_servers'] as Record<string, unknown>,
    );
    if (!mcpServers) return false;
    profile.mcp_servers = mcpServers;
    return true;
  }

  private validateSubagents(
    profileName: string,
    raw: Record<string, unknown>,
  ): Record<string, SubagentProfile> | null {
    const result: Record<string, SubagentProfile> = {};

    for (const [key, value] of Object.entries(raw)) {
      const subagent = this.validateOneSubagent(profileName, key, value);
      if (!subagent) return null;
      // eslint-disable-next-line security/detect-object-injection -- key comes from our own YAML config, not user input
      result[key] = subagent;
    }

    return result;
  }

  private validateOneSubagent(
    profileName: string,
    key: string,
    value: unknown,
  ): SubagentProfile | null {
    if (!value || typeof value !== 'object') {
      this.logger.warn(
        `Profile "${profileName}" subagent "${key}" must be an object`,
      );
      return null;
    }

    const entry = value as Record<string, unknown>;
    if (!entry['description'] || typeof entry['description'] !== 'string') {
      this.logger.warn(
        `Profile "${profileName}" subagent "${key}" missing required "description" field`,
      );
      return null;
    }

    if (!entry['prompt'] || typeof entry['prompt'] !== 'string') {
      this.logger.warn(
        `Profile "${profileName}" subagent "${key}" missing required "prompt" field`,
      );
      return null;
    }

    const subagent: SubagentProfile = {
      description: entry['description'],
      prompt: entry['prompt'],
    };

    if (entry['model']) subagent.model = entry['model'] as string;
    if (entry['tools'] && Array.isArray(entry['tools']))
      subagent.tools = entry['tools'] as string[];

    if (entry['max_turns'] !== undefined) {
      const mt = entry['max_turns'] as number;
      if (!Number.isInteger(mt) || mt <= 0) {
        this.logger.warn(
          `Profile "${profileName}" subagent "${key}" has invalid max_turns (must be a positive integer)`,
        );
        return null;
      }
      subagent.max_turns = mt;
    }

    return subagent;
  }

  private validateMcpServers(
    profileName: string,
    raw: Record<string, unknown>,
  ): Record<string, McpServerProfile> | null {
    const result: Record<string, McpServerProfile> = {};

    for (const [key, value] of Object.entries(raw)) {
      const server = this.validateOneMcpServer(profileName, key, value);
      if (!server) return null;
      // eslint-disable-next-line security/detect-object-injection -- key comes from our own YAML config, not user input
      result[key] = server;
    }

    return result;
  }

  private validateOneMcpServer(
    profileName: string,
    key: string,
    value: unknown,
  ): McpServerProfile | null {
    if (!value || typeof value !== 'object') {
      this.logger.warn(
        `Profile "${profileName}" mcp_server "${key}" must be an object`,
      );
      return null;
    }

    const entry = value as Record<string, unknown>;
    const type = entry['type'] as string | undefined;

    if (!type || !['stdio', 'sse', 'http'].includes(type)) {
      this.logger.warn(
        `Profile "${profileName}" mcp_server "${key}" has invalid or missing "type" (must be stdio, sse, or http)`,
      );
      return null;
    }

    if (type === 'stdio' && !entry['command']) {
      this.logger.warn(
        `Profile "${profileName}" mcp_server "${key}" (stdio) missing required "command" field`,
      );
      return null;
    }

    if ((type === 'sse' || type === 'http') && !entry['url']) {
      this.logger.warn(
        `Profile "${profileName}" mcp_server "${key}" (${type}) missing required "url" field`,
      );
      return null;
    }

    const server: McpServerProfile = {
      type: type as McpServerProfile['type'],
    };

    if (entry['command']) server.command = entry['command'] as string;
    if (entry['args'] && Array.isArray(entry['args']))
      server.args = entry['args'] as string[];
    if (entry['url']) server.url = entry['url'] as string;
    if (entry['env'] && typeof entry['env'] === 'object')
      server.env = entry['env'] as Record<string, string>;
    if (entry['headers'] && typeof entry['headers'] === 'object')
      server.headers = entry['headers'] as Record<string, string>;

    return server;
  }
}
