import type { FastifyReply, FastifyRequest } from 'fastify';
import { isIP } from 'node:net';
import type { NativeWebConfig } from '../config.js';

export function toIpPrefix(input: string): string | null {
  const value = input.split('%')[0] ?? '';
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const ip = mapped?.[1] ?? value;
  if (isIP(ip) === 4) {
    const octets = ip.split('.');
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }
  if (isIP(ip) !== 6) return null;
  const [leftRaw, rightRaw = ''] = ip.split('::');
  const left = leftRaw ? leftRaw.split(':') : [];
  const right = rightRaw ? rightRaw.split(':') : [];
  const expanded = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    .map((segment) => Number.parseInt(segment || '0', 16).toString(16));
  return `${expanded.slice(0, 4).join(':')}::/64`;
}

export function hasValidOrigin(request: FastifyRequest, publicAppOrigin: string): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(publicAppOrigin).origin;
  } catch {
    return false;
  }
}

export function readSessionToken(request: FastifyRequest, cookieName: string): string | null {
  return request.cookies[cookieName] ?? null;
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  config: NativeWebConfig,
): void {
  reply.setCookie(config.cookie.name, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: config.cookie.secure,
    maxAge: config.sessionTtlSeconds,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: NativeWebConfig): void {
  reply.clearCookie(config.cookie.name, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: config.cookie.secure,
  });
}
