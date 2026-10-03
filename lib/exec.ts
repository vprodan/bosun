// Executors (local model, other-vendor workers) and the cross-vendor reviewer.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { P, spec, harness, type Cfg, type Spec } from './config.ts';
import { die, sh, has, up } from './util.ts';
import * as orca from './orca.ts';
import type { Job } from './orca.ts';
import { reviewerBody } from './roles.ts';

export const RULES = `You are a fast code executor. Do exactly the task below, nothing more: no refactors, no new dependencies, no unrelated files.
Read only what you need (search with grep or rg), make the edits, and run the verify command if one is given.
If the task is ambiguous or impossible, stop and say why instead of guessing.
Finish with: FILES CHANGED (list), VERIFY (command + pass/fail), NOTES (anything not done). Keep it short.`;
// --bare (local) exposes only Bash/Edit/Read, so searching goes through these read-only Bash commands.
export const ALLOW = ['Read', 'Edit', 'Write', 'Glob', 'Grep',
  'Bash(git mv *)', 'Bash(mkdir -p *)', 'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)', 'Bash(git grep*)', 'Bash(git ls-files*)',
  'Bash(ls*)', 'Bash(rg *)', 'Bash(grep *)', 'Bash(cat *)', 'Bash(head *)', 'Bash(tail *)', 'Bash(wc *)',
  'Bash(yarn test*)', 'Bash(yarn lint*)', 'Bash(yarn tsc*)', 'Bash(yarn jest*)', 'Bash(yarn vitest*)', 'Bash(yarn eslint*)', 'Bash(yarn prettier*)',
  'Bash(npm test*)', 'Bash(npm run test*)', 'Bash(npm run lint*)', 'Bash(npm run typecheck*)',
  'Bash(pnpm test*)', 'Bash(pnpm lint*)', 'Bash(pnpm tsc*)', 'Bash(bun test*)',
  'Bash(npx tsc*)', 'Bash(npx jest*)', 'Bash(npx vitest*)', 'Bash(npx eslint*)', 'Bash(npx biome*)', 'Bash(npx prettier*)'];
export const DENY = ['WebFetch', 'WebSearch', 'Bash(git commit*)', 'Bash(git push*)', 'Bash(git reset*)', 'Bash(git checkout*)',
  'Bash(git restore*)', 'Bash(git clean*)', 'Bash(git stash*)', 'Bash(git rebase*)', 'Bash(rm *)'];
// Claude executors: only these tools exist, only ALLOW runs, everything else is denied without asking.
export const FENCE = ['--no-session-persistence', '--permission-mode', 'dontAsk', '--tools', 'Read,Edit,Write,Glob,Grep,Bash',
  '--allowedTools', ...ALLOW, '--disallowedTools', ...DENY, '--output-format', 'text'];
export const SUBSCRIPTION_ONLY = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];
const effortC = (s: Spec) => (s.effort ? ['-c', `model_reasoning_effort="${s.effort}"`] : []);

