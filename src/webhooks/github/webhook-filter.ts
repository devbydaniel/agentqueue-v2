import type { WebhookFilter } from '../../triggers/trigger-config.interface.js';
import { getNestedValue } from './payload-template.js';

/**
 * Evaluate a single filter against a webhook payload.
 * Exactly one condition (equals, contains, in, pattern) should be set.
 */
export function evaluateFilter(
  body: Record<string, unknown>,
  filter: WebhookFilter,
): boolean {
  const value = getNestedValue(body, filter.field);

  if (filter.equals !== undefined) {
    return String(value) === filter.equals;
  }
  if (filter.contains !== undefined) {
    return typeof value === 'string' && value.includes(filter.contains);
  }
  if (filter.in !== undefined) {
    return filter.in.includes(String(value));
  }
  if (filter.pattern !== undefined) {
    // eslint-disable-next-line security/detect-non-literal-regexp -- pattern is from admin trigger config, not user input
    return new RegExp(filter.pattern).test(String(value));
  }

  // No condition specified — vacuously true
  return true;
}

/**
 * All filters must pass (AND logic).
 * Returns true if filters is empty or undefined.
 */
export function matchesFilters(
  body: Record<string, unknown>,
  filters?: WebhookFilter[],
): boolean {
  if (!filters || filters.length === 0) return true;
  return filters.every((f) => evaluateFilter(body, f));
}
