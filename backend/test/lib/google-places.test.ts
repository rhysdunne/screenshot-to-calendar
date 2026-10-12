// Places venue lookup: the city hint comes from the user's timezone (London
// only), and a hung call gives up after the timeout instead of holding the
// capture.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { regionHintFor, resolveVenue } from '../../src/lib/google-places.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubPlaces(): Array<{ textQuery: string }> {
  const queries: Array<{ textQuery: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      queries.push(JSON.parse(String(init.body)) as { textQuery: string });
      return new Response(
        JSON.stringify({ places: [{ formattedAddress: '1 Test St', googleMapsUri: 'https://maps' }] }),
        { status: 200 },
      );
    }),
  );
  return queries;
}

describe('regionHintFor', () => {
  it('hints London only for Europe/London', () => {
    expect(regionHintFor('Europe/London')).toBe('London');
    expect(regionHintFor('Pacific/Auckland')).toBeNull();
    expect(regionHintFor('Europe/Dublin')).toBeNull();
    expect(regionHintFor('')).toBeNull();
  });
});

describe('resolveVenue', () => {
  it('adds London to the search for a London user', async () => {
    const queries = stubPlaces();
    const place = await resolveVenue('key', 'The Roundhouse', 'Europe/London');
    expect(queries[0]?.textQuery).toBe('The Roundhouse, London');
    expect(place).toEqual({ formattedAddress: '1 Test St', googleMapsUri: 'https://maps' });
  });

  it('searches on the venue name alone for any other timezone', async () => {
    const queries = stubPlaces();
    await resolveVenue('key', 'Spark Arena', 'Pacific/Auckland');
    expect(queries[0]?.textQuery).toBe('Spark Arena');
  });

  it('gives up with a TimeoutError when Places does not answer in time', async () => {
    // A fetch that only settles when its abort signal fires.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      ),
    );
    await expect(resolveVenue('key', 'Somewhere', 'Europe/London', 20)).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });
});
