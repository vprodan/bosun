import './bootstrap.ts';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fresh, gitRepo } from './helpers.ts';
import { runtimeFixture } from './runtime-fixture.ts';
import { openDaemonJobs } from '../src/app/jobs.ts';
import { createWatchService } from '../src/app/watches.ts';
import { createOrcaWatch } from '../src/adapters/workspaces/orca-watch.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { project } from '../src/platform/project.ts';
import { createBunJobObserver } from '../src/platform/watch-command.ts';
import type { JobObserver } from '../src/platform/watch-command.ts';
import type { RuntimePaths } from '../src/platform/paths.ts';
import type { Env } from '../src/core/domain/inference.ts';
import type { AgentRunner } from '../src/core/ports/runner.ts';

export const WATCH_TASK =
  'Public task: rename literally "$HOME", `backticks`, $(literal) and it\'s safe.\n';
export const watchCaps: AgentRunner['caps'] = {
  vendor: 'fixture',
  readOnly: 'verified',
  sandbox: 'tool-allowlist',
  mcpInject: 'unsupported',
  effort: 'verified',
  localBackend: 'unsupported',
  billing: 'unknown',
};
export function syntheticObserver(paths: RuntimePaths): JobObserver {
  const executable = path.join(paths.home, 'fixture-bun'),
    entry = path.join(paths.home, 'fixture-observer.js');
  fs.writeFileSync(executable, `#!${process.execPath}\nprocess.exit(77);\n`, { mode: 0o700 });
  fs.writeFileSync(
    entry,
    '// Synthetic observer entry identity; actual CLI wait uses the guarded helper.\n',
    { mode: 0o600 },
  );
  return createBunJobObserver(paths, { executable, entry });
}
export function orcaWatchStub(root: string, env: Env) {
  const control = path.join(env.HOME!, 'orca-watch-control.json'),
    log = path.join(env.HOME!, 'orca-watch-calls.jsonl');
  const command = path.join(env.PATH!.split(path.delimiter)[0], 'orca');
  fs.writeFileSync(
    control,
    JSON.stringify({
      root,
      version: '1.4.222',
      host: 'local',
      mode: 'ok',
      connected: true,
      effect: false,
    }),
  );
  fs.writeFileSync(
    command,
    `#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2),control=${JSON.stringify(control)},log=${JSON.stringify(log)};
let state=JSON.parse(fs.readFileSync(control,'utf8'));
fs.appendFileSync(log,JSON.stringify({args,cwd:process.cwd(),pid:process.pid,env:Object.fromEntries(['ANTHROPIC_AUTH_TOKEN','CODEX_HOME','ORCA_RUNTIME_URL'].map(k=>[k,process.env[k]??null]))})+'\\n');
if(args[0]==='--version'){process.stdout.write(state.version+'\\n');process.exit(0);}
const worktree={id:'repo-test::'+state.root,repoId:'repo-test',path:state.root,hostId:state.host,workspaceStatus:'todo',comment:'CONTENT CANARY'};
let result;
if(args[0]==='worktree')result={worktree};
else if(args[1]==='show'){
 const handle=args[args.indexOf('--terminal')+1];
 result={terminal:{handle,executionHostId:state.host,worktreeId:worktree.id,worktreePath:state.wrongPath??state.root,connected:handle==='term_source'||state.connected,preview:'TOOL OUTPUT CANARY'}};
}else if(['create','split'].includes(args[1])){
 state.effect=true;fs.writeFileSync(control,JSON.stringify(state));
 if(state.mode==='wait'){setTimeout(()=>process.exit(1),30000);return;}
 if(state.mode==='lost')process.exit(1);
 if(state.mode==='malformed'){process.stdout.write('{}');process.exit(0);}
 result=args[1]==='split'?{split:{handle:'term_observer'}}:{terminal:{handle:'term_observer'}};
}else process.exit(2);
process.stdout.write(JSON.stringify({ok:true,result}));
`,
    { mode: 0o700 },
  );
  return {
    control,
    command,
    calls: (): {
      args: string[];
      pid: number;
      cwd: string;
      env: Record<string, string | null>;
    }[] =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((row) => JSON.parse(row))
        : [],
    change(patch: Record<string, unknown>) {
      fs.writeFileSync(
        control,
        JSON.stringify({ ...JSON.parse(fs.readFileSync(control, 'utf8')), ...patch }),
      );
    },
  };
}
export function watchFixture(options: Partial<Parameters<typeof openDaemonJobs>[0]> = {}) {
  const sb = sandbox();
  fresh(sb);
  const root = gitRepo(sb, 'source', 'https://example.invalid/orca-watch.git');
  const env = sb.env(),
    paths = runtimePaths(env);
  fs.mkdirSync(paths.run, { recursive: true, mode: 0o700 });
  let calls = 0;
  const settings = {
    stateFile: paths.state,
    ownerFile: paths.owner,
    runners: {
      codex: (): AgentRunner => ({
        id: 'codex',
        caps: watchCaps,
        detect: async () => ({ installed: true }),
        async *run(spec) {
          calls++;
          if (
            spec.prompt !== WATCH_TASK ||
            spec.model !== 'PINNED' ||
            spec.effort !== 'high' ||
            spec.cwd !== root ||
            spec.access !== 'edit'
          )
            throw Error('spec');
          yield { t: 'tool', name: 'TOOL CANARY', target: 'OUTPUT CANARY' };
          yield { t: 'done', code: 0, result: 'FINAL RESULT' };
        },
      }),
    },
    admit: async () => ({ allowed: true as const }),
    ...options,
  };
  const jobs = openDaemonJobs(settings);
  jobs.recover();
  const native = orcaWatchStub(root, env),
    driver = createOrcaWatch({ env, command: native.command });
  const observer = () => syntheticObserver(paths);
  const watches = createWatchService({ jobs, env, paths, driver, observer });
  const scope = { projectId: project(root).id, audience: 'owner' as const };
  function submit(requestId = 'original') {
    return jobs.submit(
      {
        privacy: 'public',
        requestId,
        taskId: `task_${requestId}`,
        runnerId: 'codex',
        model: 'PINNED',
        effort: 'high',
        cwd: root,
        prompt: WATCH_TASK,
        access: 'edit',
      },
      scope,
    ).job;
  }
  return {
    sb,
    root,
    env,
    paths,
    jobs,
    native,
    driver,
    watches,
    observer,
    scope,
    settings,
    submit,
    calls: () => calls,
    async close() {
      try {
        await watches.close();
        await jobs.close();
      } finally {
        sb.cleanup();
      }
    },
  };
}
export async function watchedRuntime(options: { runner?: AgentRunner } = {}) {
  let native!: ReturnType<typeof orcaWatchStub>;
  const f = await runtimeFixture('[roles.worker.codex]\nmodel="PINNED"\neffort="high"\n', {
    runner: options.runner,
    watchObserver: syntheticObserver,
    env: { ORCA_TERMINAL_HANDLE: 'term_source', BOSUN_SESSION_ID: 'session_fixture' },
    watchDriver: (root, env) => {
      native = orcaWatchStub(root, env);
      return createOrcaWatch({ env, command: native.command });
    },
  });
  return { ...f, native };
}
