import {
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as toml from '@iarna/toml';

interface RepoEntry {
  name: string;
  path: string;
}

interface AgentfilesConfig {
  repos?: RepoEntry[];
}

@Injectable()
export class AgentfilesConfigService implements OnModuleInit {
  private readonly logger = new Logger(AgentfilesConfigService.name);
  private repos: RepoEntry[] = [];

  onModuleInit(): void {
    const configPath = path.join(
      os.homedir(),
      '.config',
      'agentfiles',
      'config.toml',
    );

    this.logger.log('Loading agentfiles config', { configPath });

    let raw: string;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from os.homedir(), not user input
      raw = fs.readFileSync(configPath, 'utf-8');
    } catch (error) {
      // Bootstrap-time failure — no HTTP context, throw a plain Error so
      // Nest's bootstrap aborts cleanly with a readable stack.
      throw new Error(
        `Cannot read agentfiles config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let parsed: AgentfilesConfig;
    try {
      parsed = toml.parse(raw) as unknown as AgentfilesConfig;
    } catch (error) {
      throw new Error(
        `Failed to parse agentfiles config: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.repos = parsed.repos ?? [];
    this.logger.log(`Loaded ${this.repos.length} repos from agentfiles config`);
  }

  resolveRepo(name: string): string {
    const entry = this.repos.find((r) => r.name === name);
    if (!entry) {
      throw new NotFoundException(
        `Repo "${name}" not found in agentfiles config`,
      );
    }

    return this.expandHome(entry.path);
  }

  private expandHome(p: string): string {
    if (p.startsWith('~/')) {
      return path.join(os.homedir(), p.slice(2));
    }
    return p;
  }
}
