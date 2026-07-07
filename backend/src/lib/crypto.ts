// AES-256-GCM envelope for Google refresh tokens at rest in DynamoDB.
// The key is a 32-byte hex Parameter Store SecureString (/s2c/{stage}/token-enc-key),
// itself KMS-encrypted by Parameter Store. A dedicated KMS CMK is the documented upgrade
// if per-key audit trails are ever needed.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedValue {
  iv: string; // hex, 12 bytes
  ct: string; // hex ciphertext
  tag: string; // hex, 16-byte GCM auth tag
}

function keyBuffer(hexKey: string): Buffer {
  const key = Buffer.from(hexKey, 'hex');
  if (key.length !== 32) throw new Error('token-enc-key must be 32 bytes of hex');
  return key;
}

export function encrypt(plaintext: string, hexKey: string): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuffer(hexKey), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('hex'),
    ct: ct.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
  };
}

export function decrypt(value: EncryptedValue, hexKey: string): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyBuffer(hexKey),
    Buffer.from(value.iv, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(value.tag, 'hex'));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(value.ct, 'hex')),
    decipher.final(),
  ]);
  return pt.toString('utf8');
}
