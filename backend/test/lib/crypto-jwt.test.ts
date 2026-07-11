import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../../src/lib/crypto.js';
import { signSession, TokenError, verifySession } from '../../src/lib/jwt.js';

const KEY = 'a'.repeat(64); // 32 bytes hex
const SECRET = 'test-jwt-secret';

describe('crypto (refresh token encryption)', () => {
  it('round-trips', () => {
    const enc = encrypt('1//refresh-token-value', KEY);
    expect(decrypt(enc, KEY)).toBe('1//refresh-token-value');
  });

  it('produces a fresh IV per encryption', () => {
    expect(encrypt('x', KEY).iv).not.toBe(encrypt('x', KEY).iv);
  });

  it('rejects tampered ciphertext', () => {
    const enc = encrypt('secret', KEY);
    // Flip the first ciphertext byte's bits so it is ALWAYS genuinely changed.
    // Overwriting it with a fixed 'ff' was a no-op ~1/256 of the time (whenever
    // the random first byte already was 0xff), which made this test flaky.
    const flipped = (parseInt(enc.ct.slice(0, 2), 16) ^ 0xff).toString(16).padStart(2, '0');
    const tampered = { ...enc, ct: flipped + enc.ct.slice(2) };
    expect(() => decrypt(tampered, KEY)).toThrow();
  });

  it('rejects wrong-size keys', () => {
    expect(() => encrypt('x', 'abcd')).toThrow(/32 bytes/);
  });
});

describe('jwt (session tokens)', () => {
  it('round-trips claims', () => {
    const token = signSession('user-1', 3, SECRET);
    const claims = verifySession(token, SECRET);
    expect(claims.sub).toBe('user-1');
    expect(claims.ver).toBe(3);
  });

  it('rejects a tampered payload', () => {
    const token = signSession('user-1', 1, SECRET);
    const [h, , s] = token.split('.') as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ sub: 'attacker', ver: 1, iat: 0, exp: 9e9 }))
      .toString('base64url');
    expect(() => verifySession(`${h}.${forged}.${s}`, SECRET)).toThrow(TokenError);
  });

  it('rejects the wrong secret', () => {
    const token = signSession('user-1', 1, SECRET);
    expect(() => verifySession(token, 'other-secret')).toThrow(/Bad signature/);
  });

  it('rejects expired tokens', () => {
    const token = signSession('user-1', 1, SECRET, -10);
    expect(() => verifySession(token, SECRET)).toThrow(/expired/);
  });
});
