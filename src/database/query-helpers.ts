export function toCamelCase(value: string): string {
  return value.replace(/_([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}

export function mapRow<T>(row: Record<string, unknown>): T {
  const mapped = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [toCamelCase(key), value]),
  );
  return mapped as T;
}

export function mapRows<T>(rows: Record<string, unknown>[]): T[] {
  return rows.map((row) => mapRow<T>(row));
}
