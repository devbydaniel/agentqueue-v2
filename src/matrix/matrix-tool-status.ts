const MAX_DETAIL_CHARS = 80;

/** Argument keys that best describe a tool call, in order of preference. */
const DETAIL_KEYS = [
  'command',
  'path',
  'file_path',
  'url',
  'query',
  'pattern',
  'name',
  'action',
];

/**
 * A one-line markdown status for a running tool call, e.g.
 * 🔧 bash `grep -rn matrix src/`, shown below the streamed reply while the
 * tool runs.
 */
export function formatToolStatus(toolName: string, args: unknown): string {
  const detail = toolDetail(args);
  if (!detail) return `🔧 ${toolName}`;
  return `🔧 ${toolName} \`${detail.replaceAll('`', "'")}\``;
}

function toolDetail(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const record = args as Record<string, unknown>;
  const key = DETAIL_KEYS.find((k) => typeof record[k] === 'string');
  const value = key
    ? (record[key] as string)
    : Object.values(record).find((v): v is string => typeof v === 'string');
  if (!value) return '';
  const [firstLine = '', ...more] = value.trim().split('\n');
  const oneLine = firstLine
    .replace(/\s+/g, ' ')
    .replace(/\/home\/[^/\s]+\//g, '~/')
    .trim();
  if (more.length > 0 && oneLine.length < MAX_DETAIL_CHARS) {
    return `${oneLine} …`;
  }
  return oneLine.length > MAX_DETAIL_CHARS
    ? `${oneLine.slice(0, MAX_DETAIL_CHARS - 1)}…`
    : oneLine;
}
