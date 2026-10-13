import './bootstrap.ts';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sandbox, fresh, gitRepo } from './helpers.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { parseRuntimeConfig } from '../src/platform/config.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { startDaemon } from '../src/app/daemon.ts';
import { main } from '../src/app/cli.ts';
import { callLocalRpc } from '../src/adapters/transport/local-rpc.ts';
import type { RpcRequest, RpcScope } from '../src/contracts/rpc.ts';
import type { AgentRunner } from '../src/core/ports/runner.ts';
import type { NotificationSink } from '../src/core/domain/notifications.ts';
import type { WorkspaceCard } from '../src/core/ports/workspace.ts';
import type { Admission } from '../src/core/domain/job.ts';

let sequence = 0;
export async function runtimeFixture(
  toml = '',
  options: {
    runner?: AgentRunner;
    runners?: Parameters<typeof startDaemon>[0]['runners'];
    notificationSink?: () => NotificationSink;
    watchDriver?: (
      workspace: string,
      env: Readonly<Record<string, string | undefined>>,
    ) => import('../src/core/ports/workspace.ts').WorkspaceWatch;
    watchObserver?: Parameters<typeof startDaemon>[0]['watchObserver'];
    cardDriver?: (
      workspace: string,
      env: Readonly<Record<string, string | undefined>>,
    ) => WorkspaceCard;
    beforeStart?(paths: ReturnType<typeof runtimePaths>, workspace: string): void;
    env?: Record<string, string>;
    suggestionAdmit?(providerId: string, model: string, signal: AbortSignal): Promise<Admission>;
  } = {},
) {
  const sb = sandbox();
  fresh(sb);
  const workspace = gitRepo(sb, 'workspace');
  const socket = path.join(process.env.BOSUN_TEST_RUN_ROOT!, `e${process.pid}_${++sequence}`);
  const env = sb.env({ ...options.env, BOSUN_SOCKET: socket });
  const paths = runtimePaths(env);
  const config = parseRuntimeConfig(toml);
  let runtime: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    const manifest = await setupRuntime(paths, config);
    options.beforeStart?.(paths, workspace);
    let calls = 0;
    const runner: AgentRunner = options.runner ?? {
      id: 'codex',
      caps: {
        vendor: 'synthetic',
        readOnly: 'verified',
        sandbox: 'tool-allowlist',
        mcpInject: 'unsupported',
        effort: 'verified',
        localBackend: 'unsupported',
        billing: 'unknown',
      },
      detect: async () => ({ installed: true }),
      async *run(spec) {
        calls++;
        assert.equal(spec.cwd, workspace);
        assert.equal(spec.model, 'PINNED');
        yield { t: 'done', code: 0, result: 'Completed public task' };
      },
    };
    runtime = await startDaemon({
      paths,
      config,
      runners: options.runners ?? { codex: () => runner },
      admit: async () => ({ allowed: true }),
      notificationSink: options.notificationSink,
      cardDriver: options.cardDriver?.(workspace, env),
      watchDriver: options.watchDriver?.(workspace, env),
      watchObserver: options.watchObserver,
      environment: env,
      suggestionAdmit: options.suggestionAdmit,
    });
    const scope: RpcScope = { workspace, sessionId: null, audience: 'owner' };
    async function scopedRpc<T = any>(
      method: string,
      params: Record<string, unknown>,
      caller: RpcScope = scope,
    ) {
      const request: RpcRequest = {
        version: 1,
        id: `r${++sequence}`,
        method,
        params,
        scope: caller,
      };
      return callLocalRpc<T>({ socket, request });
    }
    async function cli(args: string[]) {
      let out = '';
      let err = '';
      const code = await main(args, {
        env,
        cwd: workspace,
        stdout: (text) => (out += text),
        stderr: (text) => (err += text),
      });
      return { code, out, err };
    }
    const activeRuntime = runtime;
    return {
      sb,
      env,
      paths,
      workspace,
      manifest,
      runtime: activeRuntime,
      scope,
      rpc: scopedRpc,
      cli,
      calls: () => calls,
      async close() {
        try {
          await activeRuntime.close();
        } finally {
          sb.cleanup();
        }
      },
    };
  } catch (error) {
    try {
      await runtime?.close();
    } finally {
      sb.cleanup();
    }
    throw error;
  }
}
