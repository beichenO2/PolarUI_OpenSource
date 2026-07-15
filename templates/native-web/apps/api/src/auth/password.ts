import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT_VERSION = 'v1';
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

export class PasswordValidationError extends Error {
  readonly code = 'INVALID_PASSWORD';

  constructor() {
    super('Password must contain 10 to 128 characters');
    this.name = 'PasswordValidationError';
  }
}

function passwordLength(password: string): number {
  return Array.from(password).length;
}

function isValidPassword(password: string): boolean {
  const length = passwordLength(password);
  return length >= 10 && length <= 128;
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_BYTES,
      {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: 64 * 1024 * 1024,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

function decodeBase64(value: string, expectedBytes: number): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength !== expectedBytes || decoded.toString('base64') !== value) return null;
  return decoded;
}

export async function hashPassword(password: string): Promise<string> {
  if (!isValidPassword(password)) throw new PasswordValidationError();
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(password, salt);
  return [
    'scrypt',
    SCRYPT_VERSION,
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (!isValidPassword(password)) return false;
  const parts = encoded.split('$');
  if (
    parts.length !== 7 ||
    parts[0] !== 'scrypt' ||
    parts[1] !== SCRYPT_VERSION ||
    parts[2] !== String(SCRYPT_N) ||
    parts[3] !== String(SCRYPT_R) ||
    parts[4] !== String(SCRYPT_P)
  ) {
    return false;
  }

  const salt = decodeBase64(parts[5] ?? '', SALT_BYTES);
  const expected = decodeBase64(parts[6] ?? '', KEY_BYTES);
  if (!salt || !expected) return false;

  const actual = await deriveKey(password, salt);
  return timingSafeEqual(actual, expected);
}
