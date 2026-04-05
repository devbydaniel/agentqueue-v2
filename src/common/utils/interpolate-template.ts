/**
 * Interpolate `{{key}}` patterns in a template string with values from a variable bag.
 * Unknown keys are left as-is.
 */
export function interpolateTemplate(
  template: string,
  vars: Record<string, string | undefined>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    // eslint-disable-next-line security/detect-object-injection -- key comes from our own {{key}} pattern, not user input
    return vars[key] ?? _match;
  });
}
