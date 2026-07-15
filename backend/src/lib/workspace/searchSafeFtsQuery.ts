/**
 * Convert user text into a bounded FTS5 query containing literal Unicode
 * letter/number tokens only. Callers must treat null as no searchable input.
 */
export function searchSafeFtsQuery(value: string) {
  const tokens = value.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return null;
  return tokens
    .slice(0, 12)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" AND ");
}
