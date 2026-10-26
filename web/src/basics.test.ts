import { describe, expect, it } from 'vitest';
import { formatPrice } from './api';
import { DICTS } from './i18n';

describe('web basics', () => {
  it('formats prices like the API', () => {
    expect(formatPrice(189000, 'UZS')).toBe("189 000 so'm");
    expect(formatPrice(null, 'UZS')).toBe('—');
    expect(formatPrice(12, 'USD')).toBe('$12');
  });

  it('every language has every key and status label', () => {
    const keys = Object.keys(DICTS.uz).sort();
    for (const lang of ['ru', 'en'] as const) {
      expect(Object.keys(DICTS[lang]).sort()).toEqual(keys);
      expect(Object.keys(DICTS[lang].status).sort()).toEqual(Object.keys(DICTS.uz.status).sort());
      expect(Object.keys(DICTS[lang].promoStatus).sort()).toEqual(Object.keys(DICTS.uz.promoStatus).sort());
      expect(Object.keys(DICTS[lang].templates).sort()).toEqual(Object.keys(DICTS.uz.templates).sort());
    }
  });
});
