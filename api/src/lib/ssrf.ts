import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF guard for URLs that arrive from a connected shop's data (product
 * image URLs, inbound audio URLs). The server fetches these, so an
 * attacker-chosen URL must not be able to reach loopback, link-local,
 * cloud-metadata, or private-network addresses.
 *
 * The DNS resolver is injectable so tests (and the mock AI provider) can
 * pass fake hosts without a real lookup.
 */
export type LookupFn = (hostname: string) => Promise<Array<{ address: string }>>;

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true });

/** True for loopback, private, link-local, CGNAT, ULA, and unspecified addresses. */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedV4(ip);
  if (v === 6) return isBlockedV6(ip);
  return true; // not a parseable IP → treat as blocked
}

function isBlockedV4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const a = p[0]!;
  const b = p[1]!;
  if (a === 0 || a === 10 || a === 127) return true; // this-net, private, loopback
  if (a === 169 && b === 254) return true; // link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isBlockedV6(ip: string): boolean {
  const addr = ip.toLowerCase();
  if (addr === '::' || addr === '::1') return true; // unspecified, loopback
  // IPv4-mapped (::ffff:a.b.c.d) → judge by the embedded v4 address.
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]!);
  if (addr.startsWith('fe8') || addr.startsWith('fe9') || addr.startsWith('fea') || addr.startsWith('feb')) return true; // link-local fe80::/10
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // unique-local fc00::/7
  return false;
}

/**
 * Resolve and validate a URL before the server fetches it. Throws on any
 * unsafe URL; returns the parsed URL on success.
 */
export async function assertPublicHttpUrl(url: string, lookup: LookupFn = defaultLookup): Promise<URL> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }
  if (u.protocol !== 'https:') throw new Error(`Refusing non-https URL: ${u.protocol}`);
  if (u.port && u.port !== '443') throw new Error(`Refusing non-standard port: ${u.port}`);

  const host = u.hostname;
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new Error('Refusing private/loopback address');
    return u;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('Refusing local hostname');
  }

  const records = await lookup(host);
  if (!records.length) throw new Error('Host did not resolve');
  for (const r of records) {
    if (isBlockedIp(r.address)) throw new Error('Host resolves to a private/loopback address');
  }
  return u;
}
