import { describe, expect, it } from 'vitest';
import {
  IdentityValidationError,
  normalizeEmail,
  normalizeUsername,
  parseEmail,
  parseUsername,
} from '../src/auth/identifiers.js';

describe('identity identifiers', () => {
  it('normalizes email with trim, NFKC, and lowercase comparison', () => {
    expect(normalizeEmail('  Ｒeader@Example.COM  ')).toBe('reader@example.com');
    expect(parseEmail('  Ｒeader@Example.COM  ')).toEqual({
      value: 'Reader@Example.COM',
      normalized: 'reader@example.com',
    });
  });

  it('preserves normalized username display while comparing lowercase', () => {
    expect(normalizeUsername('  Ａlice_研究-1  ')).toBe('alice_研究-1');
    expect(parseUsername('  Ａlice_研究-1  ')).toEqual({
      value: 'Alice_研究-1',
      normalized: 'alice_研究-1',
    });
  });

  it('accepts only 3 to 32 Unicode letters, numbers, underscore, and hyphen', () => {
    expect(parseUsername('研究者_01').value).toBe('研究者_01');
    for (const invalid of ['ab', 'a'.repeat(33), 'bad name', 'bad!', '🙂🙂🙂']) {
      expect(() => parseUsername(invalid)).toThrowError(
        expect.objectContaining({ code: 'INVALID_USERNAME' }),
      );
    }
  });

  it('returns stable validation errors for invalid email', () => {
    try {
      parseEmail('not-an-email');
      throw new Error('expected parseEmail to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(IdentityValidationError);
      expect(error).toMatchObject({ code: 'INVALID_EMAIL' });
    }
  });
});
