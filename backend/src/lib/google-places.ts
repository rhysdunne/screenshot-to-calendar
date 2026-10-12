// Google Places API (New) Text Search — used to resolve a venue name to a
// full address when the image showed a venue but no address. Failures are
// non-fatal; the pipeline proceeds without an address.
const SEARCH_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

/** A slow Places call must not hold up the capture; past this it gets no address. */
export const PLACES_TIMEOUT_MS = 5000;

export interface ResolvedPlace {
  formattedAddress: string;
  googleMapsUri?: string;
}

/**
 * The city added to the venue search, taken from the user's timezone. Only
 * Europe/London maps to one. A wrong city steers Places to a venue of the
 * same name somewhere else, which is worse than no hint, so every other
 * timezone searches on the venue name alone.
 */
export function regionHintFor(timeZone: string): string | null {
  return timeZone === 'Europe/London' ? 'London' : null;
}

/**
 * Rejects with a TimeoutError after `timeoutMs`; the caller treats that like
 * any other Places failure and carries on without an address.
 */
export async function resolveVenue(
  apiKey: string,
  venue: string,
  timeZone: string,
  timeoutMs = PLACES_TIMEOUT_MS,
): Promise<ResolvedPlace | null> {
  const hint = regionHintFor(timeZone);
  const res = await fetch(SEARCH_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.formattedAddress,places.googleMapsUri',
    },
    body: JSON.stringify({ textQuery: hint ? `${venue}, ${hint}` : venue, maxResultCount: 1 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  const json = (await res.json().catch(() => ({}))) as {
    places?: Array<{ formattedAddress?: string; googleMapsUri?: string }>;
  };
  const place = json.places?.[0];
  if (!place?.formattedAddress) return null;
  return { formattedAddress: place.formattedAddress, googleMapsUri: place.googleMapsUri };
}
