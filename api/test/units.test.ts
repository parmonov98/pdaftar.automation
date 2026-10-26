import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extractContent, MetaModels, parseSamBox, responseText } from '../src/ai/models.js';
import { checkGrounding, normalisePhone, parseJson } from '../src/ai/replies.js';
import { parseWebhook } from '../src/instagram/webhook.js';
import { decrypt, encrypt, verifyMetaSignature } from '../src/lib/crypto.js';
import { normaliseProduct } from '../src/pdaftar/client.js';
import { shortNoun } from '../src/services/promo.js';
import { formatPrice, wrap } from '../src/video/render.js';

describe('crypto', () => {
  it('round-trips and rejects tampering', () => {
    const key = randomBytes(32).toString('base64');
    const enc = encrypt('IGQVJ-token', key);
    expect(decrypt(enc, key)).toBe('IGQVJ-token');
    const raw = Buffer.from(enc, 'base64');
    raw[raw.length - 1] ^= 1;
    expect(() => decrypt(raw.toString('base64'), key)).toThrow();
  });

  it('verifies Meta signatures over the raw body', () => {
    const body = Buffer.from('{"object":"instagram"}');
    const sig = `sha256=${createHmac('sha256', 's3').update(body).digest('hex')}`;
    expect(verifyMetaSignature(body, sig, 's3')).toBe(true);
    expect(verifyMetaSignature(body, sig, 'other')).toBe(false);
    expect(verifyMetaSignature(body, undefined, 's3')).toBe(false);
    expect(verifyMetaSignature(body, 'sha1=abc', 's3')).toBe(false);
  });
});

describe('parseWebhook', () => {
  it('reads comments from changes[] and skips our own', () => {
    const events = parseWebhook({
      object: 'instagram',
      entry: [
        {
          id: '178',
          time: 1,
          changes: [
            { field: 'comments', value: { id: 'c1', text: 'narxi qancha?', from: { id: '9', username: 'ali' }, media: { id: 'm1' } } },
            { field: 'comments', value: { id: 'c2', text: 'rahmat', from: { id: '178', username: 'shop' }, media: { id: 'm1' } } },
          ],
        },
      ],
    });
    expect(events).toEqual([
      { kind: 'comment', accountId: '178', commentId: 'c1', mediaId: 'm1', fromId: '9', fromUsername: 'ali', text: 'narxi qancha?', parentId: null },
    ]);
  });

  it('reads the flat field/value shape too', () => {
    const events = parseWebhook({ object: 'instagram', entry: [{ id: '178', field: 'comments', value: { id: 'c3', text: 'bormi', from: { id: '9' } } }] });
    expect(events).toHaveLength(1);
  });

  it('reads DMs with images and drops echoes', () => {
    const events = parseWebhook({
      object: 'instagram',
      entry: [
        {
          id: '178',
          messaging: [
            { sender: { id: '55' }, recipient: { id: '178' }, timestamp: 5, message: { mid: 'a', text: 'salom', attachments: [{ type: 'image', payload: { url: 'https://x/i.jpg' } }] } },
            { sender: { id: '178' }, recipient: { id: '55' }, message: { mid: 'b', text: 'echo', is_echo: true } },
          ],
        },
      ],
    });
    expect(events).toEqual([{ kind: 'message', accountId: '178', senderId: '55', mid: 'a', text: 'salom', imageUrls: ['https://x/i.jpg'], timestamp: 5 }]);
  });

  it('ignores other objects', () => {
    expect(parseWebhook({ object: 'page', entry: [] })).toEqual([]);
    expect(parseWebhook(null)).toEqual([]);
  });
});

describe('checkGrounding', () => {
  const products = [{ price: 189000 }, { price: 14000 }];
  it('accepts real prices in any grouping', () => {
    expect(checkGrounding('Narxi 189 000 so‘m', products, true).ok).toBe(true);
    expect(checkGrounding('Narxi 14.000 so‘m', products, true).ok).toBe(true);
  });
  it('rejects invented prices', () => {
    expect(checkGrounding('Narxi 150 000 so‘m', products, true)).toEqual({ ok: false, reason: 'ungrounded number 150000' });
  });
  it('rejects any price in a public reply when prices are hidden', () => {
    expect(checkGrounding('189 000', products, false).ok).toBe(false);
  });
  it('allows small numbers and phone numbers', () => {
    expect(checkGrounding('3 ta qoldi, tel: +998 90 111 22 33', products, true).ok).toBe(true);
  });
});

describe('model output parsing', () => {
  it('reads OpenAI and Llama-native shapes', () => {
    expect(extractContent({ choices: [{ message: { content: 'hi' } }] })).toBe('hi');
    expect(extractContent({ completion_message: { content: { type: 'text', text: 'yo' } } })).toBe('yo');
    expect(extractContent({})).toBeNull();
  });
  it('parses JSON wrapped in fences or prose', () => {
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJson('Sure: {"a":2} done')).toEqual({ a: 2 });
    expect(parseJson('nope')).toEqual({});
  });
  it('parses the SAM box token', () => {
    const text = '<0f>0<|box;x1=120;y1=80;x2=620;y2=900;w=1000;h=1000|><|mask;x=0;y=0;data=abc|>';
    expect(parseSamBox(text)).toEqual({ x1: 120, y1: 80, x2: 620, y2: 900, w: 1000, h: 1000 });
    expect(parseSamBox('<0f>')).toBeNull();
    expect(responseText({ output: [{ content: [{ text: 'a' }, { text: 'b' }] }] })).toBe('ab');
  });
  it('refuses contributor models for customer data', () => {
    expect(() => MetaModels.assertPrivateModel('muse-spark-1.3-contributor')).toThrow();
    expect(() => MetaModels.assertPrivateModel('muse-spark-1.3')).not.toThrow();
  });
});

describe('helpers', () => {
  it('formats prices', () => {
    expect(formatPrice(189000, 'UZS')).toBe("189 000 so'm");
    expect(formatPrice(12.5, 'USD')).toBe('$13');
    expect(formatPrice(5000, null)).toBe("5 000 so'm");
  });
  it('wraps titles', () => {
    expect(wrap('Coca-Cola 1.5 litr gazlangan ichimlik', 18, 3)).toBe('Coca-Cola 1.5 litr\ngazlangan ichimlik');
  });
  it('normalises phones', () => {
    expect(normalisePhone('90 111 22 33')).toBe('+998901112233');
    expect(normalisePhone('+998 (90) 111-22-33')).toBe('+998901112233');
    expect(normalisePhone('123')).toBeNull();
  });
  it('makes a SAM noun phrase', () => {
    expect(shortNoun('Qora futbolka XL (paxta) 100%')).toBe('Qora futbolka XL');
  });
  it('normalises product shapes', () => {
    expect(normaliseProduct({ id: '5', name: 'X', price: { amount: '12000', currency: 'UZS' }, quantity: '3', images: [{ url: 'u' }] })).toEqual({
      id: 5, name: 'X', price: 12000, currency: 'UZS', stock: 3, unit: null, images: ['u'],
    });
  });
});
