import { describe, expect, it } from 'vitest';
import { toIpPrefix } from '../src/auth/session.js';

describe('toIpPrefix', () => {
  it('stores only IPv4 /24 and IPv6 /64 network prefixes', () => {
    expect(toIpPrefix('192.0.2.41')).toBe('192.0.2.0/24');
    expect(toIpPrefix('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3:8d3::/64');
    expect(toIpPrefix('::ffff:192.0.2.41')).toBe('192.0.2.0/24');
    expect(toIpPrefix('not-an-ip')).toBeNull();
  });
});
