// The JSON Schema subset bosun uses (MCP tool input, the memory API, LLM output). Error messages name the path, never the value.
export type Schema = {
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean'; description?: string;
  properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean;
  items?: Schema; maxItems?: number; enum?: readonly unknown[];
  minLength?: number; maxLength?: number; pattern?: string; minimum?: number; maximum?: number;
};
export function validate(s: Schema, v: unknown, at = '$'): string | null {
  if (s.type === 'object') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return `${at}: expected an object`;
    const o = v as Record<string, unknown>;
    for (const k of s.required || []) if (o[k] === undefined) return `${at}.${k}: required`;
    for (const [k, x] of Object.entries(o)) {
      if (x === undefined) continue;
      const p = s.properties?.[k];
      if (!p) { if (s.additionalProperties === false) return `${at}.${k}: unknown field`; continue; }
      const e = validate(p, x, `${at}.${k}`);
      if (e) return e;
    }
  } else if (s.type === 'array') {
    if (!Array.isArray(v)) return `${at}: expected an array`;
    if (s.maxItems !== undefined && v.length > s.maxItems) return `${at}: more than ${s.maxItems} items`;
    if (s.items) for (const [i, x] of v.entries()) { const e = validate(s.items, x, `${at}[${i}]`); if (e) return e; }
  } else if (s.type === 'string') {
    if (typeof v !== 'string') return `${at}: expected a string`;
    if (s.minLength !== undefined && v.length < s.minLength) return `${at}: shorter than ${s.minLength}`;
    if (s.maxLength !== undefined && v.length > s.maxLength) return `${at}: longer than ${s.maxLength}`;
    if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) return `${at}: invalid format`;
  } else if (s.type === 'integer' || s.type === 'number') {
    if (typeof v !== 'number' || !Number.isFinite(v) || (s.type === 'integer' && !Number.isInteger(v))) return `${at}: expected ${s.type === 'integer' ? 'an integer' : 'a number'}`;
    if (s.minimum !== undefined && v < s.minimum) return `${at}: below ${s.minimum}`;
    if (s.maximum !== undefined && v > s.maximum) return `${at}: above ${s.maximum}`;
  } else if (s.type === 'boolean' && typeof v !== 'boolean') return `${at}: expected true or false`;
  if (s.enum && !s.enum.includes(v)) return `${at}: must be one of ${s.enum.join(', ')}`;
  return null;
}
