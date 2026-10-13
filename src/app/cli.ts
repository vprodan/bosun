import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { Command, CommanderError } from '@commander-js/extra-typings';
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
  const print = (value: unknown) => out(JSON.stringify(value, null, 2) + '\n');
  let exitCode = 0;
  const owner = () => {
    if (audience !== 'owner') throw new BosunError('unsupported', 'Owner operation required');
  };
  async function fetch(method: string, params: Record<string, unknown>) {
    const request: RpcRequest = { version: 1, id: crypto.randomUUID(), method, params, scope };
    methodParams(request);
    const definition = methodDefinition(method);
    return callLocalRpc({ socket: paths().socket, request, mutation: definition.mutation });
  }
  const call = async (method: string, params: Record<string, unknown>) =>
    print(await fetch(method, params));
  async function submitWatched(method: string, params: Record<string, unknown>, watch?: boolean) {
    const requested = watch === true || watch !== false && audience === 'owner' && !!env.ORCA_TERMINAL_HANDLE;
    if (requested) owner();
    const value = await fetch(method, params) as { job?: { id: string } | null };
    if (!requested || !value.job) { print(value); return; }
    let observation: unknown;
    try {
      observation = await fetch('job.watch', { id: value.job.id, ...(env.ORCA_TERMINAL_HANDLE ? { near: env.ORCA_TERMINAL_HANDLE } : {}) });
    } catch {
      observation = { state: 'unavailable', observation: { wait: ['bosun', 'job', 'wait', value.job.id], get: ['bosun', 'job', 'get', value.job.id], result: ['bosun', 'job', 'result', value.job.id] } };
    }
    print({ ...value, watch: observation });
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
    if (!model) throw new BosunError('invalid', 'Select the runner model with --model');
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
    .description('OpenCode-first agent orchestration and scoped memory.')
    .version(version)
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
    .requiredOption('--request-id <id>')
    .requiredOption('--output <file>')
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
    .requiredOption('--hash <hash>')
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
  upgrade.command('status').action(() => {
    owner();
    print(upgradeStatus(paths()));
  });
  managed
    .command('start')
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
    .requiredOption('--version <number>', 'Current source receipt version.', Number)
    .requiredOption('--request-id <id>', 'Stable turn request.')
    .option('--public', 'Classify submitted task text as public.')
    .option('--allow-unknown-quota', 'Explicit owner permission for unknown quota only.')
    .option('--operation <kind>', 'Declared task operation.')
    .option('--files <paths>', 'Exact comma-separated task paths.')
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
  managed.command('get <id>').action((id) => {
    owner();
    return call('managed.get', { id });
  });
  managed
    .command('authorize <id>')
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
    .option('--after <cursor>', 'Previously published exact cursor.')
    .action((id, opt) => {
      owner();
      return call('managed.capture', { privacy: 'public', id, afterCursor: opt.after ?? null });
    });
  managed
    .command('retire <id>')
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
    .description('Request public Clef advice; calibration gates automatic dispatch.')
    .option('--private', 'Omit private input without inference.')
    .action((text, opt) =>
      opt.private ? undefined : call('route.classify', { privacy: 'public', text }),
    );
  const router = program
    .command('router')
    .description('Inspect decision readiness and content-free observation feedback.');
  router.command('status').action(() => {
    owner();
    return call('route.status', {});
  });
  router
    .command('observations')
    .option('--legacy', 'Explicitly inspect historical unscoped metadata; never displays prompts.')
    .option('--limit <count>', 'Maximum observations, up to 100.', Number, 50)
    .action((opt) => {
      owner();
      return call('route.observations', { legacy: !!opt.legacy, limit: opt.limit });
    });
  router
    .command('label <id> <lane>')
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
    .option('--legacy', 'Report historical metadata separately from current project records.')
    .action((opt) => {
      owner();
      return call('route.stats', { legacy: !!opt.legacy });
    });
  router
    .command('eval <file>')
    .description(
      'Evaluate80 public cases:20 development and60 held-out, grouped by repository/session.',
    )
    .requiredOption('--public', 'Classify the entire redacted dataset as public.')
    .option(
      '--run',
      'Queue80 configured-model decisions; default analyzes imported observations offline.',
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
  router.command('frozen <job-id>').action((id) => {
    owner();
    return call('route.frozen', { id });
  });
  program
    .command('notifications')
    .description('Inspect opt-in opaque local notifications.')
    .command('status')
    .action(() => {
      owner();
      return call('notification.status', {});
    });
  const workspace = program
    .command('workspace')
    .description('Create committed Git worktrees and preview their cleanup.');
  workspace
    .command('create <name>')
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
  workspace.command('list').action(() => {
    owner();
    return call('workspace.list', {});
  });
  for (const action of ['get', 'reconcile', 'prune-preview'] as const)
    workspace.command(`${action} <id>`).action((id) => {
      owner();
      return call(action === 'prune-preview' ? 'workspace.prunePreview' : `workspace.${action}`, {
        id,
      });
    });
  workspace
    .command('run <id> <prompt>')
    .requiredOption('--version <number>', 'Exact workspace version.', Number)
    .option('-e, --host <host>')
    .option('--runner <runner>', 'Configured ACP runner: acp-<name>.')
    .option('--model <model>')
    .option('--effort <effort>')
    .option('--read-only')
    .option('--request-id <id>')
    .option('--watch', 'Open an optional Orca metadata observer for the queued job.')
    .option('--no-watch', 'Queue without an Orca pane.')
    .option('--allow-unknown-quota')
    .option('--operation <kind>')
    .option('--files <paths>')
    .option('--no-delegation')
    .option('--exact-model <model>')
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
    .description('Create one owned committed worktree and queue a pinned runner job.')
    .option('-f, --file <path>', 'Explicitly public task file, or - for stdin.')
    .option('--name <name>', 'Workspace label.', 'task')
    .option('--base <revision>')
    .option('-e, --host <host>')
    .option('--runner <runner>', 'Configured ACP runner: acp-<name>.')
    .option('--model <model>')
    .option('--effort <effort>')
    .option('--read-only')
    .option('--request-id <id>')
    .option('--watch', 'Open an optional Orca metadata observer for the queued job.')
    .option('--no-watch', 'Queue without an Orca pane.')
    .option('--allow-unknown-quota')
    .option('--operation <kind>')
    .option('--files <paths>')
    .option('--no-delegation')
    .option('--exact-model <model>')
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
    .option('-e, --host <host>')
    .option('--source-host <host>', 'Declared originating native harness.')
    .option('--model <model>')
    .option('--effort <effort>')
    .option('--request-id <id>')
    .option('--watch', 'Open an optional Orca metadata observer for the queued job.')
    .option('--no-watch', 'Queue without an Orca pane.')
    .option('--allow-unknown-quota')
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
      if (!model) throw new BosunError('invalid', 'Select the reviewer model with --model');
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
    .description('Inspect current revision validity and original review job.')
    .action((id) => {
      owner();
      return call('review.get', { id });
    });
  const check = program
    .command('check')
    .description('Run an explicit owner verification command bound to a review revision.');
  check
    .command('run <review-id>')
    .requiredOption('--command <executable>', 'Executable name or path; no shell.')
    .requiredOption('--args <json>', 'JSON argument array, including [] for no arguments.')
    .requiredOption('--request-id <id>')
    .option('--timeout <milliseconds>', 'Bounded native deadline.', Number)
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
  check.command('get <id>').action((id) => {
    owner();
    return call('check.get', { id });
  });
  const card = program
    .command('card [status] [comment...]')
    .description('Update the enclosing local Orca worktree card with an owner receipt.')
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
  card.command('get <id>').action((id) => {
    owner();
    return call('card.get', { id });
  });
  card
    .command('reconcile <id>')
    .description('Observe the current card without retrying an update.')
    .action((id) => {
      owner();
      return call('card.reconcile', { id });
    });
  card
    .command('acknowledge <id>')
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
      print(await setupRuntime(paths(), config()));
    });
  program
    .command('onboard')
    .description('Inspect setup progress and show the next reviewed owner action.')
    .option('--host <host>', 'Defaults to the configured primary host.')
    .option('--json')
    .action(async (opt) => {
      owner();
      const { inspectOnboarding, renderOnboarding } = await import('./onboarding.ts');
      const value = inspectOnboarding({ paths: paths(), env }, opt.host);
      if (opt.json) print(value);
      else out(renderOnboarding(value));
    });
  const install = program
    .command('install')
    .description('Review and apply an owned binary and dormant daemon definition.');
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
    .requiredOption('--binary <file>')
    .requiredOption('--request-id <id>')
    .requiredOption('--output <file>')
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
    .requiredOption('--hash <hash>')
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
  install.command('status').action(async () => {
    owner();
    const { installationStatus } = await import('./installation.ts');
    print(installationStatus({ paths: paths(), env }));
  });
  install
    .command('undo <id>')
    .requiredOption('--version <number>', 'Reviewed receipt version.', Number)
    .requiredOption('--hash <hash>')
    .option('--clients-stopped')
    .action(undoOwnedInstallation);
  for (const operation of ['enable', 'disable'] as const)
    install
      .command(`${operation} <id>`)
      .requiredOption('--version <number>', 'Reviewed receipt version.', Number)
      .requiredOption('--hash <hash>')
      .requiredOption('--request-id <id>')
      .option('--clients-stopped')
      .action(async (id, opt) => print(await operateOwnedService(operation, id, opt)));
  program
    .command('uninstall <id>')
    .description('Migration spelling for install undo; requires the reviewed owned receipt.')
    .requiredOption('--version <number>', 'Reviewed receipt version.', Number)
    .requiredOption('--hash <hash>')
    .option('--clients-stopped')
    .action(undoOwnedInstallation);
  for (const [name, operation] of [
    ['start', 'enable'],
    ['stop', 'disable'],
  ] as const)
    program
      .command(`${name} <id>`)
      .description(`Migration spelling for install ${operation}; selects one owned daemon receipt.`)
      .requiredOption('--version <number>', 'Reviewed receipt version.', Number)
      .requiredOption('--hash <hash>')
      .requiredOption('--request-id <id>')
      .option('--clients-stopped')
      .action(async (id, opt) => print(await operateOwnedService(operation, id, opt)));
  program
    .command('restart <id>')
    .description('Disable then enable one owned daemon using two durable original operations.')
    .requiredOption('--version <number>', 'Reviewed receipt version.', Number)
    .requiredOption('--hash <hash>')
    .requiredOption('--request-id <id>')
    .option('--clients-stopped')
    .action(async (id, opt) => {
      owner();
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(opt.requestId))
        throw new BosunError('invalid', 'Stable service operation required');
      const requestId = (phase: string) =>
        `restart_${crypto
          .createHash('sha256')
          .update(JSON.stringify([opt.requestId, phase]))
          .digest('hex')}`;
      const stopped = await operateOwnedService('disable', id, {
        ...opt,
        requestId: requestId('disable'),
      });
      const started = await operateOwnedService('enable', id, {
        ...opt,
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
    .requiredOption('--version <number>', 'Current uncertain receipt version.', Number)
    .requiredOption('--hash <hash>')
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
      print(diagnosis);
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
    .requiredOption('--native-version <version>', 'Exact selected profile version.')
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
  host.command('status [id]').action(async (id) => {
    owner();
    const { hostInstallationStatus } = await import('./host-install.ts');
    print(hostInstallationStatus({ paths: paths(), config: config(), binary: hostBinary() }, id));
  });
  host
    .command('launch <id>')
    .description(
      'Launch the prepared native UI after version/profile checks; managed control remains unverified.',
    )
    .requiredOption('--version <number>', 'Exact installation receipt version.', Number)
    .requiredOption('--hash <hash>', 'Reviewed installation plan hash.')
    .option('--preview', 'Inspect literal launch metadata without native calls.')
    .action(async (id, opt) => {
      owner();
      const selected = { paths: paths(), config: config(), binary: hostBinary(), env, cwd };
      if (opt.preview) {
        const { hostLaunchPlan } = await import('./host-install.ts');
        print(await hostLaunchPlan(selected, id, opt.version, opt.hash));
        return;
      }
      const { launchHost } = await import('./host-launch.ts');
      const controller = new AbortController();
      const interrupt = () => controller.abort('SIGINT');
      const terminate = () => controller.abort('SIGTERM');
      process.on('SIGINT', interrupt);
      process.on('SIGTERM', terminate);
      try {
        const result = await launchHost(selected, id, opt.version, opt.hash, controller.signal);
        exitCode = controller.signal.aborted
          ? controller.signal.reason === 'SIGINT'
            ? 130
            : 143
          : (result.code ??
            (result.signal === 'SIGINT' ? 130 : result.signal === 'SIGTERM' ? 143 : 1));
      } finally {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', terminate);
      }
    });
  host
    .command('undo <id>')
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
  const cfg = program.command('config').description('Inspect and validate TOML settings.');
  cfg.command('show').action(() => {
    owner();
    out(renderRuntimeConfig(config()));
  });
  cfg.command('validate').action(() => {
    owner();
    const manifest = readRuntimeManifest(paths());
    print(publishHookConfig(config(), paths(), { sourceId: manifest.sourceId, now: Date.now() }));
  });
  program
    .command('roles')
    .description('List shipped roles and configured model bindings.')
    .option('--json', 'JSON output (also the default).')
    .action(() => {
      const settings = config();
      print(
        roleDefinitions().map((role) => ({
          id: role.id,
          description: role.description,
          access: role.access,
          bindings: settings.roles[role.id] ?? {},
        })),
      );
    });
  program.addHelpText(
    'after',
    '\nExamples:\n  bosun setup\n  bosun daemon run\n  bosun run "Public read-only task" --read-only\n  bosun job list\n',
  );
  const daemon = program.command('daemon').description('Run the single local authority.');
  daemon.command('run').action(async () => {
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
    .requiredOption('--public', 'Evaluate an explicitly approved public JSON export.')
    .option('--surface <name>', 'hook-packing or mcp.', 'hook-packing')
    .option('--vectors', 'Explicitly permit the pinned public embedding model for MCP evaluation.')
    .option('--budget <tokens>', 'MCP budget; hook packing is fixed at400.', Number)
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
    .requiredOption('--public')
    .option('--ttl-ms <count>', 'Local view lifetime', Number, 300000)
    .action((opt) => call('remote.view.refresh', { privacy: 'public', ttlMs: opt.ttlMs }));
  remoteView.command('status').action(() => call('remote.view.status', {}));
  remoteView.command('invalidate').action(() => call('remote.view.invalidate', {}));
  remoteView.command('reconcile').action(() => call('remote.view.reconcile', {}));
  memory
    .command('add')
    .requiredOption('--category <category>')
    .option('--title <title>')
    .option('--tags <tags>', 'Comma-separated tags; explicit values take precedence.')
    .option('--auto', 'Derive a private title locally, or queue public title/tag suggestions.')
    .option('--provider <name>', 'Configured generative provider for public suggestions.')
    .option(
      '--allow-remote-api',
      'Explicitly permit the configured API provider for this public note.',
    )
    .option('--request-id <id>', 'Stable identifier for a public suggestion job.')
    .option('--body <text>')
    .option('--body-file <file>')
    .option('--private')
    .option('--unshared')
    .option('--proposed')
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
    .option('--category <category>')
    .option('--private')
    .option('--limit <count>', '', Number)
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
    .option('--events')
    .action((id, opt) => call('memory.get', { id, ...(opt.events ? { events: true } : {}) }));
  memory
    .command('update <id>')
    .requiredOption('--version <number>', '', Number)
    .requiredOption('--patch <json>')
    .action((id, opt) =>
      call('memory.update', { id, expectedVersion: opt.version, patch: json(opt.patch) }),
    );
  for (const action of ['delete', 'accept', 'reject'] as const)
    memory.command(`${action} <id>`).action((id) => call(`memory.${action}`, { id }));
  memory
    .command('embed <ids>')
    .requiredOption('--public')
    .requiredOption('--request-id <id>')
    .description('Queue public source embeddings through the owner executor.')
    .action((ids, opt) =>
      call('memory.embed', { privacy: 'public', ids: ids.split(','), requestId: opt.requestId }),
    );
  memory.command('purge <id>').action((id) => call('memory.purge', { id }));
  memory.command('stats').action(() => call('memory.stats', {}));
  memory
    .command('review')
    .description('List scoped proposals for explicit accept/reject commands.')
    .action(() => {
      owner();
      return call('memory.search', { status: ['proposed'], includePrivate: true, limit: 50 });
    });
  memory.command('prune').action(() => call('memory.maintain', { action: 'prune' }));
  memory.command('expire').action(() => call('memory.maintain', { action: 'expire' }));
  memory.command('publish').action(() => call('memory.publish', {}));
  const graph = program
    .command('graph')
    .description('Review scoped memory artifacts and their current source lineage.');
  graph.command('create <file>').action((file) => {
    owner();
    return call('graph.create', json(textInput(file, 32768)));
  });
  graph.command('get <id>').action((id) => call('graph.get', { id }));
  graph
    .command('query <text>')
    .option('--expand')
    .option('--depth <hops>', '', Number)
    .option('--limit <count>', '', Number)
    .action((text, opt) =>
      call('graph.query', {
        text,
        ...(opt.expand ? { expand: true } : {}),
        ...(opt.depth !== undefined ? { depth: opt.depth } : {}),
        ...(opt.limit !== undefined ? { limit: opt.limit } : {}),
      }),
    );
  graph.command('explain <id>').action((id) => call('graph.explain', { id }));
  for (const action of ['accept', 'reject'] as const)
    graph
      .command(`${action} <id>`)
      .requiredOption('--version <number>', '', Number)
      .action((id, opt) => {
        owner();
        return call('graph.review', { id, expectedVersion: opt.version, action });
      });
  graph
    .command('revoke <id>')
    .requiredOption('--version <number>', '', Number)
    .action((id, opt) => {
      owner();
      return call('graph.revoke', { id, expectedVersion: opt.version });
    });
  graph
    .command('backfill')
    .option('--limit <count>', '', Number)
    .action((opt) => {
      owner();
      return call('graph.backfill', { ...(opt.limit !== undefined ? { limit: opt.limit } : {}) });
    });
  graph.command('export-profile <id>').action((id) => {
    owner();
    return call('graph.exportProfile', { id });
  });
  const consolidation = program
    .command('consolidation')
    .description('Queue bounded public-memory proposals for owner review.');
  consolidation
    .command('run')
    .requiredOption('--request <id>', 'Stable request identifier; do not replay unknown outcomes.')
    .action((opt) => {
      owner();
      return call('consolidation.run', { requestId: opt.request });
    });
  consolidation.command('status').action(() => {
    owner();
    return call('consolidation.status', {});
  });
  consolidation
    .command('proposals')
    .option('--limit <count>', '', Number)
    .action((opt) => {
      owner();
      return call('consolidation.proposals', {
        ...(opt.limit !== undefined ? { limit: opt.limit } : {}),
      });
    });
  consolidation
    .command('abandon <id>')
    .description('Advance past a reviewed reserved source window without replaying it.')
    .requiredOption('--version <number>', '', Number)
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
    .requiredOption('--name <name>')
    .requiredOption('--description <text>')
    .option('--roles <names>', 'Comma-separated selected roles.')
    .option('--providers <ids>', 'Comma-separated selected providers.')
    .option('--router')
    .option('--local')
    .option('--reviewed-profile <id>')
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
    .requiredOption('--format <format>', 'toml or skill')
    .action((file, opt) => {
      owner();
      return call('profile.inspect', { format: opt.format, content: textInput(file, 65536) });
    });
  profile
    .command('preview <file>')
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
  const docs = program.command('docs');
  docs.command('index').action(() => call('docs.index', {}));
  const quota = program
    .command('quota')
    .description('Inspect durable quota metadata or refresh the selected supported source.');
  quota.command('status').action(() => {
    owner();
    return call('quota.status', {});
  });
  program
    .command('usage')
    .description('Inspect scoped native attempt counts; unknown billing/components stay null.')
    .option('--limit <count>', '', Number)
    .option('--daily', 'Read retained daily aggregates.')
    .action((opt) => {
      owner();
      return call(opt.daily ? 'usage.daily' : 'usage.list', {
        ...(opt.limit !== undefined ? { limit: opt.limit } : {}),
      });
    });
  quota
    .command('refresh')
    .requiredOption('--host <host>')
    .requiredOption('--model <model>')
    .action((opt) => {
      owner();
      return call('quota.refresh', { runnerId: opt.host, model: opt.model });
    });
  const handoff = program
    .command('handoff')
    .description('Create and transfer a public task artifact for manual review.');
  handoff
    .command('create')
    .requiredOption('--facts <file>')
    .option('--request-id <id>')
    .action((opt) => {
      owner();
      return call('handoff.create', {
        privacy: 'public',
        requestId: opt.requestId ?? crypto.randomUUID(),
        facts: json(textInput(opt.facts, 120000)),
      });
    });
  handoff.command('get <id>').action((id) => {
    owner();
    return call('handoff.get', { id });
  });
  handoff
    .command('list')
    .option('--limit <count>', '', Number)
    .action((opt) => {
      owner();
      return call('handoff.list', { ...(opt.limit !== undefined ? { limit: opt.limit } : {}) });
    });
  handoff
    .command('summarize <file>')
    .description('Queue a summary of an explicitly public evidence window.')
    .action((file) => {
      owner();
      return call('handoff.summarize', json(textInput(file, 32768)));
    });
  handoff
    .command('export <id>')
    .requiredOption('--output <file>')
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
    .option('--request-id <id>')
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
  external.command('revision').action(async () => {
    owner();
    const settings = config();
    const file = claudeMemFile(settings, env);
    const { claudeMemRevision } = await import('../adapters/memory/claude-mem.ts');
    print({
      revision: settings.memory.claudeMem && file ? (claudeMemRevision(file) ?? null) : null,
    });
  });
  external.command('approve <file>').action((file) => {
    owner();
    if (readRuntimeManifest(paths()).state !== 'ready')
      throw new BosunError('unavailable', 'Runtime setup incomplete');
    print(
      approveClaudeMemReview(json(textInput(file, 65536)), project(cwd).id, paths(), config(), env),
    );
  });
  program
    .command('context <task>')
    .option('--budget <tokens>', '', Number)
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
  jobs.command('watch <id>').option('--terminal <handle>', 'Explicit owned local terminal to split.').action((id, opt) => {
    owner();
    const near = opt.terminal ?? env.ORCA_TERMINAL_HANDLE;
    return call('job.watch', { id, ...(near ? { near } : {}) });
  });
  jobs.command('watch-get <id>').action(id => { owner(); return call('job.watchGet', { id }); });
  jobs.command('watch-reconcile <id>').action(id => { owner(); return call('job.watchReconcile', { id }); });
  jobs.command('list').action(() => call('job.list', {}));
  for (const action of ['get', 'result', 'cancel', 'release'] as const)
    jobs.command(`${action} <id>`).action((id) => call(`job.${action}`, { id }));
  jobs
    .command('events')
    .option('--after <cursor>', '', Number, 0)
    .action((opt) => call('job.events', { after: opt.after }));
  jobs.command('retention').action(() => {
    owner();
    return call('job.retention', {});
  });
  jobs.command('policy <id>').action((id) => {
    owner();
    return call('job.policy', { id });
  });
  jobs
    .command('prune')
    .option('--limit <count>', '', Number)
    .action((opt) => {
      owner();
      return call('job.prune', { ...(opt.limit !== undefined ? { limit: opt.limit } : {}) });
    });
  jobs
    .command('wait <id>')
    .option('--timeout <milliseconds>', '', Number, 30000)
    .option('--progress', 'Print only bounded job state metadata as it changes.')
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
    .option('-f, --file <path>', 'Explicitly public task file, or - for stdin.')
    .option('-e, --host <host>')
    .option('--runner <runner>', 'Configured ACP runner: acp-<name>.')
    .option('--model <model>')
    .option('--effort <effort>')
    .option('--read-only')
    .option('--request-id <id>')
    .option('--watch', 'Open an optional Orca metadata observer for the queued job.')
    .option('--no-watch', 'Queue without an Orca pane.')
    .option('--operation <kind>')
    .option('--files <paths>')
    .option('--no-delegation')
    .option('--exact-model <model>')
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
    .description('Call a shared method for diagnostics.')
    .action((method, value) => call(method, json(value)));
  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    const normalized = rpcError(error);
    err(JSON.stringify({ error: normalized }) + '\n');
    return error instanceof BosunError ? error.exitCode : 1;
  }
}
