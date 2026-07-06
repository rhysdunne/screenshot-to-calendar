import { createHash } from 'node:crypto';

export type ImageMediaType = 'image/png' | 'image/gif' | 'image/webp' | 'image/jpeg';

/**
 * Detect image format from base64 magic bytes (port of the v1
 * prepare-vision-request logic). A data-URI prefix wins if present.
 */
export function detectMediaType(base64: string): ImageMediaType {
  const dataUri = /^data:(image\/[a-zA-Z+]+);base64,/.exec(base64);
  if (dataUri) {
    const t = dataUri[1];
    if (t === 'image/png' || t === 'image/gif' || t === 'image/webp' || t === 'image/jpeg') {
      return t;
    }
    return 'image/jpeg';
  }
  if (base64.startsWith('iVBOR')) return 'image/png';
  if (base64.startsWith('R0lGOD')) return 'image/gif';
  if (base64.startsWith('UklGR')) return 'image/webp';
  return 'image/jpeg'; // /9j/ and anything else
}

/** Strip any data-URI prefix and whitespace, returning clean base64. */
export function cleanBase64(base64: string): string {
  return base64.replace(/^data:image\/[a-zA-Z+]+;base64,/, '').replace(/\s/g, '');
}

/** SHA-256 of the decoded image bytes — used for exact-duplicate detection. */
export function imageSha256(base64: string): string {
  const bytes = Buffer.from(cleanBase64(base64), 'base64');
  return createHash('sha256').update(bytes).digest('hex');
}

export function extensionFor(mediaType: ImageMediaType): string {
  switch (mediaType) {
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return 'jpg';
  }
}
