// Deterministic pure text policy, preserved from the SQLite helper.
const STOP = new Set(('a an and are as at be been but by can could did do does for from had has have how i if in into is it its '
  + 'just me my no not of on or our please should so some than that the their them then there these they this those to too up us '
  + 'was we were what when where which who why will with would you your').split(' '));

// fetchCart → fetchcart, fetch, cart; get_cart → get_cart, get, cart. Stop words and 1-letter tokens go. Capped at max terms.
export function terms(text: string, max = 24): string[] {
  const out = new Set<string>();
  for (const raw of text.slice(0, 20000).match(/[\p{L}\p{N}_]+/gu) || []) {
    const parts = raw.split('_').flatMap((p) => p.split(/(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u));
    for (const t of [raw, ...parts].map((x) => x.toLowerCase())) {
      if (t.length > 1 && !STOP.has(t)) out.add(t);
      if (out.size >= max) return [...out];
    }
  }
  return [...out];
}
// Every term quoted, OR-joined: '"fetchcart" OR "fetch" OR "cart"'. Empty when nothing is left.
export const ftsQuery = (text: string): string => terms(text).map((t) => `"${t}"`).join(' OR ');

export const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
export const words = (s: string): Set<string> => new Set(norm(s).match(/[\p{L}\p{N}]+/gu) || []);
export function jaccard(a: Set<string>, b: Set<string>): number {
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  const union = a.size + b.size - both;
  return union ? both / union : 1;
}
