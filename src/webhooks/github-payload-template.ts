/**
 * Resolve a dot-separated path into a nested object.
 * e.g. getNestedValue({ a: { b: 'c' } }, 'a.b') → 'c'
 */
export function getNestedValue(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  let current: unknown = obj;
  for (const key of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    // eslint-disable-next-line security/detect-object-injection -- key comes from our own {{path}} pattern split, not user input
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Interpolate `{{dotted.path}}` patterns in a template string
 * using values resolved from a nested payload object.
 * Unknown paths are left as-is.
 */
export function interpolatePayloadTemplate(
  template: string,
  payload: Record<string, unknown>,
): string {
  return template.replace(/\{\{([\w.]+)\}\}/g, (_match, path: string) => {
    const value = getNestedValue(payload, path);
    if (value === undefined || value === null) return _match;
    if (typeof value === 'object') return _match;
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- value is a primitive at this point (guarded above)
    return String(value);
  });
}
