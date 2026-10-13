import { terms } from './text.ts';

// Fixed policy, independent of evaluation labels or split membership.
export const LEXICAL_MEMORY_POLICY = Object.freeze({
  titleWeight: 5,
  bodyWeight: 1,
  tagWeight: 2,
  excerptChars: 240,
  titleChars: 70,
});
export function memoryExcerpt(body: string, query: string): string {
  const width = LEXICAL_MEMORY_POLICY.excerptChars;
  if (body.length <= width) return body;
  const tokens = terms(query),
    lower = body.toLowerCase(),
    starts = new Set([0]);
  for (const term of tokens) {
    let offset = 0;
    for (let i = 0; i < 4; i++) {
      const at = lower.indexOf(term, offset);
      if (at < 0) break;
      starts.add(Math.max(0, Math.min(body.length - width, at - 60)));
      offset = at + term.length;
    }
  }
  let best = 0,
    score = -1;
  for (const start of starts) {
    const window = lower.slice(start, start + width);
    const n = tokens.filter((term) => window.includes(term)).length;
    if (n > score) {
      best = start;
      score = n;
    }
  }
  return `${best ? '…' : ''}${body.slice(best, best + width)}${best + width < body.length ? '…' : ''}`;
}
