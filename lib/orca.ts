// Orca integration: detection, watchable run splits, side-quest spin-offs, worktree card status.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { P, type Cfg } from './config.ts';
import { sh, has, die, sleep } from './util.ts';

// An executor run: command, args, env to add (set) and remove (unset; a trailing * matches a prefix). The caller adds cwd.
export type Job = { cmd: string; args: string[]; set: Record<string, string>; unset: string[]; cwd?: string; stream?: string };

export const BIN = path.join(P.REPO, 'bin', 'bosun');
export const q = (s: string): string => `'${String(s).replace(/'/g, "'\\''")}'`;   // POSIX quoting for commands Orca types into a shell
const RUNS = () => path.join(P.BOSUN, 'runs');
export const STATUSES = ['todo', 'in-progress', 'in-review', 'completed'];

export function orca(args: string[]): { code: number; json: any; err: string } {
  const r = sh('orca', [...args, '--json']);
  let json: any = null;
  try { json = JSON.parse(r.out); } catch { /* not JSON */ }
  return { code: r.code, json, err: r.err || r.out };
}
export function inOrca(): boolean {
  if (!process.env.ORCA_PANE_KEY || !has('orca')) return false;
  const r = orca(['status']);
  return r.code === 0 && !!r.json && r.json.ok !== false;
}
// ~/.bosun/runs keeps prompts and logs; drop runs older than a week
function prune(): void {
  const cutoff = Date.now() - 7 * 86400000;
  for (const f of fs.readdirSync(RUNS())) {
    const p = path.join(RUNS(), f);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true }); } catch { /* raced with another run */ }
  }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
// Job env: the caller's env, minus `unset` (a trailing * matches a prefix), plus `set`.
export function jobEnv(base: NodeJS.ProcessEnv, job: Job): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const k of Object.keys(env)) if (job.unset.some((u) => (u.endsWith('*') ? k.startsWith(u.slice(0, -1)) : k === u))) delete env[k];
  return Object.assign(env, job.set);
}
// One pane line per streamed Claude event: its text, and each tool call with its target.
const brief = (i: any = {}) => String(i.file_path || i.command || i.pattern || i.path || '').split('\n')[0].slice(0, 100);
const renderEvent = (e: any): string => (e.type === 'assistant' && e.message ? (e.message.content || []).map((c: any) => (
  c.type === 'text' && c.text.trim() ? `${c.text.trim()}\n` : c.type === 'tool_use' ? `→ ${c.name} ${brief(c.input)}\n` : '')).join('') : '');
const claim = (file: string, who: string) => { try { fs.writeFileSync(file, who, { flag: 'wx' }); return true; } catch { return false; } };

// Run a job in an Orca split next to the user and return its exit code.
// Returns null when the split can't open or never starts the run (the caller then runs it inline).
// Whoever creates <id>.pid first owns the run, so it never runs twice.
export function watch(job: Job, cfg: Cfg): number | null {
  const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const base = path.join(RUNS(), id);
  fs.mkdirSync(RUNS(), { recursive: true });
  prune();
  fs.writeFileSync(`${base}.json`, JSON.stringify(job));
  const target = process.env.ORCA_TERMINAL_HANDLE ? ['--terminal', process.env.ORCA_TERMINAL_HANDLE] : [];
  const r = orca(['terminal', 'split', ...target, '--direction', 'horizontal', '--command', `${q(BIN)} _exec ${id}`]);
  // a failure report can still mean the pane opened: claim the run first, so it never runs twice
  if (r.code !== 0 && claim(`${base}.pid`, 'inline')) return null;
  const started = Date.now();
  const startWait = Number(process.env.BOSUN_SPLIT_START_S || 30) * 1000;
  const deadline = started + Number(cfg.RUN_TIMEOUT_MIN) * 60000;
  const done = () => fs.existsSync(`${base}.rc`) && fs.readFileSync(`${base}.rc`, 'utf8').trim() !== '';   // empty = not written yet
  for (;;) {
    if (done()) break;
    if (!fs.existsSync(`${base}.pid`)) {
      if (Date.now() - started > startWait && claim(`${base}.pid`, 'inline')) {
        console.error(`bosun: the Orca split did not start the run in ${startWait / 1000} s; running it here instead`);
        return null;
      }
    } else if (!alive(Number(fs.readFileSync(`${base}.pid`, 'utf8')))) {
      if (done()) break;   // finished between the checks
      console.error(`bosun: the Orca split closed before the run finished; partial log: ${base}.log`);
      return 130;
    }
    if (Date.now() > deadline) {
      const pid = Number(fs.readFileSync(`${base}.pid`, 'utf8'));
      if (pid && alive(pid)) process.kill(pid, 'SIGTERM');   // execJob passes it on to the executor
      console.error(`bosun: the run passed ${cfg.RUN_TIMEOUT_MIN} min, so bosun stopped it; partial log: ${base}.log`);
      return 124;
    }
    sleep(1);
  }
  if (fs.existsSync(`${base}.log`)) process.stdout.write(fs.readFileSync(`${base}.log`, 'utf8'));
  return Number(fs.readFileSync(`${base}.rc`, 'utf8').trim()) || 0;
}

