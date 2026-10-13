import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { METHODS } from '../contracts/methods.ts';
import { rpcError, RPC_LIMITS, type RpcScope } from '../contracts/rpc.ts';
import { callLocalRpc } from '../adapters/transport/local-rpc.ts';
import type { RuntimePaths } from '../platform/paths.ts';
import { version } from '../platform/assets.ts';
import { BosunError } from '../core/errors.ts';

export const MCP_REPLY_BYTES = 20000;
function boundedResult(result: Record<string, unknown>, method: string, mutation: boolean) {
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  if (bytes(result) <= MCP_REPLY_BYTES) return result;
  const fit = <T>(values: T[], build: (prefix: T[]) => Record<string, unknown>) => {
    let low = 0; let high = values.length;
    while (low < high) { const middle = Math.ceil((low + high) / 2); if (bytes(build(values.slice(0, middle))) <= MCP_REPLY_BYTES) low = middle; else high = middle - 1; }
    const candidate = build(values.slice(0, low)); return bytes(candidate) <= MCP_REPLY_BYTES ? candidate : null;
  };
  const field = method === 'memory.search' ? 'hits' : method === 'graph.query' ? 'items' : null;
  if (field && Array.isArray(result[field])) {
    const candidate = fit(result[field], values => ({ ...result, [field]: values, truncated: true })); if (candidate) return candidate;
  }
  const textField = method === 'context.retrieve' ? 'text' : method === 'job.result' ? 'result' : null;
  if (textField && typeof result[textField] === 'string') {
    const candidate = fit(Array.from(result[textField]), values => ({ ...result, [textField]: values.join(''), truncated: true })); if (candidate) return candidate;
  }
  if (mutation && result.memory && typeof result.memory === 'object') {
    const memory = result.memory as Record<string, unknown>;
    // The positive scoped mutation receipt is retained even when its public body
    // exceeds the display budget. It does not become a false failed operation.
    if (typeof memory.id === 'string' && memory.id.length <= 64 && Number.isSafeInteger(memory.version) && memory.private === false) {
      return { memory: { id: memory.id, version: memory.version, private: false }, ...(typeof result.duplicate === 'boolean' ? { duplicate: result.duplicate } : {}), truncated: true };
    }
  }
  return { error: rpcError(new BosunError('unavailable', '', mutation ? { details: { outcome: 'unknown' } } : undefined)), truncated: true };
}

// Only this explicit composition loads the SDK. The bridge opens no SQLite DB,
// starts no daemon and binds model scope outside the tool argument schemas.
export function startMcpBridge(options: { paths: RuntimePaths; scope: Omit<RpcScope, 'audience'> }) {
  const scope: RpcScope = Object.freeze({ ...options.scope, audience: 'model' });
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: RPC_LIMITS.requestBytes });
  return serveStdio(() => {
    const server = new McpServer({ name: 'bosun', version }, { capabilities: { tools: {} },
      instructions: 'Use public scoped memory/context before assuming how a project works. Save durable facts only with user agreement; never secrets. Responses marked truncated contain partial content. Unknown job or mutation outcomes require inspection, never automatic replay.' });
    for (const [method, definition] of Object.entries(METHODS)) {
      if (!definition.tool || definition.ownerOnly) continue;
      server.registerTool(definition.tool, { description: definition.description,
        inputSchema: definition.modelSchema ?? definition.schema,
        annotations: { readOnlyHint: !definition.mutation, destructiveHint: definition.mutation === true, idempotentHint: !definition.mutation, openWorldHint: definition.inference === true } },
      async (params, context) => {
        try {
          const reply = await callLocalRpc<Record<string, unknown>>({ socket: options.paths.socket, mutation: definition.mutation,
            signal: context.mcpReq.signal, request: { version: 1, id: crypto.randomUUID(), method, params: params as Record<string, unknown>, scope } });
          const result = boundedResult(reply, method, definition.mutation === true);
          return { ...('error' in result ? { isError: true } : {}), content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
        } catch (error) {
          const result = { error: rpcError(error) };
          return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
        }
      });
    }
    return server;
  }, { transport, maxSubscriptions: 64, onerror() { /* finite tool errors travel on protocol; no exception/prompt logs */ } });
}
