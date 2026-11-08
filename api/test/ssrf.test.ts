import { describe, expect, it } from 'vitest';
import { assertPublicHttpUrl, isBlockedIp } from '../src/lib/ssrf.js';

const pub = async () => [{ address: '93.184.216.34' }];
const priv = async () => [{ address: '127.0.0.1' }];

describe('SSRF guard', () => {
  it('blocks loopback, private, link-local and metadata addresses', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it('refuses non-https schemes', async () => {
    await expect(assertPublicHttpUrl('http://127.0.0.1:9010/x', pub)).rejects.toThrow();
    await expect(assertPublicHttpUrl('file:///etc/passwd', pub)).rejects.toThrow();
  });

  it('refuses a literal private IP host', async () => {
    await expect(assertPublicHttpUrl('https://127.0.0.1/x', pub)).rejects.toThrow();
    await expect(assertPublicHttpUrl('https://169.254.169.254/latest/meta-data/', pub)).rejects.toThrow();
  });

  it('refuses localhost and a host that resolves to a private address', async () => {
    await expect(assertPublicHttpUrl('https://localhost/x', pub)).rejects.toThrow();
    await expect(assertPublicHttpUrl('https://rebind.attacker.test/x', priv)).rejects.toThrow();
  });

  it('allows a public https URL', async () => {
    const u = await assertPublicHttpUrl('https://cdn.example.com/a.jpg', pub);
    expect(u.hostname).toBe('cdn.example.com');
  });
});
