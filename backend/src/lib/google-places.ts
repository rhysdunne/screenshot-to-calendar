// Google Places API (New) Text Search — used to resolve a venue name to a
// full address when the image showed a venue but no address. Failures are
// non-fatal; the pipeline proceeds without an address.
const SEARCH_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

export interface ResolvedPlace {
  formattedAddress: string;
  googleMapsUri?: string;
}

export async function resolveVenue(
  apiKey: string,
  venue: string,
  regionHint = 'London',
): Promise<ResolvedPlace | null> {
  const res = await fetch(SEARCH_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.formattedAddress,places.googleMapsUri',
    },
    body: JSON.stringify({ textQuery: `${venue}, ${regionHint}`, maxResultCount: 1 }),
  });
  if (!res.ok) return null;
  const json = (await res.json().catch(() => ({}))) as {
    places?: Array<{ formattedAddress?: string; googleMapsUri?: string }>;
  };
  const place = json.places?.[0];
  if (!place?.formattedAddress) return null;
  return { formattedAddress: place.formattedAddress, googleMapsUri: place.googleMapsUri };
}
