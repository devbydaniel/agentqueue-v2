import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

export interface FlowAgentConfig {
  name: string;
  target: string;
  prompt: string;
}

export interface FlowConfig {
  resolver: string;
  agents: FlowAgentConfig[];
}

export interface FlowInfo {
  name: string;
  configPath: string;
}

/**
 * Loads and validates flow configs from `~/.agentqueue/flows/<name>/config.yaml`.
 *
 * Throws `NotFoundException` when the flow directory or config file is
 * missing, and `BadRequestException` when the YAML is malformed or fails
 * shape validation.
 */
@Injectable()
export class FlowConfigService {
  private readonly logger = new Logger(FlowConfigService.name);

  private getFlowsRoot(): string {
    return path.join(os.homedir(), '.agentqueue', 'flows');
  }

  getFlowDir(name: string): string {
    return path.join(this.getFlowsRoot(), name);
  }

  listFlows(): FlowInfo[] {
    const root = this.getFlowsRoot();

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from os.homedir(), not user input
    if (!existsSync(root)) {
      return [];
    }

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from os.homedir(), not user input
    const entries = readdirSync(root);
    const flows: FlowInfo[] = [];

    for (const entry of entries) {
      const dirPath = path.join(root, entry);
      const configPath = path.join(dirPath, 'config.yaml');

      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from os.homedir(), not user input
      if (!statSync(dirPath).isDirectory()) {
        continue;
      }

      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from os.homedir(), not user input
      if (!existsSync(configPath)) {
        this.logger.debug(
          `Skipping flow directory "${entry}" — no config.yaml`,
        );
        continue;
      }

      flows.push({ name: entry, configPath });
    }

    return flows;
  }

  loadFlow(name: string): FlowConfig {
    const dirPath = this.getFlowDir(name);
    const configPath = path.join(dirPath, 'config.yaml');

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from os.homedir(), not user input
    if (!existsSync(configPath)) {
      throw new NotFoundException(
        `Flow "${name}" not found (no config.yaml at ${configPath})`,
      );
    }

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is built from os.homedir(), not user input
    const content = readFileSync(configPath, 'utf-8');
    const parsed = yaml.load(content) as Record<string, unknown> | null;

    if (!parsed) {
      throw new BadRequestException(`Flow "${name}" has an empty config.yaml`);
    }

    const resolver = parsed['resolver'];
    if (!resolver || typeof resolver !== 'string') {
      throw new BadRequestException(
        `Flow "${name}" config.yaml is missing a valid "resolver" field`,
      );
    }

    const agents = parsed['agents'];
    if (!agents || !Array.isArray(agents) || agents.length === 0) {
      throw new BadRequestException(
        `Flow "${name}" config.yaml has an empty or missing "agents" list`,
      );
    }

    const validatedAgents: FlowAgentConfig[] = [];
    for (const agent of agents as Record<string, unknown>[]) {
      const agentName = agent['name'];
      const target = agent['target'];
      const prompt = agent['prompt'];

      if (
        !agentName ||
        typeof agentName !== 'string' ||
        !target ||
        typeof target !== 'string' ||
        !prompt ||
        typeof prompt !== 'string'
      ) {
        throw new BadRequestException(
          `Flow "${name}" agent is missing required fields (name, target, prompt): ${JSON.stringify(agent)}`,
        );
      }

      validatedAgents.push({
        name: agentName,
        target,
        prompt,
      });
    }

    return { resolver, agents: validatedAgents };
  }
}
