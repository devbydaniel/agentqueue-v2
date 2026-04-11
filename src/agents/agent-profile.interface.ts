export interface McpServerProfile {
  type: 'stdio' | 'sse' | 'http';
  /** Command to run (required for stdio) */
  command?: string;
  /** Arguments for the command (stdio only) */
  args?: string[];
  /** URL for the server (required for sse/http) */
  url?: string;
  /** Environment variables passed to the server process */
  env?: Record<string, string>;
  /** HTTP headers (sse/http only) */
  headers?: Record<string, string>;
}

export interface SubagentProfile {
  /** Natural language description of when to use this subagent */
  description: string;
  /** System prompt for the subagent */
  prompt: string;
  /** Model alias or full model ID */
  model?: string;
  /** Allowed tool names */
  tools?: string[];
  /** Maximum agentic turns */
  max_turns?: number;
}

export interface AgentProfile {
  /** Unique name matching the YAML filename stem */
  name: string;
  /** Absolute path or ~/... to the repo this agent works in */
  repo?: string;
  /** Model alias or full model ID (e.g. 'opus', 'claude-sonnet-4-6') */
  model?: string;
  /** Text appended to the Claude Code preset system prompt */
  append_prompt?: string;
  /** Named subagent definitions */
  subagents?: Record<string, SubagentProfile>;
  /** MCP server configurations */
  mcp_servers?: Record<string, McpServerProfile>;
  /** Tools to allow */
  tools?: string[];
  /** Maximum agentic turns */
  max_turns?: number;
}