// Runs inside the split: executes the job, mirrors output to the pane and a log, then writes the exit code.
export function execJob(id: string): Promise<number> {
  const base = path.join(RUNS(), id);
  if (!claim(`${base}.pid`, String(process.pid))) { console.error('bosun: this run was already taken over'); return Promise.resolve(0); }
  const job: Job = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'));
  const env = jobEnv(process.env, job);
  const log = fs.openSync(`${base}.log`, 'w');
  let buf = '';
  let result: string | null = null;
  let transcript = '';
  return new Promise((resolve) => {
    let done = false;
    const line = (l: string) => {   // streamed Claude output: show progress in the pane, keep the final result for main
      if (!l.trim()) return;
      let e: any;
      try { e = JSON.parse(l); } catch { process.stdout.write(`${l}\n`); transcript += `${l}\n`; return; }
      if (e.type === 'result') { result = String(e.result === undefined ? '' : e.result); return; }
      const t = renderEvent(e);
      if (t) { process.stdout.write(t); transcript += t; }
    };
    const finish = (code: number) => {
      if (done) return;
      done = true;
      if (job.stream) {
        if (buf) line(buf);
        const text: string = result !== null ? result : transcript;
        if (result !== null) process.stdout.write(`\n${result}\n`);
        fs.writeSync(log, text.endsWith('\n') ? text : `${text}\n`);
      }
      fs.closeSync(log);
      fs.writeFileSync(`${base}.rc.tmp`, String(code));
      fs.renameSync(`${base}.rc.tmp`, `${base}.rc`);   // atomic: a reader never sees a half-written code
      resolve(code);
    };
    const tee = (d: Buffer | string) => { process.stdout.write(d); if (typeof d === 'string') fs.writeSync(log, d); else fs.writeSync(log, d); };
    const child = spawn(job.cmd, job.args, { cwd: job.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d: Buffer) => {
      if (!job.stream) return tee(d);
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', tee);
    child.on('error', (e) => { tee(`bosun: ${job.cmd}: ${e.message}\n`); finish(127); });
    process.once('SIGTERM', () => child.kill('SIGTERM'));   // bosun run timed out: stop the executor too
    child.on('close', (code) => finish(code === null ? 1 : code));
  });
}

const SPIN_FOOTER = [
  '', '---',
  'You are a bosun spin-off in your own Orca worktree. Implement this with the bosun-build skill, then run bosun-review.',
  'Do not commit or push. Do not spin off or parallelize further.',
  'When done: bosun card in-review "<one-line summary>".',
].join('\n');
const clean = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
const slug = (s: string) => clean(`spin-${s}`);

export function spin(argv: string[]): number {
  const o = { agent: process.env.CODEX_THREAD_ID ? 'codex' : 'claude', name: '', stacked: false, text: [] as string[] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent') o.agent = argv[++i];
    else if (a === '--name') o.name = argv[++i];
    else if (a === '--stacked') o.stacked = true;
    else if (a === '-f') {
      const f = argv[++i];
      if (!f) die('-f needs a file, or - for stdin', 2);
      o.text.push(fs.readFileSync(f === '-' ? 0 : f, 'utf8'));
    } else o.text.push(a);
  }
  const specText = o.text.join(' ').trim();
  if (!specText) die('usage: bosun spin [--agent claude|codex|local] [--name slug] [--stacked] "spec" | -f spec | -f -', 2);
  if (!['claude', 'codex', 'local'].includes(o.agent)) die('--agent must be claude, codex or local', 2);
  if (process.env.BOSUN_DEPTH) die('refusing to spin off from inside a bosun executor');
  if (!inOrca()) die('bosun spin needs Orca: run it from an Orca terminal');
  const name = (o.name && clean(o.name)) || slug(specText.split('\n')[0]);
  const plans = path.join(P.BOSUN, 'plans');
  fs.mkdirSync(plans, { recursive: true });
  const specFile = path.join(plans, `${name}-${Date.now()}.md`);
  fs.writeFileSync(specFile, `${specText}\n`);
  const args = ['worktree', 'create', '--name', name, '--parent-worktree', 'active'];
  if (o.stacked) {
    const b = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (b.code) die('--stacked needs a git branch');
    args.push('--base-branch', b.out);
  }
  if (o.agent !== 'local') args.push('--agent', o.agent, '--prompt', `${specText}\n${SPIN_FOOTER}`);
  const r = orca(args);
  if (r.code !== 0 || !r.json) die(`orca worktree create failed: ${r.err}`);
  const res = r.json.result || {};
  const wt = res.worktree && res.worktree.id;
  if (!wt) die('orca returned no worktree id: check `orca worktree list --json`');
  let handle = res.startupTerminal && res.startupTerminal.handle;
  if (o.agent === 'local') {
    const t = orca(['terminal', 'create', '--worktree', `id:${wt}`, '--title', 'bosun local', '--command', `${q(BIN)} run --no-watch -f ${q(specFile)}`]);
    if (t.code !== 0) die(`orca terminal create failed: ${t.err}`);
    const tr = (t.json && t.json.result) || {};
    handle = (tr.terminal && tr.terminal.handle) || tr.handle;
  }
  console.log(`spun off ${name} (${o.agent})\n  worktree: ${wt}${handle ? `\n  terminal: ${handle}` : ''}\n  spec: ${specFile}`);
  return 0;
}

export function card(argv: string[]): number {
  const [status, ...comment] = argv;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(status || '')) die(`usage: bosun card <${STATUSES.join('|')}|custom-id> ["comment"]`, 2);
  if (!inOrca()) return 0;   // outside Orca there is no card to update
  const args = ['worktree', 'set', '--worktree', 'active', '--workspace-status', status];
  if (comment.length) args.push('--comment', comment.join(' '));
  orca(args);                 // a failed card update is not worth failing the task over
  return 0;
}
