// One source per role (roles/<name>.md) rendered as a Claude Code subagent and a Codex agent.
import fs from 'node:fs';
import path from 'node:path';
import { P, role, type Cfg } from './config.ts';

export const MARK = 'generated-by: bosun';
export const ACCESS: Record<string, { tools: string; sandbox: string }> = {
  read: { tools: 'Read, Glob, Grep, Bash', sandbox: 'read-only' },
  run: { tools: 'Read, Glob, Grep, Bash', sandbox: 'workspace-write' },     // runs tests, which write caches
  edit: { tools: 'Read, Edit, Write, Glob, Grep, Bash', sandbox: 'workspace-write' },
  tests: { tools: 'Read, Edit, Write, Glob, Grep, Bash', sandbox: 'workspace-write' },
};
export type Role = { name: string; description: string; access: string; body: string };

export function parseRole(file: string): Role {
  const m = fs.readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing frontmatter`);
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (!meta.description || !ACCESS[meta.access]) throw new Error(`${file}: needs description and access (${Object.keys(ACCESS).join('|')})`);
  return { name: path.basename(file, '.md'), description: meta.description, access: meta.access, body: m[2].trim() };
}

const ROLES_DIR = path.join(P.REPO, 'roles');
export const allRoles = (): Role[] => fs.readdirSync(ROLES_DIR).filter((f) => f.endsWith('.md')).sort().map((f) => parseRole(path.join(ROLES_DIR, f)));
export const reviewerBody = (): string => parseRole(path.join(ROLES_DIR, 'reviewer.md')).body;
const header = (r: Role) => `${MARK} (source: roles/${r.name}.md; edit there, then bosun install)`;

export function renderClaude(r: Role, cfg: Cfg): string {
  const { model, effort } = role(cfg, r.name, 'claude');
  return ['---', `# ${header(r)}`, `name: bosun-${r.name}`, `description: ${JSON.stringify(r.description)}`,
    `model: ${model}`, ...(effort ? [`effort: ${effort}`] : []), `tools: ${ACCESS[r.access].tools}`, '---', r.body, ''].join('\n');
}

export function renderCodex(r: Role, cfg: Cfg): string {
  const { model, effort } = role(cfg, r.name, 'codex');
  if (r.body.includes("'''")) throw new Error(`roles/${r.name}.md: body must not contain '''`);
  return [`# ${header(r)}`, `name = "bosun_${r.name}"`, `description = ${JSON.stringify(r.description)}`,
    `model = ${JSON.stringify(model)}`, ...(effort ? [`model_reasoning_effort = ${JSON.stringify(effort)}`] : []),
    `sandbox_mode = "${ACCESS[r.access].sandbox}"`, "developer_instructions = '''", r.body, "'''", ''].join('\n');
}
