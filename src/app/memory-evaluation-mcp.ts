import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Env } from '../core/domain/inference.ts';
import type { Ctx } from '../core/domain/memory.ts';
import type { MemoryEvalArm } from '../core/use-cases/evaluate-memory.ts';
import { BosunError } from '../core/errors.ts';
import { project } from '../platform/project.ts';
import { benchmarkDistribution } from '../core/memory-benchmark.ts';

const identity = z.strictObject({
  source: z.enum(['curated', 'graph', 'vectors']),
  id: z.string().min(1).max(100),
});
const response = z.strictObject({
  text: z.string().max(16000),
  estTokens: z.number().int().min(0),
  ids: z.array(z.string().min(1).max(100)).max(1000),
  sources: z.record(z.string(), z.number().int().min(0)),
  ms: z.number().finite().min(0),
  items: z.array(identity).max(1000),
  candidates: z.array(identity).max(20),
});

// Actual installed SDK -> final Node stdio bridge -> owned daemon, with each
// client's model scope bound outside tool arguments. Only an explicitly selected
// vector arm permits query inference; this client never retries failed calls.
export function evaluationMcp(options: {
  env: Env;
  workspaces: ReadonlyMap<string | null, { workspace: string; projectId: string }>;
  valid(): boolean;
}) {
  type Peer = {
    client: Client;
    transport: StdioClientTransport;
    workspace: string;
    projectId: string;
    stamp: string;
  };
  const peers = new Map<string, Peer>(),
    replyBytes: number[] = [],
    replyEstimates: number[] = [];
  let calls = 0,
    created = 0;
  const stamp = (workspace: string) => {
    const stat = fs.lstatSync(workspace, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}`;
  };
  const live = (peer?: Peer) => {
    if (
      !options.valid() ||
      (peer &&
        (stamp(peer.workspace) !== peer.stamp || project(peer.workspace).id !== peer.projectId))
    )
      throw new BosunError('conflict', 'MCP evaluation source changed');
  };
  const closePeer = async (peer: Peer) => {
    try {
      await peer.client.close();
    } finally {
      await peer.transport.close();
    }
  };
  async function peerFor(ctx: Ctx) {
    live();
    const binding = options.workspaces.get(ctx.projectId);
    if (!binding) throw new BosunError('invalid', 'MCP evaluation scope unavailable');
    const key = JSON.stringify([ctx.projectId, ctx.sessionId]);
    const old = peers.get(key);
    if (old) {
      live(old);
      return old;
    }
    if (peers.size >= 8) {
      const first = peers.entries().next().value;
      if (first) {
        peers.delete(first[0]);
        await closePeer(first[1]);
      }
    }
    const env = {
      ...options.env,
      BOSUN_SESSION_ID: ctx.sessionId ?? '',
      BOSUN_AUDIENCE: 'model',
      NODE_DISABLE_COMPILE_CACHE: '1',
      NODE_OPTIONS: '',
    };
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(import.meta.dirname, '../../bin/bosun'), 'mcp'],
      cwd: binding.workspace,
      env: Object.fromEntries(
        Object.entries(env).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
      stderr: 'pipe',
      maxBufferSize: 1048576,
    });
    const client = new Client(
      { name: 'bosun-memory-evaluation', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    transport.stderr?.on('data', () => {}); // Child errors are finite protocol failures, never corpus/transcript logs.
    const peer = { client, transport, ...binding, stamp: stamp(binding.workspace) };
    try {
      live(peer);
      await client.connect(transport);
      live(peer);
    } catch (error) {
      await closePeer(peer);
      throw error;
    }
    peers.set(key, peer);
    created++;
    return peer;
  }
  const arm = (sources: string[]): MemoryEvalArm => {
    const retrieve = async (text: string, ctx: Ctx, budgetTokens: number) => {
      const peer = await peerFor(ctx);
      live(peer);
      calls++;
      const result = await peer.client.callTool(
        {
          name: 'context_retrieve',
          arguments: {
            task: text,
            sources,
            budgetTokens,
            includeCandidates: true,
            ...(sources.includes('vectors') ? { privacy: 'public' } : {}),
          },
        },
        { timeout: 10000 },
      );
      live(peer);
      if (result.isError) throw new BosunError('unavailable', 'MCP evaluation request failed');
      const parsed = response.safeParse(result.structuredContent);
      if (
        !parsed.success ||
        parsed.data.ids.length !== parsed.data.items.length ||
        parsed.data.ids.some((id, i) => id !== parsed.data.items[i].id)
      )
        throw new BosunError('unavailable', 'MCP evaluation reply unavailable');
      const bytes = JSON.stringify(result);
      replyBytes.push(Buffer.byteLength(bytes));
      replyEstimates.push(Math.ceil(bytes.length / 4));
      return parsed.data;
    };
    return {
      raw: async (text, ctx) => (await retrieve(text, ctx, 50)).candidates,
      retrieve: async (text, ctx, settings) => retrieve(text, ctx, settings.budgetTokens),
    };
  };
  return {
    arm,
    report: () => ({
      transport: 'native-node-stdio',
      protocol: '2026-07-28',
      calls,
      clientsCreated: created,
      maximumClients: 8,
      replyBytes: benchmarkDistribution(replyBytes),
      replyEstimates: {
        estimator: 'char/4',
        maximum: Math.max(0, ...replyEstimates),
        hostTokens: 'unverified',
      },
    }),
    async close() {
      let error: unknown;
      for (const peer of peers.values())
        try {
          await closePeer(peer);
        } catch (e) {
          error ??= e;
        }
      peers.clear();
      if (error) throw error;
    },
  };
}