// Job: { cmd, args, set (env to add), unset (env to remove) }; the caller adds cwd.
export function buildRun(ex: string, task: string, cfg: Cfg): Job {
  const prompt = `${RULES}\n\nTASK:\n${task}`;
  const set: Record<string, string> = { BOSUN_DEPTH: '1' };
  if (ex === 'local') {
    const h = harness(cfg);
    if (h === 'claude') {
      // --bare: no hooks/plugins/CLAUDE.md, never reads the subscription keychain; own config dir, so no user permissions
      return {
        cmd: 'claude',
        // strip the parent session's own vars (messaging socket, effort, …); ours are set after
        unset: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_CODE_*'],
        set: {
          ...set, CLAUDE_CONFIG_DIR: path.join(P.BOSUN, 'claude-local'), ANTHROPIC_BASE_URL: cfg.OLLAMA_URL, ANTHROPIC_API_KEY: 'ollama',
          ANTHROPIC_DEFAULT_OPUS_MODEL: cfg.LOCAL_MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL: cfg.LOCAL_MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL: cfg.LOCAL_MODEL,
          CLAUDE_CODE_SUBAGENT_MODEL: cfg.LOCAL_MODEL, CLAUDE_CODE_AUTO_COMPACT_WINDOW: cfg.CTX, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        args: ['-p', prompt, '--bare', '--model', cfg.LOCAL_MODEL, '--max-turns', cfg.LOCAL_MAX_TURNS, ...FENCE],
      };
    }
    if (h === 'codex') {
      // OS sandbox: writes only inside the repo (.git protected), no network; ignores your config.toml
      return {
        cmd: 'codex', unset: [], set: { ...set, CODEX_OSS_BASE_URL: `${cfg.OLLAMA_URL}/v1` },
        args: ['exec', '--oss', '--local-provider', 'ollama', '-m', cfg.LOCAL_MODEL, '-s', 'workspace-write',
          '-c', 'sandbox_workspace_write.network_access=false', '-c', `model_context_window=${cfg.CTX}`,
          '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', prompt],
      };
    }
    die('LOCAL_HARNESS must be claude, codex or auto');
  }
  if (ex === 'codex') {
    const s = spec(cfg.WORKER_BY_CODEX);
    return { cmd: 'codex', unset: [], set, args: ['exec', '-m', s.model, ...effortC(s), '-s', 'workspace-write', '--ephemeral', prompt] };
  }
  if (ex === 'claude') {
    const s = spec(cfg.WORKER_BY_CLAUDE);
    return {
      cmd: 'claude', unset: SUBSCRIPTION_ONLY, set,
      args: ['-p', prompt, '--model', s.model, ...(s.effort ? ['--effort', s.effort] : []), '--restricted', '--strict-mcp-config', '--max-turns', '60', ...FENCE],
    };
  }
  return die('-e must be local, codex or claude', 2);
}

function spawnJob(job: Job, input?: string): number {
  const env = orca.jobEnv(process.env, job);
  const r = spawnSync(job.cmd, job.args, { cwd: job.cwd, env, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
  if (r.error) die(`${job.cmd}: ${r.error.message}`);
  return r.status === null ? 1 : r.status;
}

export function run(argv: string[], cfg: Cfg): number {
  const o = { ex: 'local', watch: true, task: [] as string[] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-e') o.ex = argv[++i];
    else if (a === '--no-watch') o.watch = false;
    else if (a === '-f') {
      const f = argv[++i];
      if (!f) die('-f needs a file, or - for stdin', 2);
      o.task.push(fs.readFileSync(f === '-' ? 0 : f, 'utf8'));
    } else o.task.push(a);
  }
  const task = o.task.join(' ').trim();
  if (!task) die('usage: bosun run [-e local|codex|claude] "task" | -f spec.md | -f - [--no-watch]', 2);
  if (process.env.BOSUN_DEPTH) die('refusing a nested run (already inside a bosun executor)');
  if (sh('git', ['rev-parse', '--is-inside-work-tree']).code) console.error('bosun: warning: not a git repo, so there is no git diff to review');
  if (o.ex === 'local' && !up(`${cfg.OLLAMA_URL}/api/tags`)) die(`Ollama down: unreachable at ${cfg.OLLAMA_URL} (local: bosun start ollama)`);
  if (o.ex !== 'local' && !has(o.ex)) die(`${o.ex} not installed`);
  const job: Job = { ...buildRun(o.ex, task, cfg), cwd: process.cwd() };
  if (o.watch && cfg.WATCH !== 'off' && orca.inOrca()) {
    const rc = orca.watch(job.cmd === 'claude' ? streamed(job) : job, cfg);
    if (rc !== null) return rc;
  }
  return spawnJob(job);
}

// In a watched split, Claude streams events (text mode prints only at the end); execJob turns them into pane lines.
function streamed(job: Job): Job {
  const i = job.args.indexOf('--output-format');
  const args = [...job.args.slice(0, i), '--output-format', 'stream-json', '--verbose', ...job.args.slice(i + 2)];
  return { ...job, args, stream: 'claude-json' };
}

export const hostNow = (env: NodeJS.ProcessEnv = process.env): string | null => (env.CLAUDECODE === '1' ? 'claude' : env.CODEX_THREAD_ID ? 'codex' : null);

export function buildReview(vendor: string, cfg: Cfg, override?: string): Job {
  const set = { BOSUN_DEPTH: '1' };
  if (vendor === 'codex') {
    const s = spec(override || cfg.REVIEW_BY_CODEX);
    return { cmd: 'codex', unset: [], set, args: ['exec', '-m', s.model, ...effortC(s), '-s', 'read-only', '--ephemeral', '-'] };
  }
  if (vendor === 'claude') {
    const s = spec(override || cfg.REVIEW_BY_CLAUDE);
    return {
      cmd: 'claude', unset: SUBSCRIPTION_ONLY, set,
      // --restricted: ignores user/project/local settings, so a repo's allow rules can't widen the reviewer
      args: ['-p', '--restricted', '--strict-mcp-config', '--model', s.model, ...(s.effort ? ['--effort', s.effort] : []), '--no-session-persistence',
        '--permission-mode', 'dontAsk', '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read', 'Glob', 'Grep', '--output-format', 'text'],
    };
  }
  return die('--vendor must be claude or codex', 2);
}

function defaultBase(): string {
  for (const ref of ['origin/HEAD', 'main', 'master']) if (sh('git', ['rev-parse', '--verify', '--quiet', ref]).code === 0) return ref;
  return die('no base branch found (pass --base <ref>)');
}

export function review(argv: string[], cfg: Cfg): number {
  const o = { pr: null as string | null, base: null as string | null, vendor: null as string | null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pr') o.pr = argv[++i];
    else if (a === '--base') o.base = argv[++i];
    else if (a === '--vendor') o.vendor = argv[++i];
    else die(`unknown option ${a} (bosun review [--pr N] [--base ref] [--vendor claude|codex])`, 2);
  }
  if (process.env.BOSUN_DEPTH) die('refusing a nested review (already inside a bosun executor)');
  let diff: string;
  let untracked: string[] = [];
  if (o.pr) {
    const r = sh('gh', ['pr', 'diff', String(o.pr)]);
    if (r.code) die(`gh pr diff ${o.pr}: ${r.err}`);
    diff = r.out;
  } else {
    const base = o.base || defaultBase();
    const mb = sh('git', ['merge-base', base, 'HEAD']);
    if (mb.code) die(`git merge-base ${base} HEAD: ${mb.err}`);
    const d = sh('git', ['diff', mb.out]);
    if (d.code) die(`git diff: ${d.err}`);
    diff = d.out;
    untracked = sh('git', ['ls-files', '--others', '--exclude-standard', '--full-name', '--', ':/']).out.split('\n').filter(Boolean);   // whole repo; git diff omits these
  }
  if (!diff.trim() && !untracked.length) { console.log('nothing to review: no changes against the base'); return 0; }
  const host = hostNow();
  let vendor = o.vendor || (host === 'claude' ? 'codex' : host === 'codex' ? 'claude' : has('codex') ? 'codex' : 'claude');
  let override: string | undefined;
  if (!has(vendor)) {
    const other = vendor === 'codex' ? 'claude' : 'codex';
    if (!has(other)) die('neither claude nor codex is installed');
    console.error(`bosun: ${vendor} is not installed, so this is a same-vendor review (${other})`);
    override = cfg[`ROLE_REVIEWER_${other.toUpperCase()}`];
    vendor = other;
  }
  const extra = untracked.length ? `New untracked files (read them too): ${untracked.join(', ')}\n\n` : '';
  const input = `${reviewerBody()}\n\nReview the change below.\n\n${extra}DIFF:\n${diff}\n`;
  return spawnJob({ ...buildReview(vendor, cfg, override), cwd: process.cwd() }, input);
}
