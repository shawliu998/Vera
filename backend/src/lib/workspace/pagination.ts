export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export type PageRequest = {
  cursor?: string | null;
  limit?: number;
};

export type Page<T> = {
  items: T[];
  nextCursor: string | null;
};

export function normalizePageRequest(request: PageRequest = {}): Required<PageRequest> {
  const limit = request.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new RangeError(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  }
  if (request.cursor !== undefined && request.cursor !== null && request.cursor.length > 512) {
    throw new RangeError("cursor must not exceed 512 characters");
  }
  return { cursor: request.cursor ?? null, limit };
}
