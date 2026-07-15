import { z } from 'zod';

export type IdentityValidationCode = 'INVALID_EMAIL' | 'INVALID_USERNAME';

export class IdentityValidationError extends Error {
  constructor(
    public readonly code: IdentityValidationCode,
    message: string,
  ) {
    super(message);
    this.name = 'IdentityValidationError';
  }
}

export interface ParsedIdentifier {
  value: string;
  normalized: string;
}

const emailSchema = z.string().email();
const usernamePattern = /^[\p{L}\p{N}_-]{3,32}$/u;

function normalizeDisplay(value: string): string {
  return value.normalize('NFKC').trim();
}

export function normalizeEmail(value: string): string {
  return normalizeDisplay(value).toLocaleLowerCase('en-US');
}

export function normalizeUsername(value: string): string {
  return normalizeDisplay(value).toLocaleLowerCase('en-US');
}

export function parseEmail(value: string): ParsedIdentifier {
  const display = normalizeDisplay(value);
  if (!emailSchema.safeParse(display).success) {
    throw new IdentityValidationError('INVALID_EMAIL', 'Email address is invalid');
  }
  return { value: display, normalized: normalizeEmail(display) };
}

export function parseUsername(value: string): ParsedIdentifier {
  const display = normalizeDisplay(value);
  if (!usernamePattern.test(display)) {
    throw new IdentityValidationError(
      'INVALID_USERNAME',
      'Username must contain 3 to 32 letters, numbers, underscores, or hyphens',
    );
  }
  return { value: display, normalized: normalizeUsername(display) };
}
