import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { Command, CommanderError, type CommandUnknownOpts } from '@commander-js/extra-typings';
import { BosunError } from '../core/errors.ts';
import type { Env } from '../core/domain/inference.ts';
import { HOSTS } from '../core/domain/config.ts';
import type { HostId } from '../core/domain/config.ts';
import { runtimePaths } from '../platform/paths.ts';
import { version, roleDefinitions } from '../platform/assets.ts';
import { loadRuntimeConfig, renderRuntimeConfig } from '../platform/config.ts';
import { readRuntimeManifest } from '../platform/manifest.ts';
import { callLocalRpc } from '../adapters/transport/local-rpc.ts';
import { methodDefinition, methodParams } from '../contracts/methods.ts';
import { rpcError, type RpcRequest, type RpcScope } from '../contracts/rpc.ts';
import { setupRuntime } from './setup.ts';
import {
  planUpgrade,
  saveUpgradePlan,
  applyUpgrade,
  upgradeStatus,
  readUpgradeFile,
} from './upgrade.ts';
import { publishHookConfig } from './config.ts';
import { startDaemon } from './daemon.ts';
import { nativeRunners, nativeQuotaSources } from './native-runners.ts';
import { externalSources, approveClaudeMemReview, claudeMemFile } from './external-sources.ts';
import { privateMemoryTitle } from '../core/use-cases/suggest-memory.ts';
import { routerEvaluationDataset } from '../contracts/router-evaluation.ts';
import { readEvaluationFile } from '../platform/evaluation-file.ts';
import { project } from '../platform/project.ts';
import type { startDaemon as DaemonFactory } from './daemon.ts';
import { acceptedJob } from '../core/domain/job.ts';
import { cardStatus } from '../core/domain/card.ts';
import { runInstallWizard, type InstallWizardOptions } from './install-wizard.ts';
import { diagnoseRuntime } from './doctor.ts';
import { renderCliResult, renderCliError } from './cli-output.ts';
import type { OnboardingPrompts } from './onboarding-wizard.ts';

