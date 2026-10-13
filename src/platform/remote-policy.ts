import { BlockList, isIP } from 'node:net';
import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import type { Env } from '../core/domain/inference.ts';

const bad = () => new BosunError('invalid', 'Remote transport configuration unavailable');
export function remoteNetwork(allow: readonly string[]) {
  if (!allow.length || allow.length > 100) throw bad();
  const list = new BlockList();
  for (const cidr of allow) {
    const match = /^([^/]+)\/(\d{1,3})$/.exec(cidr);
    if (!match) throw bad();
    const family = isIP(match[1]),
      bits = Number(match[2]);
    if (!family || bits > (family === 4 ? 32 : 128)) throw bad();
    list.addSubnet(match[1], bits, family === 4 ? 'ipv4' : 'ipv6');
  }
  return (address: string | undefined) => {
    if (!address) return false;
    const plain =
      address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
    const family = isIP(plain);
    return !!family && list.check(plain, family === 4 ? 'ipv4' : 'ipv6');
  };
}
export function remoteEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw bad();
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw bad();
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw bad();
  return url;
}
export function remoteToken(env: Env, key: string, required = true): string | null {
  if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(key)) throw bad();
  const descriptor = Object.getOwnPropertyDescriptor(env, key);
  const value = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  if (value === undefined && !required) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32,512}$/.test(value))
    throw new BosunError('unavailable', 'Remote credential unavailable');
  return value;
}
export function remoteTokenMatches(header: unknown, expected: string | null): boolean {
  if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{32,512}$/.test(header) || !expected)
    return false;
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(header.slice(7)).digest(),
    crypto.createHash('sha256').update(expected).digest(),
  );
}
