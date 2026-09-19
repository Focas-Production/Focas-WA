// ============================================================
// Read every row of a PostgREST query, page by page.
//
// PostgREST silently caps each response at the project's max-rows
// (1,000 on Supabase by default): a plain `.select('*')` over a
// 2,500-contact audience returns 1,000 rows and no error. Anything
// that must see the whole set — campaign audiences, recipient lists,
// custom-value lookups — reads through here instead.
//
// Works in the browser and on the server (no client import); the
// caller builds a fresh, ORDERED query per page, e.g.
//
//   selectAll((from, to) =>
//     supabase.from('contacts').select('*').order('id').range(from, to))
//
// The order must be total (unique column last) or rows can repeat or
// vanish across page boundaries.
// ============================================================

export const SELECT_PAGE_SIZE = 1000;

interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

export async function selectAll<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const { data, error } = await page(rows.length, rows.length + SELECT_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    // Stop on an empty page, not a short one: a project configured
    // with max-rows below the page size returns short pages that
    // still have more after them.
    if (!data || data.length === 0) return rows;
    rows.push(...data);
  }
}

/**
 * Run an `.in(column, ids)` query in chunks. Keeps each request URL
 * short (thousands of UUIDs overflow proxy URL limits) and each
 * chunk's result under max-rows when the query returns ≤1 row per id.
 */
export async function selectByChunks<T>(
  ids: readonly string[],
  query: (chunk: string[]) => PromiseLike<PageResult<T>>,
  chunkSize = 300,
): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const { data, error } = await query(ids.slice(i, i + chunkSize));
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
  }
  return rows;
}