function textInput(file: string, max = 32768): string {
  const fd = file === '-' ? 0 : fs.openSync(file, 'r');
  const buffer = Buffer.alloc(max + 1);
  let bytes = 0;
  try {
    while (bytes < buffer.length) {
      const n = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!n) break;
      bytes += n;
    }
    if (bytes > max) throw new BosunError('invalid', 'Input file too large');
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytes));
    } catch {
      throw new BosunError('invalid', 'Input must be valid UTF-8');
    }
  } finally {
    if (fd !== 0) fs.closeSync(fd);
  }
}
function json(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0;
    return value;
  } catch {
    throw new BosunError('invalid', 'Invalid JSON arguments');
  }
}
export async function main(
  argv: string[],
  options: {
    env?: Env;
    cwd?: string;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
    runners?: Parameters<typeof DaemonFactory>[0]['runners'];
    admit?: Parameters<typeof DaemonFactory>[0]['admit'];
    quotaSources?: Parameters<typeof DaemonFactory>[0]['quotaSources'];
    serviceControl?: import('../adapters/services/launchd.ts').LaunchdControl;
    installConfirm?: InstallWizardOptions['confirm'];
    onboardingPrompts?: OnboardingPrompts;
    terminal?: boolean;
  } = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const out =
    options.stdout ??
    ((text) => {
      process.stdout.write(text);
    });
  const err =
    options.stderr ??
    ((text) => {
      process.stderr.write(text);
    });
  const paths = () => runtimePaths(env);
  const config = () => loadRuntimeConfig(paths(), env);
  const audience = env.BOSUN_CALLER === 'model' ? 'model' : 'owner';
  const scope: RpcScope = { workspace: cwd, sessionId: env.BOSUN_SESSION_ID || null, audience };
  const terminal = options.terminal ?? (!!process.stdin.isTTY && !!process.stdout.isTTY);
  let jsonOutput = false;
  let commandPath = '';
  let requestId: string | undefined;
  let errorHint: string | undefined;
  const print = (value: unknown, kind = '') => {
    const human = terminal && audience === 'owner' && !jsonOutput && kind ? renderCliResult(kind, value) : null;
    out(human ?? JSON.stringify(value, null, 2) + '\n');
  };
  let exitCode = 0;
  const owner = () => {
    if (audience !== 'owner') throw new BosunError('unsupported', 'Owner operation required');
  };
  async function withInterrupts<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const interrupt = () => controller.abort('SIGINT');
    const terminate = () => controller.abort('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    try { return await run(controller.signal); }
    finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
  }
  async function fetch(method: string, params: Record<string, unknown>) {
    const request: RpcRequest = { version: 1, id: crypto.randomUUID(), method, params, scope };
    requestId = typeof params.requestId === 'string' ? params.requestId : undefined;
    methodParams(request);
    const definition = methodDefinition(method);
    return callLocalRpc({ socket: paths().socket, request, mutation: definition.mutation, timeoutMs: definition.timeoutMs });
  }
  const call = async (method: string, params: Record<string, unknown>) =>
    print(await fetch(method, params), method);
  async function submitWatched(method: string, params: Record<string, unknown>, watch?: boolean) {
    const requested = watch === true || watch !== false && audience === 'owner' && !!env.ORCA_TERMINAL_HANDLE;
    if (requested) owner();
    const value = await fetch(method, params) as { job?: { id: string } | null };
    if (!requested || !value.job) { print(value, method); return; }
    let observation: unknown;
    try {
      observation = await fetch('job.watch', { id: value.job.id, ...(env.ORCA_TERMINAL_HANDLE ? { near: env.ORCA_TERMINAL_HANDLE } : {}) });
    } catch {
      observation = { state: 'unavailable', observation: { wait: ['bosun', 'job', 'wait', value.job.id], get: ['bosun', 'job', 'get', value.job.id], result: ['bosun', 'job', 'result', value.job.id] } };
    }
    print({ ...value, watch: observation }, method);
  }
  function runParameters(
    prompt: string,
    opt: {
      host?: string;
      runner?: string;
      model?: string;
      effort?: string;
      readOnly?: boolean;
      requestId?: string;
      allowUnknownQuota?: boolean;
      operation?: string;
      files?: string;
      delegation?: boolean;
      exactModel?: string;
    },
  ) {
    if (env.BOSUN_DEPTH)
      throw new BosunError('unsupported', 'Nested execution is disabled');
    if (opt.allowUnknownQuota) owner();
    const settings = config();
    if (opt.runner && opt.host) throw new BosunError('invalid', 'Select either --runner or --host');
    const host = opt.host ?? settings.hosts.primary;
    const profile = opt.runner?.startsWith('acp-') ? settings.acp[opt.runner.slice(4)] : undefined;
    if (opt.runner && (!profile?.enabled || !profile.modelOption))
      throw new BosunError('invalid', 'Select a configured ACP runner with a model selector');
    if (!opt.runner && !HOSTS.includes(host as HostId))
      throw new BosunError('invalid', 'Unsupported native host');
    const binding =
      opt.runner ? undefined : settings.roles.executor?.[host as HostId] ??
      settings.roles.worker?.[host as HostId];
    const model = opt.model ?? binding?.model;
    if (!model) {
      errorHint = 'Select the exact native model with --model, or use bosun onboard to configure missing role bindings.';
      throw new BosunError('invalid', 'Select the runner model with --model');
    }
    const effort = opt.effort ?? binding?.effort;
    if (profile && effort && !profile.effortOption) throw new BosunError('unsupported', 'ACP effort selector is not configured');
    const params = {
      privacy: 'public' as const,
      requestId: opt.requestId ?? crypto.randomUUID(),
      taskId: crypto.randomUUID(),
      runnerId: opt.runner ?? host,
      prompt,
      access: opt.readOnly ? ('read' as const) : ('edit' as const),
      model,
      ...(effort ? { effort } : {}),
      ...(opt.allowUnknownQuota ? { allowUnknownQuota: true } : {}),
    };
    const policy =
      opt.operation !== undefined ||
      opt.files !== undefined ||
      opt.delegation === false ||
      opt.exactModel !== undefined
        ? {
            operation: opt.operation ?? (opt.readOnly ? 'inspect' : 'unknown'),
            files: opt.files?.split(',') ?? [],
            ...(opt.delegation === false ? { noDelegation: true } : {}),
            ...(opt.exactModel ? { exactModel: opt.exactModel } : {}),
          }
        : undefined;
    if (policy) Object.assign(params, { policy });
    acceptedJob({ ...params, cwd });
    return params;
  }
  const program = new Command()
    .name('bosun')
    .description('OMP-first agent orchestration and scoped memory; OpenCode, Codex and Claude remain supported.')
    .version(version)
    .option('--json', 'Keep machine-readable output in an owner terminal; piped/model output stays unchanged.')
    .hook('preAction', (_root, action) => {
      const names: string[] = [];
      for (let current: CommandUnknownOpts | null = action; current?.parent; current = current.parent) names.unshift(current.name());
      commandPath = names.join(' ');
      jsonOutput = action.optsWithGlobals().json === true;
      if (jsonOutput && names[0] === 'mcp') throw new BosunError('invalid', 'MCP stdio is already a machine protocol; omit --json');
    })
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({ writeOut: out, writeErr: err });
  program
    .command('status')
    .description('Inspect the existing daemon.')
    .action(() => call('daemon.status', {}));
  const managed = program
    .command('managed')
    .description('Explicit owned native sources through the existing daemon executor.');
  const upgrade = program
    .command('upgrade')
    .description('Reviewed upgrade from the supported legacy home.');
  upgrade
    .command('plan')
    .description('Create an exclusive reviewed legacy upgrade plan; do not apply it yet.')
    .requiredOption('--request-id <id>', 'Stable original upgrade request ID; retain it after uncertainty.')
    .requiredOption('--output <file>', 'New private plan file; existing files are not overwritten.')
    .option('--router-url <url>', 'Exact selected Ollama endpoint; never infer it from a Kev endpoint.')
    .option('--adopt-router-hash <hash>', 'Explicitly review and adopt the exact legacy router plist for retirement.')
    .action((opt) => {
      owner();
      const planned = planUpgrade(paths(), opt.requestId, { env,
        routerUrl: opt.routerUrl, reviewedAdoptionHash: opt.adoptRouterHash });
      saveUpgradePlan(path.resolve(cwd, opt.output), planned);
      print(planned);
    });
  upgrade
    .command('apply <file>')
    .description('Apply the exact reviewed legacy plan after writers settle.', { file: 'Saved upgrade plan to inspect before applying.' })
    .requiredOption('--hash <hash>', 'Exact reviewed plan hash, not an executable hash.')
    .option(
      '--clients-stopped',
      'Attest legacy writers, MCP, hooks and executors are stopped and settled.',
    )
    .action(async (file, opt) => {
      owner();
      if (!opt.clientsStopped)
        throw new BosunError(
          'conflict',
          'Stop legacy clients before applying the reviewed upgrade',
        );
      const saved = json(readUpgradeFile(path.resolve(cwd, file), 524288));
      print(
        await applyUpgrade(paths(), { plan: saved.plan, hash: opt.hash, clientsStopped: true, env, control: options.serviceControl }),
      );
    });
  upgrade.command('status').description('Inspect saved upgrade state without replaying migration.').action(() => {
    owner();
    print(upgradeStatus(paths()));
  });
  managed
    .command('start')
    .description('Start an owned native source with explicitly public instructions; queues native work.')
    .requiredOption(
      '--seed-file <file>',
      'Explicitly public bootstrap instructions; - reads stdin.',
    )
    .requiredOption('--model <model>', 'Pinned native model; never substituted.')
    .requiredOption('--request-id <id>', 'Stable original start request.')
    .option('--host <host>', 'Native host; defaults to primary.')
    .option('--effort <effort>', 'Pinned native reasoning effort.')
    .option('--read-only', 'Use read tool permissions.')
    .option('--public', 'Classify all submitted bootstrap instructions as public.')
    .option('--allow-unknown-quota', 'Explicit owner permission for unknown bootstrap quota only.')
    .action((opt) => {
      owner();
      if (!opt.public)
        throw new BosunError('private_input', 'Public bootstrap classification required');
      return call('managed.start', {
        privacy: 'public',
        requestId: opt.requestId,
        hostId: opt.host ?? config().hosts.primary,
        model: opt.model,
        ...(opt.effort ? { effort: opt.effort } : {}),
        access: opt.readOnly ? 'read' : 'edit',
        seed: textInput(opt.seedFile, 16384),
        ...(opt.allowUnknownQuota ? { allowUnknownQuota: true } : {}),
      });
    });
  managed
    .command('turn <id> <text>')
    .description('Submit a public turn against the current source receipt.', { id: 'Owned source ID from managed get.', text: 'Explicitly public task text.' })
    .requiredOption('--version <number>', 'Current source receipt version.', Number)
    .requiredOption('--request-id <id>', 'Stable turn request.')
    .option('--public', 'Classify submitted task text as public.')
    .option('--allow-unknown-quota', 'Explicit owner permission for unknown quota only.')
    .option('--operation <kind>', 'Policy operation: inspect, mechanical, implementation, planning, auth, payments, delete, migration, production or unknown.')
    .option('--files <paths>', 'Exact comma-separated relative task paths; not globs.')
    .action((id, text, opt) => {
      owner();
      if (!opt.public) throw new BosunError('private_input', 'Public task classification required');
      return call('managed.turn', {
        privacy: 'public',
        id,
        text,
        requestId: opt.requestId,
        expectedVersion: opt.version,
        ...(opt.allowUnknownQuota ? { allowUnknownQuota: true } : {}),
        ...(opt.operation || opt.files
          ? {
              policy: { operation: opt.operation ?? 'unknown', files: opt.files?.split(',') ?? [] },
            }
          : {}),
      });
    });
  managed.command('get <id>').description('Inspect the original source receipt and current version.', { id: 'Owned source ID.' }).action((id) => {
    owner();
    return call('managed.get', { id });
  });
  managed
    .command('authorize <id>')
    .description('Record reviewed public authority facts for a source.', { id: 'Owned source ID.' })
    .requiredOption('--facts <file>', 'Reviewed public task authority facts.')
    .requiredOption('--version <number>', 'Current source receipt version.', Number)
    .requiredOption('--request-id <id>', 'Stable authority request.')
    .option('--public', 'Classify submitted authority facts as public.')
    .action((id, opt) => {
      owner();
      if (!opt.public)
        throw new BosunError('private_input', 'Public authority classification required');
      return call('managed.authorize', {
        privacy: 'public',
        id,
        requestId: opt.requestId,
        expectedVersion: opt.version,
        facts: json(textInput(opt.facts, 24576)),
      });
    });
  managed
    .command('handoff <id>')
    .description('Request a durable native handoff; unknown outcomes must not be replayed.', { id: 'Owned source ID.' })
    .requiredOption('--version <number>', 'Current source receipt version.', Number)
    .requiredOption('--request-id <id>', 'Stable handoff request.')
    .option('--automatic', 'Require qualified active context threshold evidence.')
    .option('--latest-turn <id>', 'Exact latest completed native turn for an automatic request.')
    .option('--allow-unknown-quota', 'Explicit owner permission for unknown bootstrap quota only.')
    .action((id, opt) => {
      owner();
      return call('managed.handoff', {
        privacy: 'public',
        id,
        requestId: opt.requestId,
        expectedVersion: opt.version,
        automatic: !!opt.automatic,
        ...(opt.latestTurn ? { latestTurnId: opt.latestTurn } : {}),
        ...(opt.allowUnknownQuota ? { allowUnknownQuota: true } : {}),
      });
    });
  managed
    .command('capture <id>')
    .description('Capture eligible public source output after an exact cursor.', { id: 'Owned source ID.' })
    .option('--after <cursor>', 'Previously published exact cursor.')
    .action((id, opt) => {
      owner();
      return call('managed.capture', { privacy: 'public', id, afterCursor: opt.after ?? null });
    });
  managed
    .command('retire <id>')
    .description('Retire an owned source using its current receipt version.', { id: 'Owned source ID.' })
    .requiredOption('--version <number>', 'Current source receipt version.', Number)
    .action((id, opt) => {
      owner();
      return call('managed.retire', { id, expectedVersion: opt.version });
    });
  program
    .command('dashboard')
    .description('Inspect scoped jobs, quota, usage and handoff metadata.')
    .option('--once', 'Render one snapshot without interactive input.')
    .action(async (opt) => {
      owner();
      const { runDashboard } = await import('./dashboard.ts');
      await runDashboard({ socket: paths().socket, scope, once: opt.once, write: out });
    });
  program
    .command('route <text>')
    .description('Request public Clef advice, not execution; cold advice may take up to 120 seconds.', { text: 'Public routing task; --private omits it silently without inference.' })
    .option('--private', 'Omit private input without inference.')
    .action((text, opt) =>
      opt.private ? undefined : call('route.classify', { privacy: 'public', text }),
    );
  const router = program
    .command('router')
    .description('Inspect decision readiness and content-free observation feedback.');
  router.command('status').description('Inspect current routing readiness; this does not qualify automatic dispatch.').action(() => {
    owner();
    return call('route.status', {});
  });
  router
    .command('observations')
    .description('List content-free observations for the current scope or explicit legacy scope.')
    .option('--legacy', 'Explicitly inspect historical unscoped metadata; never displays prompts.')
    .option('--limit <count>', 'Maximum observations, up to 100.', Number, 50)
    .action((opt) => {
      owner();
      return call('route.observations', { legacy: !!opt.legacy, limit: opt.limit });
    });
  router
    .command('label <id> <lane>')
    .description('Label an inspected observation with version CAS.', { id: 'Observation ID.', lane: 'scout, local, worker or main.' })
    .option('--legacy', 'Label an explicitly inspected historical observation.')
    .option('--version <number>', 'Current label version, or zero for its first label.', Number, 0)
    .action((id, lane, opt) => {
      owner();
      return call('route.label', {
        id,
        label: lane,
        expectedVersion: opt.version,
        legacy: !!opt.legacy,
      });
    });
  router
    .command('stats')
    .description('Summarize current routing feedback, with legacy metadata kept separate.')
    .option('--legacy', 'Report historical metadata separately from current project records.')
    .action((opt) => {
      owner();
      return call('route.stats', { legacy: !!opt.legacy });
    });
  router
    .command('eval <file>')
    .description(
      'Evaluate 80 public cases: 20 development and 60 held-out, grouped by repository/session.',
      { file: 'Reviewed public evaluation dataset file.' },
    )
    .requiredOption('--public', 'Classify the entire redacted dataset as public.')
    .option(
      '--run',
      'Queue 80 configured-model decisions; default analyzes imported observations offline.',
    )
    .option('--hash <sha256>', 'Required reviewed source hash for live capture.')
    .option('--request-id <id>', 'Required stable request identifier for live capture.')
    .action((file, opt) => {
      owner();
      const relative = path.relative(cwd, path.resolve(cwd, file));
      const source = readEvaluationFile(cwd, relative, opt.hash);
      routerEvaluationDataset(source.input);
      if (opt.run && (!opt.hash || !opt.requestId))
        throw new BosunError('invalid', 'Capture requires reviewed hash and stable request ID');
      return call(opt.run ? 'route.capture' : 'route.evaluate', {
        privacy: 'public',
        file: relative,
        sha256: source.sha256,
        ...(opt.run ? { requestId: opt.requestId } : {}),
      });
    });
  router.command('frozen <job-id>').description('Inspect the frozen evaluation artifact for an original job.', { 'job-id': 'Original evaluation job ID.' }).action((id) => {
    owner();
    return call('route.frozen', { id });
  });
  program
    .command('notifications')
    .description('Inspect opt-in opaque local notifications.')
    .addHelpText('after', '\nExample:\n  bosun notifications status\nRequires an existing daemon; notifications are opt-in and opaque.\n')
    .command('status')
    .description('Inspect notification configuration and delivery metadata without enabling it.')
    .action(() => {
      owner();
      return call('notification.status', {});
    });
  const workspace = program
    .command('workspace')
    .description('Create committed Git worktrees and preview their cleanup.');
  workspace
    .command('create <name>')
    .description('Create an owned worktree from committed Git input.', { name: 'Workspace label; uncommitted files are excluded.' })
    .requiredOption('--request-id <id>', 'Stable creation request identifier.')
    .option('--base <revision>', 'Committed base; dirty files are excluded.')
    .action((name, opt) => {
      owner();
      return call('workspace.create', {
        name,
        requestId: opt.requestId,
        ...(opt.base ? { base: opt.base } : {}),
      });
    });
  workspace.command('list').description('List owned workspace receipts.').action(() => {
    owner();
    return call('workspace.list', {});
  });
  for (const action of ['get', 'reconcile', 'prune-preview'] as const)
    workspace.command(`${action} <id>`).description(
      action === 'get' ? 'Inspect a workspace receipt and version.' : action === 'reconcile' ? 'Observe original workspace effects without replaying creation.' : 'Preview cleanup eligibility without deleting a workspace.',
      { id: 'Owned workspace ID.' },
    ).action((id) => {
      owner();
      return call(action === 'prune-preview' ? 'workspace.prunePreview' : `workspace.${action}`, {
        id,
      });
    });
  workspace
    .command('run <id> <prompt>')
    .description('Queue a public task in an existing version-bound workspace; default access is edit.', { id: 'Owned workspace ID.', prompt: 'Explicitly public task text.' })
    .requiredOption('--version <number>', 'Exact workspace version.', Number)
    .option('-e, --host <host>', 'Native host: omp, opencode, codex or claude; defaults to configured primary.')
    .option('--runner <runner>', 'Configured ACP runner: acp-<name>; mutually exclusive with --host.')
    .option('--model <model>', 'Exact native/ACP model; otherwise use the configured executor or worker binding.')
    .option('--effort <effort>', 'Exact selected runner reasoning effort; no model substitution.')
    .option('--read-only', 'Request read access instead of the default edit access.')
    .option('--request-id <id>', 'Stable original submission ID; retain it and inspect after an unknown outcome.')
    .option('--watch', 'Open an optional Orca metadata observer for the queued job.')
    .option('--no-watch', 'Queue without an Orca pane.')
    .option('--allow-unknown-quota', 'Owner opt-in for unknown quota only; never overrides known exhaustion.')
    .option('--operation <kind>', 'Policy operation: inspect, mechanical, implementation, planning, auth, payments, delete, migration, production or unknown.')
    .option('--files <paths>', 'Exact comma-separated relative task paths; not globs.')
    .option('--no-delegation', 'Declare that policy must not delegate this task.')
    .option('--exact-model <model>', 'Policy constraint requiring this exact model.')
    .action((id, prompt, opt) => {
      owner();
      return submitWatched('workspace.submit', {
        ...runParameters(prompt, opt),
        id,
        expectedVersion: opt.version,
      }, opt.watch);
    });
  program
    .command('spin [prompt]')
    .description('Create one owned committed worktree and queue a public task; default access is edit.', { prompt: 'Public task text; provide exactly one prompt or --file.' })
    .option('-f, --file <path>', 'Explicitly public task file, or - for stdin.')
    .option('--name <name>', 'Workspace label.', 'task')
    .option('--base <revision>', 'Committed Git base; dirty files are excluded.')
    .option('-e, --host <host>', 'Native host: omp, opencode, codex or claude; defaults to configured primary.')
    .option('--runner <runner>', 'Configured ACP runner: acp-<name>; mutually exclusive with --host.')
    .option('--model <model>', 'Exact native/ACP model; otherwise use the configured executor or worker binding.')
    .option('--effort <effort>', 'Exact selected runner reasoning effort.')
    .option('--read-only', 'Request read access instead of the default edit access.')
    .option('--request-id <id>', 'Stable original submission ID; inspect the same request after uncertainty.')
    .option('--watch', 'Open an optional Orca metadata observer for the queued job.')
    .option('--no-watch', 'Queue without an Orca pane.')
    .option('--allow-unknown-quota', 'Owner opt-in for unknown quota only; never overrides known exhaustion.')
    .option('--operation <kind>', 'Policy operation: inspect, mechanical, implementation, planning, auth, payments, delete, migration, production or unknown.')
    .option('--files <paths>', 'Exact comma-separated relative task paths; not globs.')
    .option('--no-delegation', 'Declare that policy must not delegate this task.')
    .option('--exact-model <model>', 'Policy constraint requiring this exact model.')
    .action((prompt, opt) => {
      owner();
      if ((prompt !== undefined) === (opt.file !== undefined))
        throw new BosunError('invalid', 'Provide one public task or task file');
      const task = opt.file !== undefined ? textInput(opt.file) : prompt!;
      return submitWatched('spin.submit', {
        ...runParameters(task, opt),
        name: opt.name,
        ...(opt.base ? { base: opt.base } : {}),
      }, opt.watch);
    });
  const review = program
    .command('review')
    .description('Queue an explicitly public revision-bound read-only native review.')
    .option('--public', 'Classify this checkout as public for review capture.')
    .option('--base <revision>', 'Committed base.', 'main')
    .option(
      '--paths <files>',
      'Comma-separated exact files for this review batch; no glob expansion.',
    )
    .option('-e, --host <host>', 'Reviewer host: omp, opencode, codex or claude; overrides source-host selection.')
    .option('--source-host <host>', 'Originating harness; Claude selects Codex and Codex selects Claude unless --host is set.')
    .option('--model <model>', 'Exact reviewer model; otherwise use cross-reviewer then reviewer binding.')
    .option('--effort <effort>', 'Exact reviewer reasoning effort.')
    .option('--request-id <id>', 'Stable original review request ID; inspect rather than replay unknown work.')
    .option('--watch', 'Open an optional Orca metadata observer for the queued job.')
    .option('--no-watch', 'Queue without an Orca pane.')
    .option('--allow-unknown-quota', 'Owner opt-in for unknown quota only; never overrides known exhaustion.')
    .action((opt) => {
      owner();
      if (!opt.public)
        throw new BosunError('private_input', 'Explicit public checkout classification required');
      const settings = config();
      const sourceHost = opt.sourceHost;
      const host =
        opt.host ??
        (sourceHost === 'claude'
          ? 'codex'
          : sourceHost === 'codex'
            ? 'claude'
            : settings.hosts.primary);
      if (!HOSTS.includes(host as HostId))
        throw new BosunError('invalid', 'Invalid reviewer host');
      const binding =
        settings.roles['cross-reviewer']?.[host as HostId] ??
        settings.roles.reviewer?.[host as HostId];
      const model = opt.model ?? binding?.model;
      if (!model) {
        errorHint = 'Select the exact reviewer model with --model, or use bosun onboard to configure missing role bindings.';
        throw new BosunError('invalid', 'Select the reviewer model with --model');
      }
      const effort = opt.effort ?? binding?.effort;
      return submitWatched('review.submit', {
        privacy: 'public',
        requestId: opt.requestId ?? crypto.randomUUID(),
        runnerId: host,
        model,
        ...(effort ? { effort } : {}),
        base: opt.base,
        ...(opt.paths ? { paths: opt.paths.split(',') } : {}),
        ...(sourceHost ? { sourceHost } : {}),
        ...(opt.allowUnknownQuota ? { allowUnknownQuota: true } : {}),
      }, opt.watch);
    });
  review
    .command('get <id>')
    .description('Inspect current revision validity and original review job.', { id: 'Original review ID.' })
    .action((id) => {
      owner();
      return call('review.get', { id });
    });
  const check = program
    .command('check')
    .description('Run an explicit owner verification command bound to a review revision.');
  check
    .command('run <review-id>')
    .description('Queue a no-shell verification command bound to the reviewed revision.', { 'review-id': 'Inspected review ID whose revision is still current.' })
    .requiredOption('--command <executable>', 'Executable name or path; no shell.')
    .requiredOption('--args <json>', 'JSON argument array, including [] for no arguments.')
    .requiredOption('--request-id <id>', 'Stable original check request ID.')
    .option('--timeout <milliseconds>', 'Native deadline from 1 to 300000 milliseconds.', Number)
    .action((reviewId, opt) => {
      owner();
      let args: unknown;
      try {
        args = JSON.parse(opt.args);
      } catch {
        throw new BosunError('invalid', 'Invalid command arguments');
      }
      return call('check.submit', {
        privacy: 'public',
        requestId: opt.requestId,
        reviewId,
        command: opt.command,
        args,
        ...(opt.timeout !== undefined ? { timeoutMs: opt.timeout } : {}),
      });
    });
  check.command('get <id>').description('Inspect a check receipt, revision validity and underlying job.', { id: 'Original check ID.' }).action((id) => {
    owner();
    return call('check.get', { id });
  });
  const card = program
    .command('card [status] [comment...]')
    .description('Update the enclosing local Orca worktree card with an owner receipt.', { status: 'todo, in-progress, in-review or completed; required for an update despite optional parser syntax.', comment: 'Optional public comment words; requires --public when present.' })
    .option('--public', 'Classify the card comment as public.')
    .option('--request-id <id>', 'Stable update request identifier.')
    .action((status, comment, opt) => {
      owner();
      cardStatus(status);
      if (
        !env.ORCA_TERMINAL_HANDLE &&
        !env.ORCA_WORKTREE_ID &&
        !env.ORCA_WORKSPACE_ID &&
        !env.ORCA_PANE_KEY
      ) {
        print({ state: 'skipped', reason: 'outside_orca' });
        return;
      }
      if (comment.length && !opt.public)
        throw new BosunError('private_input', 'Classify the card comment with --public');
      return call('card.submit', {
        privacy: 'public',
        requestId: opt.requestId ?? crypto.randomUUID(),
        status: status!,
        ...(comment.length ? { comment: comment.join(' ') } : {}),
      });
    });
  card.command('get <id>').description('Inspect an original card-update receipt.', { id: 'Card operation receipt ID.' }).action((id) => {
    owner();
    return call('card.get', { id });
  });
  card
    .command('reconcile <id>')
    .description('Observe the current card without retrying an update.', { id: 'Original card-update receipt ID.' })
    .action((id) => {
      owner();
      return call('card.reconcile', { id });
    });
  card
    .command('acknowledge <id>')
    .description('Acknowledge an inspected unknown card outcome without replaying the update.', { id: 'Original unknown card operation receipt ID.' })
    .requiredOption('--version <number>', 'Exact unknown receipt version.', Number)
    .requiredOption('--observation <hash>', 'Hash returned by card reconcile.')
    .action((id, opt) => {
      owner();
      return call('card.acknowledge', {
        id,
        expectedVersion: opt.version,
        observationHash: opt.observation,
      });
    });
  program
    .command('setup')
    .description('Initialize a new private runtime; install no hosts or models.')
    .action(async () => {
      owner();
      try {
        print(await setupRuntime(paths(), config()));
      } catch {
        out('Setup did not finish; existing data was retained. Run bosun doctor and inspect setup or the supported upgrade before retrying. Runtime ownership and private permissions require review; no automatic repair was attempted.\n');
        try { print(diagnoseRuntime({ paths: paths(), env })); } catch {
          out('Runtime diagnostics are unavailable. Inspect the configured runtime path and its ownership without modifying existing data.\n');
        }
        exitCode = 1;
      }
    });
  program
    .command('onboard')
    .description('Guide native host setup with reviewed approvals; --json or piped use only inspects saved state.')
    .option('--host <host>', 'Selected native host: omp, opencode, codex or claude; defaults to configured primary.')
    .option('--json', 'Render read-only onboarding inspection as JSON.')
    .option('--binary <file>', 'Absolute compiled Bosun release executable when onboarding from source.')
    .action(async (opt) => {
      owner();
      if (jsonOutput || !terminal && !options.onboardingPrompts) {
        const { inspectOnboarding, renderOnboarding } = await import('./onboarding.ts');
        const value = inspectOnboarding({ paths: paths(), env }, opt.host);
        if (jsonOutput) print(value); else out(renderOnboarding(value));
        return;
      }
      if (opt.host && !HOSTS.includes(opt.host as HostId)) throw new BosunError('invalid', 'Invalid host');
      return withInterrupts(async signal => {
      const ui = options.onboardingPrompts ? undefined : await import('@clack/prompts');
      ui?.intro('Set up Bosun for your native host');
      const prompts: OnboardingPrompts = options.onboardingPrompts ?? {
        async confirm(question) {
          const answer = await ui!.confirm({ message: question.message, initialValue: question.initialValue, signal });
          if (ui!.isCancel(answer)) throw new BosunError('cancelled', 'Onboarding cancelled');
          return answer === true;
        },
        async selectHost(initialValue) {
          const answer = await ui!.select({ message: 'Which native host should Bosun prepare?', initialValue, signal,
            options: HOSTS.map(value => ({ value, label: value === 'omp' ? 'OMP' : value === 'opencode' ? 'OpenCode 2' : value === 'codex' ? 'Codex' : 'Claude Code' })),
          });
          return ui!.isCancel(answer) ? null : answer;
        },
        async text(message, initialValue) {
          const answer = await ui!.text({ message, initialValue, signal });
          return ui!.isCancel(answer) ? null : answer;
        },
      };
      const write = (text: string) => { if (ui) ui.log.info(text.trimEnd()); else out(text); };
      const { runOnboardingWizard } = await import('./onboarding-wizard.ts');
      const result = await runOnboardingWizard({ paths: paths(), env, cwd, signal,
        binary: opt.binary ?? (import.meta.url.includes('/$bunfs/') ? process.execPath : undefined),
        host: opt.host as HostId | undefined, prompts, write, control: options.serviceControl,
        optionalTools: async () => {
          const { runOptionalTools } = await import('./install-tools.ts');
          await runOptionalTools({ env, cwd, write, signal, confirm: question => prompts.confirm({ ...question, kind: 'tools' }) });
        },
      });
      if (ui) ui.outro(result.message); else out(result.message + '\n');
      if (result.state === 'held') exitCode = 1;
      else if (signal.aborted) exitCode = signal.reason === 'SIGINT' ? 130 : 143;
      else if (result.launch) await launchPrepared(result.launch.id, result.launch.version, result.launch.hash, signal);
      });
    });
  const launchPrepared = async (id: string, receiptVersion: number, hash: string, signal?: AbortSignal) => {
    const launch = async (active: AbortSignal) => {
      const { launchHost } = await import('./host-launch.ts');
      const result = await launchHost({ paths: paths(), config: config(), binary: process.execPath, env, cwd }, id, receiptVersion, hash, active);
      exitCode = active.aborted ? active.reason === 'SIGINT' ? 130 : 143
        : result.code ?? (result.signal === 'SIGINT' ? 130 : result.signal === 'SIGTERM' ? 143 : 1);
    };
    if (signal) await launch(signal); else await withInterrupts(launch);
  };
  const guidedService = async (operation: 'enable' | 'disable' | 'restart') => {
    owner();
    if ((!terminal || jsonOutput) && !options.installConfirm) {
      errorHint = 'Guided service changes require an owner terminal. Use bosun install status and the explicit-ID options shown by --help for automation.';
      throw new BosunError('unsupported', 'Owner terminal required');
    }
    return withInterrupts(async signal => {
    const ui = options.installConfirm ? undefined : await import('@clack/prompts');
    ui?.intro(operation === 'enable' ? 'Start Bosun' : operation === 'disable' ? 'Stop Bosun' : 'Restart Bosun');
    const { runServiceWizard } = await import('./service-wizard.ts');
    const result = await runServiceWizard({ paths: paths(), env, control: options.serviceControl, signal,
      confirm: options.installConfirm ?? (async question => {
        const answer = await ui!.confirm({ message: question.message, initialValue: question.initialValue, signal });
        if (ui!.isCancel(answer)) throw new BosunError('cancelled', 'Service review cancelled');
        return answer === true;
      }),
      write(text) { if (ui) ui.log.info(text.trimEnd()); else out(text); },
    }, operation);
    if (ui) ui.outro(result.message); else out(result.message + '\n');
    if (result.state === 'held') exitCode = 1;
    else if (signal.aborted) exitCode = signal.reason === 'SIGINT' ? 130 : 143;
    });
  };
  const lifecycle = async (action: 'install' | 'update' | 'uninstall', opt: { binary?: string } = {}) => {
    owner();
    if (!options.installConfirm && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      out(`Interactive ${action} requires an owner terminal. Advanced install plan/apply/undo remains available.\n`);
      exitCode = 1; return;
    }
    const prompts = options.installConfirm ? undefined : await import('@clack/prompts');
    prompts?.intro(`${action === 'update' ? 'Update' : action === 'uninstall' ? 'Uninstall' : 'Install / reinstall'} Bosun`);
    const confirm: InstallWizardOptions['confirm'] = options.installConfirm ?? (async question => {
      const answer = await prompts!.confirm({ message: question.message, initialValue: question.initialValue });
      return !prompts!.isCancel(answer) && answer === true;
    });
    const write = (text: string) => { if (prompts) prompts.log.info(text.trimEnd()); else out(text); };
    const base = { paths: paths(), env, confirm, write, control: options.serviceControl };
    if (action === 'uninstall') {
      const { retireInstallation } = await import('./installation-lifecycle.ts');
      const removed = await retireInstallation(base, 'uninstall');
      prompts?.outro(removed ? 'Owned Bosun installation removed; data, configuration, tools and models retained.' : 'Uninstall declined; no further changes.');
      return;
    }
    let binary = opt.binary ?? (import.meta.url.includes('/$bunfs/') ? process.execPath : undefined);
    if (action === 'update') {
      const { downloadLatestRelease } = await import('./release-download.ts');
      const { privateDirectory } = await import('../platform/private-file.ts');
      privateDirectory(base.paths.artifacts);
      const release = await downloadLatestRelease({ env, directory: base.paths.artifacts, currentVersion: version,
        confirm: question => confirm({ ...question, kind: 'install' }), write });
      if (release.binary === null) {
        const message = release.state === 'current' ? `Already on ${version}. Use bosun install to reinstall.`
          : `Latest stable ${release.version} is older than this executable (${version}); downgrade refused.`;
        if (prompts) prompts.outro(message); else out(message + '\n');
        return;
      }
      prompts?.outro(`Verified ${release.version}; opening its installer.`);
      const { foregroundProcess } = await import('../platform/foreground-process.ts');
      const { installationProcessEnv } = await import('./installation.ts');
      const result = await foregroundProcess({ command: release.binary, args: ['install', '--binary', release.binary], cwd,
        env: installationProcessEnv(env), signal: new AbortController().signal });
      exitCode = result.code === 0 && result.signal === null ? 0 : 1; return;
    }
    if (!binary) { write('Source execution requires install --binary /absolute/release/bosun. No changes were made.\n'); exitCode = 1; return; }
    const result = await runInstallWizard({ ...base, binary, afterInstall: async () => {
      const { runOptionalTools } = await import('./install-tools.ts');
      await runOptionalTools({ env, cwd, write, confirm: question => confirm({ ...question, kind: 'tools' }) });
    } });
    if (prompts) prompts.outro(result.message); else out(result.message + '\n');
    if (result.state === 'held') exitCode = 1;
  };
  const guidedLifecycle = async (action: 'install' | 'update' | 'uninstall', opt: { binary?: string } = {}) => {
    try { await lifecycle(action, opt); }
    catch (error) {
      out((error instanceof BosunError ? error.message : 'Lifecycle outcome could not be verified. Retain receipts and inspect bosun install status; do not replay an uncertain operation.') + '\n');
      exitCode = 1;
    }
  };
  const install = program.command('install')
    .description('Step-by-step install or reinstall, preserving memory and configuration.')
    .option('--binary <file>', 'Absolute downloaded release executable (required from source).')
    .action(opt => guidedLifecycle('install', opt));
  program.command('update').description('Verify and install the latest stable GitHub release.').action(() => guidedLifecycle('update'));
  type InstallationOptions = { version: number; hash: string; clientsStopped?: boolean };
  type ServiceOptions = InstallationOptions & { requestId: string };
  const undoOwnedInstallation = async (id: string, opt: InstallationOptions) => {
    owner();
    const { undoInstallation } = await import('./installation.ts');
    print(
      undoInstallation({ paths: paths(), env }, id, opt.version, opt.hash, !!opt.clientsStopped),
    );
  };
  const operateOwnedService = async (
    operation: 'enable' | 'disable',
    id: string,
    opt: ServiceOptions,
  ) => {
    owner();
    const { controlInstallationService } = await import('./installation-service.ts');
    return controlInstallationService(
      { paths: paths(), env, control: options.serviceControl },
      {
        id,
        expectedVersion: opt.version,
        hash: opt.hash,
        requestId: opt.requestId,
        operation,
        clientsStopped: !!opt.clientsStopped,
      },
    );
  };
  install
    .command('plan')
    .description('Create an exclusive executable installation plan without applying it.')
    .requiredOption('--binary <file>', 'Selected release executable to inspect and bind into the plan.')
    .requiredOption('--request-id <id>', 'Stable original installation request ID.')
    .requiredOption('--output <file>', 'New private plan file; no overwrite.')
    .option('--homebrew', 'Reference the stable Homebrew opt binary without taking ownership.')
    .option(
      '--replace-existing',
      'Review and retain an existing user binary or link before replacement.',
    )
    .action(async (opt) => {
      owner();
      const { planInstallation, saveInstallationPlan } = await import('./installation.ts');
      const plan = planInstallation(
        { paths: paths(), env },
        {
          requestId: opt.requestId,
          binary: path.resolve(cwd, opt.binary),
          distribution: opt.homebrew ? 'homebrew' : 'managed',
          replaceExisting: opt.replaceExisting,
        },
      );
      saveInstallationPlan(path.resolve(cwd, opt.output), plan);
      print(plan);
    });
  install
    .command('apply <file>')
    .description('Apply an inspected, unexpired installation plan after client settlement.', { file: 'Saved installation plan file.' })
    .requiredOption('--hash <hash>', 'Exact reviewed plan hash, not the binary SHA256.')
    .option(
      '--clients-stopped',
      'Attest hooks, native clients and executors are stopped and settled.',
    )
    .action(async (file, opt) => {
      owner();
      const { applyInstallation, readInstallationPlan } = await import('./installation.ts');
      print(
        await applyInstallation(
          { paths: paths(), env },
          readInstallationPlan(path.resolve(cwd, file)),
          opt.hash,
          !!opt.clientsStopped,
        ),
      );
    });
  install.command('status').description('Inspect saved installation receipts and file matches; not native readiness.').action(async () => {
    owner();
    const { installationStatus } = await import('./installation.ts');
    print(installationStatus({ paths: paths(), env }));
  });
  install
    .command('undo <id>')
    .description('Undo the reviewed owned installation while retaining data and configuration.', { id: 'Owned installation receipt ID.' })
    .requiredOption('--version <number>', 'Reviewed receipt version.', Number)
    .requiredOption('--hash <hash>', 'Exact installation plan hash from the inspected receipt.')
    .option('--clients-stopped', 'Attest hooks, native clients and executors are stopped and settled; does not stop them.')
    .action(undoOwnedInstallation);
  for (const operation of ['enable', 'disable'] as const)
    install
      .command(`${operation} <id>`)
      .description(`${operation === 'enable' ? 'Enable' : 'Disable'} the receipt-owned daemon service using a durable original operation.`, { id: 'Owned installation receipt ID.' })
      .requiredOption('--version <number>', 'Reviewed receipt version.', Number)
      .requiredOption('--hash <hash>', 'Exact installation plan hash from the inspected receipt.')
      .requiredOption('--request-id <id>', 'Stable original service request ID; never use a new ID to replay an unknown outcome.')
      .option('--clients-stopped', 'Attest hooks, native clients and executors are stopped and settled; does not stop them.')
      .action(async (id, opt) => print(await operateOwnedService(operation, id, opt)));
  program
    .command('uninstall [id]')
    .description('Guided owned uninstall retaining data; an ID selects advanced reviewed undo.', { id: 'Optional owned installation ID; omit for the owner-terminal workflow.' })
    .option('--version <number>', 'Reviewed receipt version.', Number)
    .option('--hash <hash>', 'Exact inspected installation plan hash; required with an ID.')
    .option('--clients-stopped', 'Attest hooks, native clients and executors are stopped and settled; does not stop them.')
    .action(async (id, opt) => {
      if (!id) return guidedLifecycle('uninstall');
      if (!Number.isSafeInteger(opt.version) || typeof opt.hash !== 'string') throw new BosunError('invalid', 'Reviewed receipt version and hash required');
      return undoOwnedInstallation(id, { version: opt.version!, hash: opt.hash, clientsStopped: opt.clientsStopped });
    });
  const serviceSelection = (opt: { version?: number; hash?: string; requestId?: string; clientsStopped?: boolean }): ServiceOptions => {
    if (!Number.isSafeInteger(opt.version) || typeof opt.hash !== 'string' || !opt.requestId) {
      errorHint = 'For automation, supply an inspected ID, --version, --hash, --request-id and --clients-stopped. In an owner terminal, omit the ID for the guided flow.';
      throw new BosunError('invalid', 'Reviewed service selection required');
    }
    return { version: opt.version!, hash: opt.hash, requestId: opt.requestId, clientsStopped: opt.clientsStopped };
  };
  for (const [name, operation] of [
    ['start', 'enable'],
    ['stop', 'disable'],
  ] as const)
    program
      .command(`${name} [id]`)
      .description(`${name === 'start' ? 'Start' : 'Stop'} the owned background service with guided approval; an ID selects advanced receipt control.`, { id: 'Optional owned installation receipt ID for noninteractive version/hash CAS.' })
      .option('--version <number>', 'Reviewed receipt version for explicit-ID automation.', Number)
      .option('--hash <hash>', 'Exact inspected installation plan hash for explicit-ID automation.')
      .option('--request-id <id>', 'Stable original explicit-ID service request; retain it after uncertainty.')
      .option('--clients-stopped', 'Attest hooks, native clients and executors are stopped and settled; does not stop them.')
      .action(async (id, opt) => {
        if (!id) {
          if (opt.version !== undefined || opt.hash !== undefined || opt.requestId !== undefined || opt.clientsStopped)
            throw new BosunError('invalid', 'Explicit service flags require an installation ID');
          return guidedService(operation);
        }
        print(await operateOwnedService(operation, id, serviceSelection(opt)));
      });
  program
    .command('restart [id]')
    .description('Guide separately approved stop/start; an ID selects advanced durable original operations.', { id: 'Optional owned installation receipt ID for noninteractive version/hash CAS.' })
    .option('--version <number>', 'Reviewed receipt version for explicit-ID automation.', Number)
    .option('--hash <hash>', 'Exact inspected installation plan hash for explicit-ID automation.')
    .option('--request-id <id>', 'Stable original explicit-ID restart request; binds both phases.')
    .option('--clients-stopped', 'Attest hooks, native clients and executors are stopped and settled; does not stop them.')
    .action(async (id, opt) => {
      owner();
      if (!id) {
        if (opt.version !== undefined || opt.hash !== undefined || opt.requestId !== undefined || opt.clientsStopped)
          throw new BosunError('invalid', 'Explicit service flags require an installation ID');
        return guidedService('restart');
      }
      const selected = serviceSelection(opt);
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(selected.requestId))
        throw new BosunError('invalid', 'Stable service operation required');
      const requestId = (phase: string) =>
        `restart_${crypto
          .createHash('sha256')
          .update(JSON.stringify([selected.requestId, phase]))
          .digest('hex')}`;
      const stopped = await operateOwnedService('disable', id, {
        ...selected,
        requestId: requestId('disable'),
      });
      const started = await operateOwnedService('enable', id, {
        ...selected,
        version: stopped.record.version,
        requestId: requestId('enable'),
      });
      print({
        record: started.record,
        operations: [stopped.operation, started.operation],
        duplicate: stopped.duplicate && started.duplicate,
      });
    });
  install
    .command('reconcile <id>')
    .description('Observe and reconcile an original uncertain service effect; never retry it.', { id: 'Original owned installation receipt ID.' })
    .requiredOption('--version <number>', 'Current uncertain receipt version.', Number)
    .requiredOption('--hash <hash>', 'Exact original installation plan hash.')
    .action(async (id, opt) => {
      owner();
      const { reconcileInstallationService } = await import('./installation-service.ts');
      print(
        await reconcileInstallationService(
          { paths: paths(), env, control: options.serviceControl },
          id,
          opt.version,
          opt.hash,
        ),
      );
    });
  program
    .command('doctor')
    .description('Inspect local preparation without opening databases or probing native services.')
    .action(async () => {
      owner();
      const { diagnoseRuntime } = await import('./doctor.ts');
      const diagnosis = diagnoseRuntime({ paths: paths(), env });
      print(diagnosis, 'doctor');
      if (!diagnosis.prepared)
        throw new BosunError('unavailable', 'Runtime preparation requires review');
    });
  const host = program
    .command('host')
    .description('Plan, manage and explicitly launch owned native host profiles.');
  const hostBinary = (selected?: string) =>
    selected ??
    (process.versions.bun
      ? process.execPath
      : path.resolve(import.meta.dirname, '../../bin/bosun'));
  host
    .command('plan <host>')
    .description('Plan a version-bound owned native profile without applying it.', { host: 'omp, opencode, codex or claude.' })
    .requiredOption('--native-version <version>', 'Exact supported version of the selected native host, not the Bosun receipt version.')
    .requiredOption('--request-id <id>', 'Stable installation request.')
    .option('--binary <path>', 'Absolute bosun executable used by MCP.')
    .option('--workspace <path>', 'Codex repository skill workspace; defaults to cwd.')
    .option('--output <path>', 'Export the reviewed plan without overwrite.')
    .action(async (name, opt) => {
      owner();
      const { planHostInstallation } = await import('./host-install.ts');
      if (!HOSTS.includes(name as HostId))
        throw new BosunError('invalid', 'Invalid host');
      const plan = await planHostInstallation(
        {
          paths: paths(),
          config: config(),
          binary: hostBinary(opt.binary),
          workspace: opt.workspace ?? cwd,
        },
        {
          hostId: name as HostId,
          nativeVersion: opt.nativeVersion,
          requestId: opt.requestId,
        },
      );
      if (opt.output) {
        fs.writeFileSync(opt.output, JSON.stringify(plan, null, 2) + '\n', {
          flag: 'wx',
          mode: 0o600,
        });
        print({ output: opt.output, planHash: plan.planHash, id: plan.id });
      } else print(plan);
    });
  host
    .command('apply <file>')
    .description('Apply the exact reviewed native profile plan; no native UI launch.', { file: 'Saved native host plan JSON; - reads stdin.' })
    .requiredOption('--hash <hash>', 'Exact reviewed plan hash.')
    .action(async (file, opt) => {
      owner();
      const { applyHostInstallation } = await import('./host-install.ts');
      const plan = json(textInput(file, 1048576));
      print(
        await applyHostInstallation(
          {
            paths: paths(),
            config: config(),
            binary: typeof plan.binary === 'string' ? plan.binary : hostBinary(),
          },
          plan,
          opt.hash,
        ),
      );
    });
  host.command('status [id]').description('Inspect saved profile receipts and drift; not a live readiness assertion.', { id: 'Optional exact profile receipt ID; omit to inspect all owned profiles.' }).action(async (id) => {
    owner();
    const { hostInstallationStatus } = await import('./host-install.ts');
    print(hostInstallationStatus({ paths: paths(), config: config(), binary: hostBinary() }, id));
  });
  host
    .command('launch [id]')
    .description('Review and launch the configured host profile; an ID selects advanced receipt control.', { id: 'Optional owned profile ID; omit for the configured primary or --host selection.' })
    .option('--host <host>', 'Select an already prepared native host when omitting the profile ID.')
    .option('--version <number>', 'Exact profile receipt version for explicit-ID automation.', Number)
    .option('--hash <hash>', 'Exact profile plan hash for explicit-ID automation.')
    .option('--preview', 'Inspect literal launch metadata without native calls.')
    .action(async (id, opt) => {
      if (id && (opt.host || !Number.isSafeInteger(opt.version) || typeof opt.hash !== 'string')) {
        errorHint = 'With a profile ID, supply its inspected --version and --hash; --host selects the no-ID guided flow.';
        throw new BosunError('invalid', 'Reviewed profile selection required');
      }
      owner();
      const selected = { paths: paths(), config: config(), binary: hostBinary(), env, cwd };
      let profileId = id, receiptVersion = opt.version, hash = opt.hash;
      if (!id) {
        if (receiptVersion !== undefined || hash !== undefined) throw new BosunError('invalid', 'Explicit receipt fields require a profile ID');
        if ((!terminal || jsonOutput) && !opt.preview && !options.installConfirm) {
          errorHint = 'Use bosun host launch --preview for read-only inspection, or supply the exact ID, --version and --hash for automation.';
          throw new BosunError('unsupported', 'Owner terminal required');
        }
        const hostId = opt.host ?? selected.config.hosts.primary;
        if (!HOSTS.includes(hostId as HostId)) throw new BosunError('invalid', 'Invalid host');
        const profiles = readRuntimeManifest(selected.paths).hostProfiles?.filter(profile => profile.hostId === hostId && profile.state !== 'undone') ?? [];
        if (profiles.length !== 1) {
          errorHint = 'Run bosun onboard to prepare or review one owned profile for the selected host.';
          throw new BosunError('unverified', 'One owned profile required');
        }
        profileId = profiles[0].id; receiptVersion = profiles[0].version; hash = profiles[0].planHash;
      }
      const { hostLaunchPlan } = await import('./host-install.ts');
      const plan = await hostLaunchPlan(selected, profileId!, receiptVersion!, hash!);
      if (opt.preview) { print(plan); return; }
      if (!id) {
        print(plan);
        const ui = options.installConfirm ? undefined : await import('@clack/prompts');
        const question = { kind: 'start' as const, message: 'Launch this exact reviewed native profile in the foreground? Native authentication stays with the selected host.', initialValue: false };
        const approved = options.installConfirm ? await options.installConfirm(question)
          : await ui!.confirm({ message: question.message, initialValue: false });
        if (approved !== true) { out('Native launch declined; profile and service were retained.\n'); return; }
      }
      await launchPrepared(profileId!, receiptVersion!, hash!);
    });
  host
    .command('undo <id>')
    .description('Undo an owned native profile with receipt-version CAS.', { id: 'Inspected native profile receipt ID.' })
    .requiredOption('--version <number>', 'Exact installation receipt version.', Number)
    .action(async (id, opt) => {
      owner();
      const { undoHostInstallation } = await import('./host-install.ts');
      print(
        undoHostInstallation(
          { paths: paths(), config: config(), binary: hostBinary() },
          id,
          opt.version,
        ),
      );
    });
  const cfg = program.command('config').description('Inspect effective TOML settings or explicitly publish a validated hook snapshot.');
  cfg.command('show').description('Emit resolved effective TOML, including environment overlays; not a saved-file rewrite.').action(() => {
    owner();
    out(renderRuntimeConfig(config()));
  });
  cfg.command('validate').description('Validate effective settings and publish the hook snapshot; follow stopped-owner configuration workflow.').action(() => {
    owner();
    const manifest = readRuntimeManifest(paths());
    print(publishHookConfig(config(), paths(), { sourceId: manifest.sourceId, now: Date.now() }));
  });
  program
    .command('roles')
    .description('List shipped roles and configured model bindings.')
    .option('--json', 'Print resolved bindings as machine-readable JSON, also the default when piped.')
    .action(() => {
      const settings = config();
      print(
        roleDefinitions().map((role) => ({
          id: role.id,
          description: role.description,
          access: role.access,
          bindings: settings.roles[role.id] ?? {},
        })), 'roles',
      );
    });
  program.addHelpText(
    'after',
    '\nGetting started:\n  bosun install\n  bosun onboard --host omp\n  bosun doctor\n\nDaily use (requires an explicitly started daemon):\n  bosun status\n  bosun memory search Runtime\n  bosun context "Which runtime?" --sources lexical\n  bosun job list\n\nForeground alternative:\n  bosun daemon run\n  In another terminal: bosun status\n\nUse bosun <group> --help and bosun <group> <command> --help before advanced effects.\nRun/review/managed text is public and may invoke configured models; basic lexical reads do not.\nAdvanced mutations retain reviewed plan hashes, receipt-version CAS and stable request IDs.\nUnknown outcomes require original receipt inspection, never automatic repair or fresh-ID replay.\nHelp is read-only, including install --help, review --help and card --help.\n',
  );
  const daemon = program.command('daemon').description('Run the single local authority.');
  daemon.command('run').description('Run the prepared daemon in the foreground until its owner stops this terminal.').action(async () => {
    owner();
    const settings = config();
    const runtime = await startDaemon({
      paths: paths(),
      config: settings,
      runners: options.runners ?? nativeRunners(settings, env),
      admit: options.admit,
      quotaSources: options.quotaSources ?? nativeQuotaSources(settings, env, cwd),
      externalSources: externalSources(settings, paths(), env),
      environment: env,
    });
    out('bosun daemon ready\n');
    await new Promise<void>((resolve, reject) => {
      let closing = false;
      const stop = () => {
        if (closing) return;
        closing = true;
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        void runtime.close().then(resolve, reject);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  });
  const memory = program
    .command('memory')
    .description('Read and curate scoped memory through the daemon.');
  memory
    .command('eval <file>')
    .description('Evaluate an approved public memory export; vectors explicitly permit embedding inference.', { file: 'Reviewed public evaluation JSON file.' })
    .requiredOption('--public', 'Evaluate an explicitly approved public JSON export.')
    .option('--surface <name>', 'hook-packing or mcp.', 'hook-packing')
    .option('--vectors', 'Explicitly permit the pinned public embedding model for MCP evaluation.')
    .option('--budget <tokens>', 'MCP packing budget; hook-packing uses a fixed 400-token budget.', Number)
    .action(async (file, opt) => {
      owner();
      const surface = opt.surface;
      if (surface !== 'hook-packing' && surface !== 'mcp')
        throw new BosunError('invalid', 'Invalid evaluation surface');
      const [{ readEvaluationFile }, { runMemoryEvaluation }] = await Promise.all([
        import('../platform/evaluation-file.ts'),
        import('./memory-evaluation.ts'),
      ]);
      const source = readEvaluationFile(cwd, file);
      const report = await runMemoryEvaluation({
        input: source.input,
        env,
        valid: source.valid,
        surface,
        budgetTokens: opt.budget,
        ...(opt.vectors
          ? { embedding: { privacy: 'public', settings: config().graph.embedding } }
          : {}),
      });
      if (!source.valid()) throw new BosunError('conflict', 'Memory evaluation source changed');
      out(`${JSON.stringify({ ...report, sha256: source.sha256 }, null, 2)}\n`);
    });
  memory
    .command('bench')
    .description('Run an isolated synthetic memory benchmark; does not qualify live model quality.')
    .option('--n <count>', 'Synthetic notes,1–10000.', Number, 1000)
    .option(
      '--public-view',
      'Publish only the isolated synthetic view for hook delivery measurements.',
    )
    .action(async (opt) => {
      owner();
      const { runMemoryBenchmark } = await import('./memory-benchmark.ts');
      const result = await runMemoryBenchmark({
        n: opt.n,
        publicView: !!opt.publicView,
        workspace: cwd,
        env,
      }, { onFailure(diagnostic) { err(JSON.stringify({ benchmarkFailure: diagnostic }) + '\n'); } });
      out(`${JSON.stringify(result, null, 2)}\n`);
    });
  const remoteView = program
    .command('remote-view')
    .description('Explicitly cache public remote notes; release before source changes.');
  remoteView
    .command('refresh')
    .description('Acquire a bounded public remote-note view through the daemon; release before changing its source.')
    .requiredOption('--public', 'Explicitly classify the selected remote notes as public.')
    .option('--ttl-ms <count>', 'Local public-view lifetime in milliseconds.', Number, 300000)
    .action((opt) => call('remote.view.refresh', { privacy: 'public', ttlMs: opt.ttlMs }));
  remoteView.command('status').description('Inspect the public remote-view lease and original receipt.').action(() => call('remote.view.status', {}));
  remoteView.command('invalidate').description('Release and invalidate the owned cached view before source changes.').action(() => call('remote.view.invalidate', {}));
  remoteView.command('reconcile').description('Observe the original remote-view outcome without replaying acquisition.').action(() => call('remote.view.reconcile', {}));
  memory
    .command('add')
    .description('Store a scoped note; only optional public auto suggestions invoke inference.')
    .requiredOption('--category <category>', 'Scope category: personal, project or session.')
    .option('--title <title>', 'Note title; required unless --auto supplies it.')
    .option('--tags <tags>', 'Comma-separated tags; explicit values take precedence.')
    .option('--auto', 'Derive a private title locally, or queue public title/tag suggestions.')
    .option('--provider <name>', 'Configured generative provider for public suggestions.')
    .option(
      '--allow-remote-api',
      'Explicitly permit the configured API provider for this public note.',
    )
    .option('--request-id <id>', 'Stable identifier for a public suggestion job.')
    .option('--body <text>', 'Note body; provide exactly one of --body or --body-file.')
    .option('--body-file <file>', 'UTF-8 note body, at most 16000 bytes; - reads stdin.')
    .option('--private', 'Keep the note private; private auto titles are derived locally.')
    .option('--unshared', 'Do not share the note across projects; independent of private/public classification.')
    .option('--proposed', 'Store as a proposal requiring explicit acceptance.')
    .action((opt) => {
      if (opt.auto && !opt.private) owner();
      const body = opt.bodyFile ? textInput(opt.bodyFile, 16000) : opt.body;
      if (!body || (opt.bodyFile && opt.body))
        throw new BosunError('invalid', 'Provide one memory body or body file');
      const tags =
        opt.tags === undefined
          ? undefined
          : opt.tags
              .split(',')
              .map((tag: string) => tag.trim())
              .filter(Boolean);
      const common = {
        category: opt.category,
        body,
        ...(tags === undefined ? {} : { tags }),
        ...(opt.unshared ? { shared: false } : {}),
        ...(opt.proposed ? { status: 'proposed' } : {}),
      };
      if (opt.auto && !opt.private && (opt.title === undefined || tags === undefined))
        return call('memory.autoStore', {
          ...common,
          privacy: 'public',
          requestId: opt.requestId ?? crypto.randomUUID(),
          ...(opt.title === undefined ? {} : { title: opt.title }),
          ...(opt.provider ? { providerId: opt.provider } : {}),
          allowRemoteApi: !!opt.allowRemoteApi,
        });
      const title = opt.title ?? (opt.auto && opt.private ? privateMemoryTitle(body) : undefined);
      if (!title) throw new BosunError('invalid', 'Provide a memory title or use --auto');
      return call('memory.store', {
        ...common,
        title,
        source: 'cli',
        ...(opt.private ? { private: true } : {}),
      });
    });
  memory
    .command('search <query>')
    .description('Search eligible scoped memory lexically without inference.', { query: 'Lexical search text.' })
    .option('--category <category>', 'Filter to personal, project or session notes.')
    .option('--private', 'Include permitted private notes in addition to public notes.')
    .option('--limit <count>', 'Maximum returned notes, from 1 to 50.', Number)
    .action((query, opt) =>
      call('memory.search', {
        text: query,
        ...(opt.category ? { category: opt.category } : {}),
        ...(opt.private ? { includePrivate: true } : {}),
        ...(opt.limit !== undefined ? { limit: opt.limit } : {}),
      }),
    );
  memory
    .command('get <id>')
    .description('Read a permitted note and its current version.', { id: 'Note ID from memory search.' })
    .option('--events', 'Include the permitted note audit events.')
    .action((id, opt) => call('memory.get', { id, ...(opt.events ? { events: true } : {}) }));
  memory
    .command('update <id>')
    .description('Apply a reviewed JSON patch with current-version CAS; inspect stale notes before a new review.', { id: 'Note ID from memory get.' })
    .requiredOption('--version <number>', 'Exact current note version from memory get.', Number)
    .requiredOption('--patch <json>', 'Reviewed JSON object of supported note changes, for example {"title":"Reviewed title"}.')
    .action((id, opt) =>
      call('memory.update', { id, expectedVersion: opt.version, patch: json(opt.patch) }),
    );
  for (const action of ['delete', 'accept', 'reject'] as const)
    memory.command(`${action} <id>`).description(action === 'delete' ? 'Archive a note; this is not destructive purge.' : action === 'accept' ? 'Accept a scoped proposed note.' : 'Reject a scoped proposed note.', { id: 'Inspected note or proposal ID.' }).action((id) => call(`memory.${action}`, { id }));
  memory
    .command('embed <ids>')
    .requiredOption('--public', 'Explicitly classify every selected source as public for embedding inference.')
    .requiredOption('--request-id <id>', 'Stable original embedding job request ID.')
    .description('Queue public source embeddings through the owner executor.', { ids: 'Comma-separated exact eligible note IDs.' })
    .action((ids, opt) =>
      call('memory.embed', { privacy: 'public', ids: ids.split(','), requestId: opt.requestId }),
    );
  memory.command('purge <id>').description('Destructively purge an already archived note while retaining required audit evidence.', { id: 'Inspected archived note ID; active notes are refused.' }).action((id) => call('memory.purge', { id }));
  memory.command('stats').description('Inspect scoped memory counts and storage metadata.').action(() => call('memory.stats', {}));
  memory
    .command('review')
    .description('List scoped proposals for explicit accept/reject commands.')
    .action(() => {
      owner();
      return call('memory.search', { status: ['proposed'], includePrivate: true, limit: 50 });
    });
  memory.command('prune').description('Run explicit scoped memory pruning maintenance.').action(() => call('memory.maintain', { action: 'prune' }));
  memory.command('expire').description('Run explicit scoped memory expiry maintenance.').action(() => call('memory.maintain', { action: 'expire' }));
  memory.command('publish').description('Publish eligible memory into the hook-readable view.').action(() => call('memory.publish', {}));
  const graph = program
    .command('graph')
    .description('Review scoped memory artifacts and their current source lineage.');
  graph.command('create <file>').description('Create a scoped graph artifact from reviewed source-lineage facts.', { file: 'JSON graph creation request; - reads stdin.' }).action((file) => {
    owner();
    return call('graph.create', json(textInput(file, 32768)));
  });
  graph.command('get <id>').description('Read a permitted graph artifact and its current version.', { id: 'Graph artifact ID.' }).action((id) => call('graph.get', { id }));
  graph
    .command('query <text>')
    .description('Query eligible scoped artifacts; optional expansion still rechecks source eligibility.', { text: 'Graph query text.' })
    .option('--expand', 'Include eligible neighboring artifacts within the bounded depth.')
    .option('--depth <hops>', 'Maximum graph expansion hops accepted by the shared method.', Number)
    .option('--limit <count>', 'Maximum eligible graph results accepted by the shared method.', Number)
    .action((text, opt) =>
      call('graph.query', {
        text,
        ...(opt.expand ? { expand: true } : {}),
        ...(opt.depth !== undefined ? { depth: opt.depth } : {}),
        ...(opt.limit !== undefined ? { limit: opt.limit } : {}),
      }),
    );
  graph.command('explain <id>').description('Inspect artifact provenance and current source lineage.', { id: 'Graph artifact ID.' }).action((id) => call('graph.explain', { id }));
  for (const action of ['accept', 'reject'] as const)
    graph
      .command(`${action} <id>`)
      .description(`${action === 'accept' ? 'Accept' : 'Reject'} a reviewed graph artifact with version CAS.`, { id: 'Inspected graph artifact ID.' })
      .requiredOption('--version <number>', 'Exact current graph artifact version.', Number)
      .action((id, opt) => {
        owner();
        return call('graph.review', { id, expectedVersion: opt.version, action });
      });
  graph
    .command('revoke <id>')
    .description('Revoke a graph artifact using its current version.', { id: 'Inspected graph artifact ID.' })
    .requiredOption('--version <number>', 'Exact current graph artifact version.', Number)
    .action((id, opt) => {
      owner();
      return call('graph.revoke', { id, expectedVersion: opt.version });
    });
  graph
    .command('backfill')
    .description('Run bounded explicit graph backfill for eligible memory sources.')
    .option('--limit <count>', 'Maximum eligible source records to backfill.', Number)
    .action((opt) => {
      owner();
      return call('graph.backfill', { ...(opt.limit !== undefined ? { limit: opt.limit } : {}) });
    });
  graph.command('export-profile <id>').description('Export a reviewed graph-backed profile with lineage intact.', { id: 'Inspected profile artifact ID.' }).action((id) => {
    owner();
    return call('graph.exportProfile', { id });
  });
  const consolidation = program
    .command('consolidation')
    .description('Queue bounded public-memory proposals for owner review.');
  consolidation
    .command('run')
    .description('Queue bounded public-memory inference proposals; owner review remains required.')
    .requiredOption('--request <id>', 'Stable request identifier; do not replay unknown outcomes.')
    .action((opt) => {
      owner();
      return call('consolidation.run', { requestId: opt.request });
    });
  consolidation.command('status').description('Inspect original consolidation progress and reserved source windows.').action(() => {
    owner();
    return call('consolidation.status', {});
  });
  consolidation
    .command('proposals')
    .description('List bounded consolidation proposals for explicit owner review.')
    .option('--limit <count>', 'Maximum proposals to return, from 1 to 20.', Number)
    .action((opt) => {
      owner();
      return call('consolidation.proposals', {
        ...(opt.limit !== undefined ? { limit: opt.limit } : {}),
      });
    });
  consolidation
    .command('abandon <id>')
    .description('Advance past a reviewed reserved source window without replaying it.', { id: 'Inspected consolidation window receipt ID.' })
    .requiredOption('--version <number>', 'Exact current reserved-window receipt version.', Number)
    .action((id, opt) => {
      owner();
      return call('consolidation.abandon', { id, expectedVersion: opt.version });
    });
  const profile = program
    .command('profile')
    .description(
      'Export selected portable preferences and preview imports without applying changes.',
    );
  profile
    .command('export')
    .description('Emit a selected portable preference bundle; no configuration is applied.')
    .requiredOption('--name <name>', 'Portable profile name.')
    .requiredOption('--description <text>', 'Public description carried in the exported profile.')
    .option('--roles <names>', 'Comma-separated selected roles.')
    .option('--providers <ids>', 'Comma-separated selected providers.')
    .option('--router', 'Include selected portable router preferences.')
    .option('--local', 'Include selected portable local preferences.')
    .option('--reviewed-profile <id>', 'Reviewed graph profile ID; must be paired with --version.')
    .option('--version <number>', 'Exact reviewed profile version.', Number)
    .option('--format <format>', 'json, toml or skill.', 'json')
    .action(async (opt) => {
      owner();
      if ((opt.reviewedProfile === undefined) !== (opt.version === undefined))
        throw new BosunError('invalid', 'Provide reviewed profile id and version together');
      if (!['json', 'toml', 'skill'].includes(opt.format))
        throw new BosunError('invalid', 'Invalid profile format');
      const result = await fetch('profile.export', {
        name: opt.name,
        description: opt.description,
        roles: opt.roles?.split(',') ?? [],
        providers: opt.providers?.split(',') ?? [],
        ...(opt.router ? { router: true } : {}),
        ...(opt.local ? { local: true } : {}),
        ...(opt.reviewedProfile !== undefined
          ? { reviewedProfile: { id: opt.reviewedProfile, version: opt.version } }
          : {}),
      });
      if (opt.format === 'json') return print(result);
      const bundle = result as { toml?: unknown; skill?: { content?: unknown } };
      const content = opt.format === 'toml' ? bundle?.toml : bundle?.skill?.content;
      if (typeof content !== 'string' || Buffer.byteLength(content) > 65536)
        throw new BosunError('unavailable', 'Profile export unavailable');
      out(content);
    });
  profile
    .command('inspect <file>')
    .description('Inspect a portable artifact without applying it.', { file: 'TOML or skill artifact; - reads stdin.' })
    .requiredOption('--format <format>', 'toml or skill')
    .action((file, opt) => {
      owner();
      return call('profile.inspect', { format: opt.format, content: textInput(file, 65536) });
    });
  profile
    .command('preview <file>')
    .description('Preview target-host configuration effects without applying them.', { file: 'Reviewed TOML or skill artifact; - reads stdin.' })
    .requiredOption('--format <format>', 'toml or skill')
    .option('--host <host>', 'Explicit target host.')
    .action((file, opt) => {
      owner();
      return call('profile.preview', {
        format: opt.format,
        content: textInput(file, 65536),
        ...(opt.host ? { targetHost: opt.host } : {}),
      });
    });
  const docs = program.command('docs').description('Explicitly maintain configured documentation indexing.');
  docs.command('index').description('Rebuild configured documentation indexing through the existing daemon; this writes index state.').action(() => call('docs.index', {}));
  const quota = program
    .command('quota')
    .description('Inspect durable quota metadata or refresh the selected supported source.');
  quota.command('status').description('Inspect durable quota metadata, including stale or unknown observations.').action(() => {
    owner();
    return call('quota.status', {});
  });
  program
    .command('usage')
    .description('Inspect scoped native attempt counts; unknown billing/components stay null.')
    .option('--limit <count>', 'Maximum attempts or daily aggregates, from 1 to 100.', Number)
    .option('--daily', 'Read retained daily aggregates.')
    .action((opt) => {
      owner();
      return call(opt.daily ? 'usage.daily' : 'usage.list', {
        ...(opt.limit !== undefined ? { limit: opt.limit } : {}),
      });
    });
  quota
    .command('refresh')
    .description('Explicitly refresh only the selected supported native quota source.')
    .requiredOption('--host <host>', 'Exact selected supported native runner ID.')
    .requiredOption('--model <model>', 'Exact native model whose quota is observed.')
    .action((opt) => {
      owner();
      return call('quota.refresh', { runnerId: opt.host, model: opt.model });
    });
  const handoff = program
    .command('handoff')
    .description('Create and transfer a public task artifact for manual review.');
  handoff
    .command('create')
    .description('Create an explicitly public handoff artifact from reviewed facts; no agent starts.')
    .requiredOption('--facts <file>', 'Public handoff facts JSON; - reads stdin, at most 120000 bytes.')
    .option('--request-id <id>', 'Stable original artifact creation request ID.')
    .action((opt) => {
      owner();
      return call('handoff.create', {
        privacy: 'public',
        requestId: opt.requestId ?? crypto.randomUUID(),
        facts: json(textInput(opt.facts, 120000)),
      });
    });
  handoff.command('get <id>').description('Read an original public handoff artifact for manual review.', { id: 'Handoff artifact ID.' }).action((id) => {
    owner();
    return call('handoff.get', { id });
  });
  handoff
    .command('list')
    .description('List permitted public handoff artifacts.')
    .option('--limit <count>', 'Maximum handoff artifacts to return, from 1 to 100.', Number)
    .action((opt) => {
      owner();
      return call('handoff.list', { ...(opt.limit !== undefined ? { limit: opt.limit } : {}) });
    });
  handoff
    .command('summarize <file>')
    .description('Queue a summary of an explicitly public evidence window.', { file: 'Reviewed public summary request JSON; - reads stdin, at most 32768 bytes.' })
    .action((file) => {
      owner();
      return call('handoff.summarize', json(textInput(file, 32768)));
    });
  handoff
    .command('export <id>')
    .description('Write a private exclusive artifact file for manual transfer; never overwrite.', { id: 'Inspected handoff artifact ID.' })
    .requiredOption('--output <file>', 'New private export file; existing files are refused.')
    .action(async (id, opt) => {
      owner();
      const bundle = await fetch('handoff.get', { id });
      const text = JSON.stringify(bundle, null, 2) + '\n';
      let fd: number | undefined;
      let wrote = false;
      try {
        fd = fs.openSync(opt.output, 'wx', 0o600);
        fs.writeFileSync(fd, text);
        wrote = true;
        fs.fsyncSync(fd);
      } catch {
        throw new BosunError(
          'unavailable',
          'Handoff export unavailable',
          wrote ? { details: { outcome: 'unknown' } } : undefined,
        );
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      print({ exported: true, continuation: 'manual-review-required' });
    });
  handoff
    .command('import <file>')
    .description('Import a reviewed public handoff bundle; continuation remains manual.', { file: 'Reviewed public bundle JSON; - reads stdin.' })
    .option('--request-id <id>', 'Stable original import request ID; retain it after uncertainty.')
    .action((file, opt) => {
      owner();
      return call('handoff.import', {
        privacy: 'public',
        requestId: opt.requestId ?? crypto.randomUUID(),
        bundle: json(textInput(file, 250000)),
      });
    });
  const external = program
    .command('claude-mem')
    .description(
      'Approve metadata references after reviewing observations in the native application.',
    );
  external.command('revision').description('Inspect the configured native observation revision without approving content.').action(async () => {
    owner();
    const settings = config();
    const file = claudeMemFile(settings, env);
    const { claudeMemRevision } = await import('../adapters/memory/claude-mem.ts');
    print({
      revision: settings.memory.claudeMem && file ? (claudeMemRevision(file) ?? null) : null,
    });
  });
  external.command('approve <file>').description('Approve exact metadata references already reviewed in the native application.', { file: 'Reviewed approval JSON; - reads stdin.' }).action((file) => {
    owner();
    if (readRuntimeManifest(paths()).state !== 'ready')
      throw new BosunError('unavailable', 'Runtime setup incomplete');
    print(
      approveClaudeMemReview(json(textInput(file, 65536)), project(cwd).id, paths(), config(), env),
    );
  });
  program
    .command('context <task>')
    .description('Retrieve eligible scoped context; optional public vector queries may invoke embeddings.', { task: 'Task text used for scoped retrieval.' })
    .option('--budget <tokens>', 'Packed context budget from 50 to 4000 tokens.', Number)
    .option('--public', 'Explicit public classification for an optional vector query.')
    .option('--candidates', 'Include permitted candidate IDs before packing.')
    .option(
      '--sources <names>',
      'Comma-separated curated or lexical,docs,claude-mem,graph,overview,vectors.',
    )
    .action((task, opt) =>
      call('context.retrieve', {
        task,
        ...(opt.budget !== undefined ? { budgetTokens: opt.budget } : {}),
        ...(opt.candidates ? { includeCandidates: true } : {}),
        ...(opt.public ? { privacy: 'public' } : {}),
        ...(opt.sources ? { sources: opt.sources.split(',') } : {}),
      }),
    );
  const jobs = program.command('job').description('Inspect and control durable jobs.');
  jobs.command('watch <id>').description('Open an owned Orca metadata observer; this does not resubmit work.', { id: 'Original job ID.' }).option('--terminal <handle>', 'Exact owned local Orca terminal handle to split.').action((id, opt) => {
    owner();
    const near = opt.terminal ?? env.ORCA_TERMINAL_HANDLE;
    return call('job.watch', { id, ...(near ? { near } : {}) });
  });
  jobs.command('watch-get <id>').description('Inspect the original job observer receipt.', { id: 'Original job ID.' }).action(id => { owner(); return call('job.watchGet', { id }); });
  jobs.command('watch-reconcile <id>').description('Observe original pane effects without replaying job submission.', { id: 'Original job ID.' }).action(id => { owner(); return call('job.watchReconcile', { id }); });
  jobs.command('list').description('List scoped durable jobs; queued is not completed.').action(() => call('job.list', {}));
  for (const action of ['get', 'result', 'cancel', 'release'] as const)
    jobs.command(`${action} <id>`).description(action === 'get' ? 'Inspect the original job receipt and current state.' : action === 'result' ? 'Read the permitted result of the original job.' : action === 'cancel' ? 'Request cancellation; this is not rollback or proof of native cancellation.' : 'Release the original job control; unknown effects remain nonreplayable.', { id: 'Original job ID.' }).action((id) => call(`job.${action}`, { id }));
  jobs
    .command('events')
    .description('Read one bounded event batch after a numeric cursor; not a continuous stream.')
    .option('--after <cursor>', 'Return events after this nonnegative event cursor.', Number, 0)
    .action((opt) => call('job.events', { after: opt.after }));
  jobs.command('retention').description('Inspect job retention policy without pruning.').action(() => {
    owner();
    return call('job.retention', {});
  });
  jobs.command('policy <id>').description('Inspect the frozen policy decision for an original job.', { id: 'Original job ID.' }).action((id) => {
    owner();
    return call('job.policy', { id });
  });
  jobs
    .command('prune')
    .description('Explicitly prune eligible retained job records under existing retention policy.')
    .option('--limit <count>', 'Maximum eligible records to prune, from 1 to 100.', Number)
    .action((opt) => {
      owner();
      return call('job.prune', { ...(opt.limit !== undefined ? { limit: opt.limit } : {}) });
    });
  jobs
    .command('wait <id>')
    .description('Observe the same job until terminal state; timeout leaves it running.', { id: 'Original job ID; do not resubmit after timeout.' })
    .option('--timeout <milliseconds>', 'Observation deadline from 1 to 300000 milliseconds; does not cancel work.', Number, 30000)
    .option('--progress', 'Print bounded state changes; failed/cancelled/unknown terminal states then exit 1.')
    .option('--result', 'Read the final result after observation completes.')
    .action(async (id, opt) => {
      if (!Number.isSafeInteger(opt.timeout) || opt.timeout < 1 || opt.timeout > 300000)
        throw new BosunError('invalid', 'Invalid wait timeout');
      const deadline = Date.now() + opt.timeout;
      let version: number | undefined;
      for (;;) {
        const value = (await fetch('job.get', { id })) as { id: string; state: string; version: number; reason: string | null };
        if (opt.progress && version !== value.version) {
          out(JSON.stringify({ id: value.id, state: value.state, version: value.version, reason: value.reason }) + '\n');
          version = value.version;
        }
        if (!['queued', 'running'].includes(value.state)) {
          print(opt.result ? { job: value, ...await fetch('job.result', { id }) as object } : value);
          if (opt.progress && ['failed', 'cancelled', 'unknown'].includes(value.state)) exitCode = 1;
          return;
        }
        if (Date.now() >= deadline) throw new BosunError('timeout', 'Job wait timed out; the existing job continues under daemon control');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    });
  program
    .command('run [prompt]')
    .description('Queue a public task through the configured runner; default access is edit, not read-only.', { prompt: 'Public task text; provide exactly one prompt or --file (at most 32768 bytes).' })
    .option('-f, --file <path>', 'Explicitly public task file, or - for stdin.')
    .option('-e, --host <host>', 'Native host: omp, opencode, codex or claude; defaults to configured primary.')
    .option('--runner <runner>', 'Configured ACP runner: acp-<name>; mutually exclusive with --host.')
    .option('--model <model>', 'Exact native/ACP model; otherwise use the configured executor or worker binding.')
    .option('--effort <effort>', 'Exact selected runner reasoning effort.')
    .option('--read-only', 'Request read access instead of the default edit access.')
    .option('--request-id <id>', 'Stable original submission ID; inspect rather than replay unknown work.')
    .option('--watch', 'Open an optional Orca metadata observer for the queued job.')
    .option('--no-watch', 'Queue without an Orca pane.')
    .option('--operation <kind>', 'Policy operation: inspect, mechanical, implementation, planning, auth, payments, delete, migration, production or unknown.')
    .option('--files <paths>', 'Exact comma-separated relative task paths; not globs.')
    .option('--no-delegation', 'Declare that policy must not delegate this task.')
    .option('--exact-model <model>', 'Policy constraint requiring this exact model.')
    .option(
      '--allow-unknown-quota',
      'Owner opt-in for missing/stale/unavailable quota only; never known exhaustion.',
    )
    .action((prompt, opt) => {
      if (env.BOSUN_DEPTH)
        throw new BosunError('unsupported', 'Nested execution is disabled');
      if ((prompt !== undefined) === (opt.file !== undefined))
        throw new BosunError('invalid', 'Provide one public task or task file');
      const task = opt.file !== undefined ? textInput(opt.file) : prompt;
      if (task === undefined) throw new BosunError('invalid', 'Public task required');
      return submitWatched('job.submit', runParameters(task, opt), opt.watch);
    });
  program
    .command('mcp')
    .description('Bridge MCP stdio tools to the existing daemon.')
    .action(async () => {
      const { startMcpBridge } = await import('./mcp.ts');
      startMcpBridge({ paths: paths(), scope: { workspace: cwd, sessionId: scope.sessionId } });
    });
  program
    .command('rpc <method> <json>')
    .description('Call a shared daemon method for advanced diagnostics; method effects and safety gates still apply.', { method: 'Exact shared method name.', json: 'JSON parameter object, quoted as one shell argument.' })
    .action(async (method, value) => print(await fetch(method, json(value))));
  managed.addHelpText('after', '\nAdvanced native lifecycle (existing daemon required):\n  bosun managed get SOURCE_ID\nReplace SOURCE_ID with the inspected original receipt ID. Start/turn/authorize require --public;\nstart requires a pinned --model and reviewed seed file. Versions come from managed get.\nKeep stable request IDs; unknown native turns or handoffs never authorize replay.\n');
  upgrade.addHelpText('after', '\nAdvanced legacy migration:\n  bosun upgrade status\n  bosun upgrade plan --help\nInspect the supported legacy home and exact saved plan before apply. --hash is the reviewed\nplan hash; --clients-stopped is your attestation, not automatic client shutdown.\nUnknown effects require original-outcome inspection, not another migration attempt.\n');
  router.addHelpText('after', '\nExamples (existing daemon required):\n  bosun router status\n  bosun router observations --limit 10\n  bosun route "Fix a typo in README.md."\nRoute text is public and can invoke inference; advice is not execution or automatic qualification.\nOffline eval uses imported observations; --run queues 80 decisions and requires the exact\nreviewed source hash and a stable request ID. Unknown capture must not be replayed.\n');
  workspace.addHelpText('after', '\nExamples (existing daemon and committed Git inputs required):\n  bosun workspace list\n  bosun workspace create task --request-id workspace-task-1\nCreation writes an owned worktree; dirty files are excluded. Inspect list/get before using\nan ID and current --version. run queues public model work with edit access unless --read-only.\nprune-preview is inspection only, not deletion. Unknown creation/submission is not replayable.\n');
  review.addHelpText('after', '\nRead-only help:\n  bosun review --help\n  bosun review get --help\nTo submit, explicitly classify the checkout with --public and select an exact model via\n--model or the selected cross-reviewer/reviewer binding. Requires the existing daemon.\nQueued review is not success; inspect its ID and revision validity before check run.\nOrca auto-watch applies when ORCA_TERMINAL_HANDLE is set; --no-watch disables it.\n');
  check.addHelpText('after', '\nAdvanced verification (existing daemon required):\n  bosun check run --help\n  bosun check get --help\nInspect a current review ID first. --command executes without a shell; --args is one quoted\nJSON array, for example \'["--version"]\'. Keep the original stable request ID; queued is not passed.\n');
  card.addHelpText('after', '\nRead-only inspection help:\n  bosun card --help\n  bosun card get --help\nUpdates affect the enclosing local Orca card through the daemon; comments require --public.\nInspect the original receipt before reconcile/acknowledge. Acknowledgement uses the exact\nunknown receipt version and observation hash, never replays the update.\n');
  install.addHelpText('after', '\nEveryday owner-terminal workflow:\n  bosun install\n  bosun install --binary /absolute/release/bosun\n  bosun onboard --host omp\nRead-only receipt inspection:\n  bosun install status\nAdvanced plan/apply/undo/enable/disable require exact reviewed plan hashes and receipt versions,\nnot release versions or binary hashes. Inspect status and the saved plan before any effect.\n--clients-stopped attests settled clients; it does not stop them. Keep original request IDs.\nExpired unattempted plans need fresh review; unknown attempted effects require original\nreceipt inspection/reconcile, never fresh-ID replay. Data/configuration are retained by undo.\n');
  host.addHelpText('after', '\nEveryday entry:\n  bosun onboard --host omp\nAdvanced read-only inspection:\n  bosun host status\n  bosun host launch --help\nInspect the selected profile ID, current receipt version and exact plan hash before launch.\nUse launch with those inspected values and --preview for literal metadata without native calls.\nActual launch separately probes the selected native version and opens its foreground UI;\nit does not qualify managed control or model quality. Drift requires review, not receipt rewriting.\n');
  cfg.addHelpText('after', '\nExamples:\n  bosun config show\n  bosun config validate --help\nshow emits effective TOML, including environment overlays. validate is an explicit write:\nit publishes the hook snapshot using the established stopped-owner configuration workflow.\nNeither command installs a host, starts a daemon or selects a missing model for you.\n');
  daemon.addHelpText('after', '\nForeground startup after explicit preparation:\n  bosun daemon run\n  In another terminal: bosun status\nThe daemon owns the prepared runtime until shutdown. Stop a foreground daemon in its original\nterminal; do not guess PIDs. Ordinary reads never prepare or start the daemon implicitly.\n');
  memory.addHelpText('after', '\nEveryday lexical memory (existing daemon required):\n  bosun memory add --category project --title Runtime --body "Use Bun."\n  bosun memory search Runtime\n  bosun memory review\nInspect returned IDs and versions before update or proposal review. Public and cross-project\nsharing are separate: --private controls privacy; --unshared limits sharing.\ndelete archives; purge destructively removes an already archived note with retained audit.\nAdvanced publish/prune/expire mutate maintained state. Public --auto and embed may queue\ninference; ordinary lexical CRUD does not. eval/bench are explicit diagnostics, not live qualification.\n');
  remoteView.addHelpText('after', '\nAdvanced public caching (existing daemon required):\n  bosun remote-view status\n  bosun remote-view refresh --help\nrefresh explicitly acquires a public bounded view. Invalidate/release before source changes.\nUnknown acquisition requires original receipt inspection/reconcile, never automatic replay.\n');
  graph.addHelpText('after', '\nAdvanced graph memory (existing daemon required):\n  bosun graph query Runtime\n  bosun graph create --help\nInspect get/explain lineage before accept/reject/revoke; --version is the current artifact\nversion, not a release version. Expansion never bypasses source scope, privacy or eligibility.\ncreate/backfill/review/revoke are effects; export-profile emits a lineage-bound artifact.\n');
  consolidation.addHelpText('after', '\nAdvanced public-memory inference (existing daemon required):\n  bosun consolidation status\n  bosun consolidation proposals --limit 10\nrun queues proposals, never implicit acceptance. Keep its stable --request ID.\nInspect the reserved window and current version before abandon; unknown work is not replayable.\n');
  profile.addHelpText('after', '\nPortable artifacts (existing daemon required):\n  bosun profile export --name preferences --description "Reviewed preferences" --format toml\n  bosun profile preview preferences.toml --format toml --host omp\nInspect/review the actual artifact file before preview. Export writes artifact bytes to stdout;\ninspect and preview do not apply configuration or launch hosts. Reviewed profile ID/version\nmust be supplied together; no credentials or automatic continuation should be inferred.\n');
  docs.addHelpText('after', '\nExplicit indexing (existing daemon required):\n  bosun docs index\nThis rebuilds configured documentation indexing; it is not documentation help or a read-only query.\nUse bosun context "Which runtime?" --sources docs to retrieve eligible indexed context.\n');
  quota.addHelpText('after', '\nExamples (existing daemon required):\n  bosun quota status\n  bosun quota refresh --help\nstatus reads durable observations; refresh explicitly contacts only the selected supported source\nand exact model. Stale/unknown quota is not zero and permission never overrides known exhaustion.\n');
  handoff.addHelpText('after', '\nManual public transfer (existing daemon required):\n  bosun handoff list --limit 10\n  bosun handoff create --help\nReview facts/bundles as public before create/import. Inspect a listed artifact ID before export;\n--output must be a new private file. summarize queues inference; importing never starts an agent.\nRetain stable request IDs and original receipts after unknown effects; continuation stays manual.\n');
  external.addHelpText('after', '\nAdvanced external-memory approval:\n  bosun claude-mem revision\n  bosun claude-mem approve --help\nReview observations in the native application first, then approve only exact metadata references.\nApproval requires a prepared runtime; no native login, content review or automatic approval is implied.\n');
  jobs.addHelpText('after', '\nEveryday observation (existing daemon required):\n  bosun job list\n  bosun job events --after 0\nAfter inspecting a listed ID: bosun job wait JOB_ID --result (replace JOB_ID).\nTimeout leaves the same job running; inspect it instead of submitting again. --progress emits\nbounded state records and sets exit 1 for failed/cancelled/unknown terminal outcomes.\nAdvanced cancel/release are not rollback or permission to replay unknown effects. watch opens\nan owned Orca observer; inspect watch-get/watch-reconcile if observation is uncertain.\nprune mutates eligible retention records; events reads one batch, not a continuous stream.\n');
  const summarized = new Set(['status', 'doctor', 'roles', 'route', 'router status', 'memory add', 'memory search', 'memory get',
    'context', 'job get', 'job list', 'run', 'spin', 'review', 'workspace create', 'workspace run', 'check run']);
  const jsonOptions = (command: CommandUnknownOpts, prefix = '') => {
    for (const child of command.commands) {
      const name = prefix ? `${prefix} ${child.name()}` : child.name();
      if (summarized.has(name) && !child.options.some(option => option.long === '--json'))
        child.option('--json', 'Print the existing machine-readable result, even in an owner terminal.');
      jsonOptions(child, name);
    }
  };
  jsonOptions(program);
  try {
    if (!argv.length && terminal && audience === 'owner') {
      program.outputHelp(); return 0;
    }
    await program.parseAsync(argv, { from: 'user' });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    const normalized = rpcError(error);
    if (terminal && audience === 'owner' && !jsonOutput) err(renderCliError(normalized, { command: commandPath, requestId, hint: errorHint }));
    else err(JSON.stringify({ error: normalized }) + '\n');
    return error instanceof BosunError ? error.exitCode : 1;
  }
}
