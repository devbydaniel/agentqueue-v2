import type {
  SDKAssistantMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * OpenInference semantic-convention attribute keys. Hardcoded to keep this
 * module dependency-free and to mirror `phoenix_hook.py` exactly — both
 * surfaces emit the same span shape into the same Phoenix project.
 */
export const OI_SPAN_KIND = 'openinference.span.kind';
export const OI_INPUT_VALUE = 'input.value';
export const OI_OUTPUT_VALUE = 'output.value';
export const OI_SESSION_ID = 'session.id';
export const OI_LLM_MODEL = 'llm.model_name';
export const OI_TOOL_NAME = 'tool.name';

export const MAX_ATTR_CHARS = 20_000;

export const TRACER_NAME = 'agentqueue';

export interface ToolUseBlock {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  toolUseId: string;
  content: unknown;
  isError: boolean;
}

export function truncate(value: string): string {
  if (value.length <= MAX_ATTR_CHARS) return value;
  return `${value.slice(0, MAX_ATTR_CHARS)}... [truncated ${value.length - MAX_ATTR_CHARS} chars]`;
}

export function stringifyToolValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function extractAssistantText(message: SDKAssistantMessage): string {
  const content = message.message.content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'object' && 'type' in block) {
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
  }
  return parts.join('\n');
}

export function extractToolUses(message: SDKAssistantMessage): ToolUseBlock[] {
  const content = message.message.content;
  if (!Array.isArray(content)) return [];
  const uses: ToolUseBlock[] = [];
  for (const block of content) {
    if (
      typeof block === 'object' &&
      'type' in block &&
      block.type === 'tool_use'
    ) {
      const b = block as { id: string; name: string; input: unknown };
      uses.push({ id: b.id, name: b.name, input: b.input });
    }
  }
  return uses;
}

export function extractToolResults(message: SDKUserMessage): ToolResult[] {
  const content = message.message.content;
  if (!Array.isArray(content)) return [];
  const results: ToolResult[] = [];
  for (const block of content) {
    if (
      typeof block === 'object' &&
      'type' in block &&
      block.type === 'tool_result'
    ) {
      const b = block as {
        tool_use_id: string;
        content: unknown;
        is_error?: boolean;
      };
      results.push({
        toolUseId: b.tool_use_id,
        content: b.content,
        isError: b.is_error === true,
      });
    }
  }
  return results;
}
