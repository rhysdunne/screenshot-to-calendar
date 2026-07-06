import { describe, expect, it } from 'vitest';
import {
  cleanBase64,
  detectMediaType,
  extensionFor,
  imageSha256,
} from '../../src/pipeline/image.js';

describe('detectMediaType', () => {
  it('detects png/gif/webp/jpeg from magic bytes', () => {
    expect(detectMediaType('iVBORw0KGgo=')).toBe('image/png');
    expect(detectMediaType('R0lGODlhAQ==')).toBe('image/gif');
    expect(detectMediaType('UklGRh4AAABXRUJQ')).toBe('image/webp');
    expect(detectMediaType('/9j/4AAQSkZJRg==')).toBe('image/jpeg');
    expect(detectMediaType('somethingelse')).toBe('image/jpeg');
  });

  it('honours a data-URI prefix over magic bytes', () => {
    expect(detectMediaType('data:image/webp;base64,AAAA')).toBe('image/webp');
  });
});

describe('cleanBase64', () => {
  it('strips data-URI prefix and whitespace', () => {
    expect(cleanBase64('data:image/png;base64,iVBOR w0K\nGgo=')).toBe('iVBORw0KGgo=');
  });
});

describe('imageSha256', () => {
  it('is stable regardless of data-URI wrapping', () => {
    const raw = Buffer.from('hello').toString('base64');
    expect(imageSha256(raw)).toBe(imageSha256(`data:image/png;base64,${raw}`));
    expect(imageSha256(raw)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('extensionFor', () => {
  it('maps media types to file extensions', () => {
    expect(extensionFor('image/png')).toBe('png');
    expect(extensionFor('image/jpeg')).toBe('jpg');
  });
});
