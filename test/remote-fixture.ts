import './bootstrap.ts';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sandbox, fresh, gitRepo, REPO } from './helpers.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { parseRuntimeConfig, renderRuntimeConfig } from '../src/platform/config.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { startDaemon } from '../src/app/daemon.ts';
import { callLocalRpc } from '../src/adapters/transport/local-rpc.ts';
import { callRemoteRpc } from '../src/adapters/transport/remote-rpc.ts';
import { project } from '../src/platform/project.ts';
import { tlsFixture } from './tls-fixture.ts';

export const OWNER = 'Owner_A_remote_fixture_credential_'.repeat(2),
  MODEL = 'Model_A_remote_fixture_credential_'.repeat(2);
let serial = 0;
async function isolatedServer(
  sb: ReturnType<typeof sandbox>,
  env: Record<string, string>,
  toml: string,
  offset = 0,
) {
  const file = path.join(sb.root, `remote-host-${++serial}.mjs`);
  fs.writeFileSync(
    file,
    `
await import(${JSON.stringify(path.join(REPO, 'test/bootstrap.ts'))});
const {startDaemon}=await import(${JSON.stringify(path.join(REPO, 'src/app/daemon.ts'))});
const {parseRuntimeConfig}=await import(${JSON.stringify(path.join(REPO, 'src/platform/config.ts'))});
const {runtimePaths}=await import(${JSON.stringify(path.join(REPO, 'src/platform/paths.ts'))});
const runtime=await startDaemon({paths:runtimePaths(process.env),config:parseRuntimeConfig(${JSON.stringify(toml)}),environment:process.env,runners:{},remotePort:0,remoteNow:()=>Date.now()+${offset}});
process.send({ready:runtime.status()});
process.on('message',async command=>{
  if(command.close){await runtime.close();process.exit(0);}
  if(command.modelToken){process.env.BOSUN_REMOTE_MODEL_TOKEN=command.modelToken;process.send({updated:true});}
});
`,
  );
  const child = spawn(process.execPath, [file], {
    env,
    cwd: sb.root,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr!.on('data', (bytes) => {
    stderr += bytes;
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const status = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Remote fixture startup timeout')), 5000);
    child.once('message', (message: any) => {
      clearTimeout(timer);
      resolve(message.ready);
    });
    child.once('error', reject);
    child.once('exit', () => {
      clearTimeout(timer);
      reject(Error(stderr));
    });
  }).catch(async (error) => {
    child.kill('SIGKILL');
    await closed;
    throw error;
  });
  return {
    status: () => status,
    async setModelToken(value: string) {
      await new Promise<void>((resolve) => {
        child.once('message', () => resolve());
        child.send({ modelToken: value });
      });
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.send({ close: true });
      await closed;
    },
  };
}
export async function remoteFixture(
  tls = false,
  clientAuthority?: (endpoint: string) => Promise<string>,
  serverSettings = '',
  clientSettings = '',
  serverAllow?: readonly string[],
) {
  const sb = sandbox();
  fresh(sb);
  const serverWorkspace = gitRepo(sb, 'server-checkout', 'git@example.com:team/remote.git');
  const clientWorkspace = gitRepo(sb, 'client-checkout', 'git@example.com:team/remote.git');
  const otherWorkspace = gitRepo(sb, 'other-checkout', 'git@example.com:team/other.git');
  const serverEnv = sb.env({
    BOSUN_HOME: path.join(sb.root, 'server'),
    BOSUN_SOCKET: path.join(process.env.BOSUN_TEST_RUN_ROOT!, `rms${process.pid}_${++serial}`),
    BOSUN_REMOTE_TOKEN: OWNER,
    BOSUN_REMOTE_MODEL_TOKEN: MODEL,
  });
  const clientEnv = sb.env({
    BOSUN_HOME: path.join(sb.root, 'client'),
    BOSUN_SOCKET: path.join(process.env.BOSUN_TEST_RUN_ROOT!, `rmc${process.pid}_${++serial}`),
    BOSUN_REMOTE_TOKEN: OWNER,
    BOSUN_REMOTE_MODEL_TOKEN: MODEL,
  });
  const serverPaths = runtimePaths(serverEnv),
    clientPaths = runtimePaths(clientEnv);
  const certificates = tls ? tlsFixture(sb.root) : null;
  const serverConfig = parseRuntimeConfig(
    `[remote]\nenabled=true\n${serverAllow ? `allow=${JSON.stringify(serverAllow)}\n` : ''}${certificates ? `[remote.tls]\nkeyFile=${JSON.stringify(certificates.keyFile)}\ncertFile=${JSON.stringify(certificates.certFile)}\n` : ''}[[remote.projects]]\nworkspace=${JSON.stringify(serverWorkspace)}\n${serverSettings}`,
  );
  let server: Awaited<ReturnType<typeof isolatedServer>> | undefined,
    client: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    const manifest = await setupRuntime(serverPaths, serverConfig);
    server = await isolatedServer(sb, serverEnv, renderRuntimeConfig(serverConfig));
    const endpoint = server.status().remote.endpoint!;
    const authority = clientAuthority ? await clientAuthority(endpoint) : endpoint;
    const clientConfig = parseRuntimeConfig(
      `[remote]\nauthority=${JSON.stringify(authority)}\nauthorityId=${JSON.stringify(manifest.installationId)}\ntimeoutMs=1000\n${certificates ? `caFile=${JSON.stringify(certificates.certFile)}\n` : ''}${clientSettings}`,
    );
    await setupRuntime(clientPaths, clientConfig);
    const clientOptions = {
      paths: clientPaths,
      config: clientConfig,
      environment: clientEnv,
      runners: {},
    };
    client = await startDaemon(clientOptions);
    const rpc = (
      side: 'server' | 'client',
      method: string,
      params: Record<string, unknown>,
      audience: 'owner' | 'model' = 'owner',
      workspace = side === 'server' ? serverWorkspace : clientWorkspace,
    ) =>
      callLocalRpc<any>({
        socket: (side === 'server' ? serverPaths : clientPaths).socket,
        request: {
          version: 1,
          id: `rm_${++serial}`,
          method,
          params,
          scope: { workspace, sessionId: null, audience },
        },
      });
    const wire = (
      method: string,
      params: Record<string, unknown>,
      audience: 'owner' | 'model' = 'owner',
      projectId = project(clientWorkspace).id,
    ) => ({
      version: 1 as const,
      id: `wire_${++serial}`,
      method,
      params,
      scope: { projectId, sessionId: null, audience },
    });
    const direct = (
      method: string,
      params: Record<string, unknown>,
      audience: 'owner' | 'model' = 'owner',
      settings = clientConfig.remote,
      env = clientEnv,
    ) =>
      callRemoteRpc<any>({
        settings,
        env,
        projectId: project(clientWorkspace).id,
        request: {
          version: 1,
          id: `direct_${++serial}`,
          method,
          params,
          scope: { workspace: clientWorkspace, sessionId: null, audience },
        },
        signal: AbortSignal.timeout(2000),
      });
    return {
      sb,
      serverEnv,
      clientEnv,
      serverPaths,
      clientPaths,
      serverWorkspace,
      clientWorkspace,
      otherWorkspace,
      serverConfig,
      clientConfig,
      manifest,
      endpoint,
      rpc,
      wire,
      direct,
      get server() {
        return server!;
      },
      get client() {
        return client!;
      },
      async restartClient() {
        await client!.close();
        client = await startDaemon(clientOptions);
      },
      async restartServer(offset = 0) {
        await server!.close();
        server = await isolatedServer(sb, serverEnv, renderRuntimeConfig(serverConfig), offset);
      },
      async close() {
        try {
          await client?.close();
          await server?.close();
        } finally {
          sb.cleanup();
        }
      },
    };
  } catch (error) {
    await client?.close();
    await server?.close();
    sb.cleanup();
    throw error;
  }
}
