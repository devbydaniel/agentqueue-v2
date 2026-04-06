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
