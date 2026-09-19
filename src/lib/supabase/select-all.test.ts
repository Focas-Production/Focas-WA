import { describe, it, expect } from 'vitest';

import { selectAll, selectByChunks } from './select-all';

/** A table behind a PostgREST-style max-rows cap. */
function cappedTable(size: number, maxRows: number) {
  const rows = Array.from({ length: size }, (_, i) => ({ id: i }));
  const calls: [number, number][] = [];
  const page = async (from: number, to: number) => {
    calls.push([from, to]);
    return { data: rows.slice(from, Math.min(to + 1, from + maxRows)), error: null };
  };
  return { page, calls };
}

describe('selectAll', () => {
  it('reads past the 1,000-row cap', async () => {
    const { page } = cappedTable(2_500, 1_000);
    const rows = await selectAll(page);
    expect(rows).toHaveLength(2_500);
    expect(rows.at(-1)).toEqual({ id: 2_499 });
  });

  it('keeps going when the server cap is below the page size', async () => {
    const { page } = cappedTable(2_500, 400);
    expect(await selectAll(page)).toHaveLength(2_500);
  });

  it('throws on a query error instead of returning a partial list', async () => {
    await expect(
      selectAll(async () => ({ data: null, error: { message: 'boom' } })),
    ).rejects.toThrow('boom');
  });
});

describe('selectByChunks', () => {
  it('splits the id list and concatenates the results', async () => {
    const ids = Array.from({ length: 700 }, (_, i) => `id${i}`);
    const chunks: number[] = [];
    const rows = await selectByChunks(ids, async (chunk) => {
      chunks.push(chunk.length);
      return { data: chunk.map((id) => ({ id })), error: null };
    });
    expect(chunks).toEqual([300, 300, 100]);
    expect(rows).toHaveLength(700);
  });
});
