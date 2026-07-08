import { describe, expect, it } from 'vitest';
import { safeError } from '../../src/lib/logger.js';

describe('safeError', () => {
  it('keeps the error name but drops the free-form message', () => {
    const e = new Error('Google token endpoint 400: refresh_token=1//secret-leaked');
    expect(safeError(e)).toEqual({ name: 'Error' });
    // The sensitive message must not survive into the log payload.
    expect(JSON.stringify(safeError(e))).not.toContain('secret-leaked');
  });

  it('preserves a machine code when present, still no message', () => {
    class GoogleAuthError extends Error {
      constructor(
        message: string,
        readonly code: string,
      ) {
        super(message);
        this.name = 'GoogleAuthError';
      }
    }
    expect(safeError(new GoogleAuthError('invalid_grant for user@example.com', 'invalid_grant'))).toEqual({
      name: 'GoogleAuthError',
      code: 'invalid_grant',
    });
  });

  it('handles non-Error throws without leaking their contents', () => {
    expect(safeError('venue: The Secret Garden, 12 Private Rd')).toEqual({ name: 'UnknownError' });
  });
});
