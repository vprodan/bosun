import { BosunError } from './errors.ts';

// A deterministic ingress screen, not a claim that arbitrary secrets are detectable.
// Never return, log or quarantine the matched value. Privacy classification is separate.
const CREDENTIALS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/,
  /(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[^\s"';,]{16,}/i,
  /\bBearer\s+[A-Za-z0-9._~-]{24,}/i,
];
export function screenPublicText(text: string): void {
  if (CREDENTIALS.some(pattern => pattern.test(text))) throw new BosunError('private_input', 'Input withheld by credential screening');
}
