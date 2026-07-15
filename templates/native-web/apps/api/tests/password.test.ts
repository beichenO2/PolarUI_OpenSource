import { describe, expect, it } from 'vitest';
import {
  PasswordValidationError,
  hashPassword,
  verifyPassword,
} from '../src/auth/password.js';

describe('password hashing', () => {
  it('accepts passwords from 10 to 128 characters', async () => {
    await expect(hashPassword('a'.repeat(10))).resolves.toMatch(/^scrypt\$v1\$/);
    await expect(hashPassword('密'.repeat(128))).resolves.toMatch(/^scrypt\$v1\$/);
  });

  it('rejects passwords outside the supported length', async () => {
    for (const invalid of ['a'.repeat(9), 'a'.repeat(129)]) {
      await expect(hashPassword(invalid)).rejects.toBeInstanceOf(PasswordValidationError);
    }
  });

  it('verifies the correct password and rejects a wrong password', async () => {
    const encoded = await hashPassword('correct-horse-battery-staple');
    expect(encoded.split('$')).toHaveLength(7);
    await expect(verifyPassword('correct-horse-battery-staple', encoded)).resolves.toBe(true);
    await expect(verifyPassword('wrong-password', encoded)).resolves.toBe(false);
  });

  it('uses an independent random salt for every password hash', async () => {
    const first = await hashPassword('correct-horse-battery-staple');
    const second = await hashPassword('correct-horse-battery-staple');
    expect(first).not.toBe(second);
  });

  it('returns false for malformed or unsupported encoded hashes', async () => {
    await expect(verifyPassword('password-password', 'not-a-hash')).resolves.toBe(false);
    await expect(
      verifyPassword('password-password', 'scrypt$v2$16384$8$1$c2FsdA$aGFzaA'),
    ).resolves.toBe(false);
  });
});
