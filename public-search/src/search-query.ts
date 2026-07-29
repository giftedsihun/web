export const MAX_SEARCH_QUERY_LENGTH = 300;
export const MAX_SEARCH_QUERY_TERMS = 32;
export const MAX_SEARCH_QUERY_DEPTH = 8;

export class SearchQueryError extends Error {}

export function normalizeSearchQuery(value: string | null) {
  const query = (value || "").trim();
  if (!query) throw new SearchQueryError("q is required");
  if (query.length > MAX_SEARCH_QUERY_LENGTH) throw new SearchQueryError("q exceeds the 300 character limit");
  if (/[\u0000-\u001f\u007f]/.test(query)) throw new SearchQueryError("q contains control characters");
  if (query.includes("*") || query.includes(":")) throw new SearchQueryError("q contains unsupported search syntax");
  if ((query.match(/"/g) || []).length % 2) throw new SearchQueryError("q contains an unclosed phrase");

  let depth = 0;
  for (const character of query) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth < 0 || depth > MAX_SEARCH_QUERY_DEPTH) throw new SearchQueryError("q has invalid grouping");
  }
  if (depth !== 0) throw new SearchQueryError("q has invalid grouping");
  if ((query.match(/[\p{L}\p{N}_-]+/gu) || []).length > MAX_SEARCH_QUERY_TERMS) throw new SearchQueryError("q has too many terms");
  return query;
}
