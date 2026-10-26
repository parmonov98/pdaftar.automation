import type { PdProduct } from '../pdaftar/client.js';

/**
 * Customers in Uzbekistan write in Uzbek Latin, Uzbek Cyrillic or Russian, while most shop
 * catalogs are typed in Latin. When the catalog search finds nothing, we retry with the
 * query transliterated, then with word stems (Russian endings: "колу" → "kol").
 */

const CYR_TO_LAT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 's', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '',
  ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: "o'", қ: 'q', ғ: "g'", ҳ: 'h',
};

const LAT_TO_CYR: [string, string][] = [
  ["o'", 'ў'], ["g'", 'ғ'], ['sh', 'ш'], ['ch', 'ч'], ['yo', 'ё'], ['yu', 'ю'], ['ya', 'я'],
  ['a', 'а'], ['b', 'б'], ['v', 'в'], ['g', 'г'], ['d', 'д'], ['e', 'е'], ['j', 'ж'], ['z', 'з'], ['i', 'и'], ['y', 'й'],
  ['k', 'к'], ['l', 'л'], ['m', 'м'], ['n', 'н'], ['o', 'о'], ['p', 'п'], ['r', 'р'], ['s', 'с'], ['t', 'т'], ['u', 'у'],
  ['f', 'ф'], ['x', 'х'], ['q', 'қ'], ['h', 'ҳ'], ['c', 'к'], ['w', 'в'],
];

export function toLatin(text: string): string {
  return [...text.toLowerCase()].map((ch) => CYR_TO_LAT[ch] ?? ch).join('');
}

export function toCyrillic(text: string): string {
  let s = text.toLowerCase().replace(/[‘’ʻʼ`]/g, "'");
  let out = '';
  while (s.length) {
    const hit = LAT_TO_CYR.find(([lat]) => s.startsWith(lat));
    if (hit) {
      out += hit[1];
      s = s.slice(hit[0].length);
    } else {
      out += s[0];
      s = s.slice(1);
    }
  }
  return out;
}

const hasCyrillic = (s: string) => /[а-яёўқғҳ]/i.test(s);

/** Query variants to try, most specific first, without duplicates. */
export function queryVariants(query: string): string[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q) return [];
  const other = hasCyrillic(q) ? toLatin(q) : toCyrillic(q);
  const longest = (s: string) => s.split(' ').filter((w) => w.length >= 3).sort((a, b) => b.length - a.length)[0] ?? '';
  const stem = (w: string) => (w.length > 4 ? w.slice(0, -2) : w.length > 3 ? w.slice(0, -1) : w);
  const variants = [q, other, longest(q), longest(other), stem(longest(q)), stem(longest(other))];
  return [...new Set(variants.filter((v) => v.length >= 2))];
}

/** Runs the catalog search through the variants until one returns products. */
export async function searchWithFallbacks(search: (q: string) => Promise<PdProduct[]>, query: string): Promise<PdProduct[]> {
  for (const v of queryVariants(query).slice(0, 5)) {
    const found = await search(v);
    if (found.length) return found;
  }
  return [];
}
