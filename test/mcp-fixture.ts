import './bootstrap.ts';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { BIN } from './helpers.ts';
import type { Env } from '../src/core/domain/inference.ts';

// Final SDK/protocol only. Scope comes from the child root, never tool arguments.
export async function mcpFixture(env: Env, workspace: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, 'mcp'],
    cwd: workspace,
    env: Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
    stderr: 'pipe',
    maxBufferSize: 1048576,
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => (stderr += chunk));
  const client = new Client(
    { name: 'bosun-final-regression', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close();
    await transport.close();
    throw error;
  }
  return {
    client,
    stderr: () => stderr,
    async call(name: string, args: Record<string, unknown>) {
      return client.callTool({ name, arguments: args });
    },
    async close() {
      try {
        await client.close();
      } finally {
        await transport.close();
      }
    },
  };
}
