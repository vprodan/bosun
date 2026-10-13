import crypto from 'node:crypto';
import { createElement as h, useEffect, useState } from 'react';
import { Box, Text, render, renderToString, useApp, useInput, useWindowSize } from 'ink';
import { z } from 'zod';
import { BosunError } from '../core/errors.ts';
import { screenPublicText } from '../core/secret-screen.ts';
import { callLocalRpc, streamLocalJobEvents } from '../adapters/transport/local-rpc.ts';
import type { RpcScope } from '../contracts/rpc.ts';
import { HOSTS } from '../core/domain/config.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const label = z.string().min(1).max(2000);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const state = z.enum(['queued', 'held', 'running', 'succeeded', 'failed', 'cancelled', 'unknown']);
const quotaState = z.enum(['available', 'blocked', 'unknown']);
// Project closed metadata only. Unexpected prompt/result/tool/auth fields are
// neither rendered nor copied into a retained dashboard snapshot.
const job = z.object({ id, runnerId: id, state, reason: z.enum(['quota', 'approval', 'admission_unavailable', 'runner_unavailable', 'unsupported',
  'cancel_requested', 'interrupted', 'runner_lost', 'output_limit', 'event_limit', 'runner_failed']).nullable(),
  version: z.number().int().min(1).optional(), cancelRequested: z.boolean().optional() });
const usage = z.object({ jobId: id, model: label.max(200), effort: label.max(80).nullable(), generation: z.number().int().min(1),
  tokensIn: count, tokensOut: count, kind: z.enum(['subscription', 'api', 'local', 'unknown']), qualification: z.enum(['verified', 'unverified']) });
const bucket = z.object({ source: z.enum(['codex-app-server', 'claude-statusline', 'opencode']), unit: z.enum(['work-codex', 'claude-subscription', 'api', 'local']),
  model: label.max(200).nullable(), state: quotaState, windows: z.array(z.object({ id: z.enum(['primary', 'secondary', 'short', 'weekly', 'spend']),
    durationMinutes: count, remainingPercent: z.number().min(0).max(100).nullable(), resetsAt: count, blocked: z.boolean() })).max(3) });
const snapshotSchema = z.object({ status: z.object({ state: z.enum(['running', 'held', 'draining']), primaryHost: z.enum(HOSTS), version: label.max(80) }),
  jobs: z.object({ jobs: z.array(job).max(20) }), quota: z.object({ state: quotaState, buckets: z.array(bucket).max(128) }),
  usage: z.object({ attempts: z.array(usage).max(100) }), artifacts: z.object({ artifacts: z.array(z.object({ id, createdAt: z.number().int().nonnegative() })).max(20) }) });
export type DashboardSnapshot = z.infer<typeof snapshotSchema>;
export type DashboardAction = { action: 'cancel' | 'release'; jobId: string; baseVersion: number | null;
  state: 'pending' | 'accepted' | 'held' | 'unknown' | 'failed' | 'observed';
  reason?: DashboardSnapshot['jobs']['jobs'][number]['reason'] | 'disconnected' | 'selection_unavailable' | 'action_unavailable' | 'response_unavailable' };
export type DashboardState = { connection: 'connecting' | 'connected' | 'disconnected'; stream: 'idle' | 'live' | 'ended'; snapshot: DashboardSnapshot | null; action?: DashboardAction };
function visible(value: string): string {
  try { screenPublicText(value); } catch { return 'withheld'; }
  return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 200);
}
export function dashboardSnapshot(value: unknown): DashboardSnapshot {
  const parsed = snapshotSchema.safeParse(value); if (!parsed.success) throw new BosunError('unavailable', 'Dashboard metadata unavailable');
  parsed.data.status.version = visible(parsed.data.status.version);
  for (const row of parsed.data.usage.attempts) { row.model = visible(row.model); if (row.effort) row.effort = visible(row.effort); }
  for (const row of parsed.data.quota.buckets) if (row.model) row.model = visible(row.model);
  return parsed.data;
}
export async function readDashboard(options: { socket: string; scope: RpcScope; signal?: AbortSignal }): Promise<DashboardSnapshot> {
  if (options.scope.audience !== 'owner') throw new BosunError('unsupported', 'Owner operation required');
  const fields = ['status', 'jobs', 'quota', 'usage', 'artifacts'] as const;
  const requests = [['daemon.status', {}], ['job.list', { limit: 20 }], ['quota.status', {}], ['usage.list', { limit: 100 }], ['handoff.list', { limit: 20 }]] as const;
  // Settle every metadata callback before reporting failure or closing the UI.
  const results = await Promise.allSettled(requests.map(([method, params]) => callLocalRpc({ socket: options.socket, signal: options.signal,
    request: { version: 1, id: crypto.randomUUID(), method, params, scope: options.scope } })));
  if (results.some(value => value.status === 'rejected')) throw new BosunError('unavailable', 'Dashboard disconnected');
  return dashboardSnapshot(Object.fromEntries(results.map((value, n) => [fields[n], (value as PromiseFulfilledResult<unknown>).value])));
}
export async function performDashboardAction(options: { socket: string; scope: RpcScope; value: DashboardState; jobId: string;
  action: 'cancel' | 'release'; signal?: AbortSignal }): Promise<DashboardAction> {
  if (options.scope.audience !== 'owner') throw new BosunError('unsupported', 'Owner operation required');
  if (!id.safeParse(options.jobId).success || !['cancel', 'release'].includes(options.action)) throw new BosunError('invalid', 'Invalid dashboard action');
  const selected = options.value.snapshot?.jobs.jobs.find(row => row.id === options.jobId);
  const result: DashboardAction = { action: options.action, jobId: options.jobId, baseVersion: selected?.version ?? null, state: 'held' };
  if (options.value.action?.state === 'unknown' && options.value.action.jobId === options.jobId) return options.value.action;
  if (options.value.connection !== 'connected') return { ...result, reason: 'disconnected' };
  if (!selected) return { ...result, reason: 'selection_unavailable' };
  if (options.value.snapshot!.status.state !== 'running' || (options.action === 'release' ? selected.state !== 'held'
    : !['queued', 'held', 'running'].includes(selected.state) || selected.cancelRequested === true)) return { ...result, reason: 'action_unavailable' };
  try {
    const response = job.parse(await callLocalRpc({ socket: options.socket, signal: options.signal, mutation: true,
      request: { version: 1, id: crypto.randomUUID(), method: options.action === 'cancel' ? 'job.cancel' : 'job.release', params: { id: options.jobId }, scope: options.scope } }));
    if (response.id !== options.jobId || response.version === undefined || result.baseVersion !== null && response.version < result.baseVersion) throw new BosunError('unavailable', '', { details: { outcome: 'unknown' } });
    return { ...result, state: response.state === 'held' ? 'held' : response.state === 'unknown' ? 'unknown' : 'accepted', reason: response.reason };
  } catch (error) {
    // A malformed/lost mutation reply never becomes another request. Only finite
    // metadata is retained; raw native/provider errors never enter the display.
    return { ...result, state: error instanceof BosunError && error.details?.outcome === 'unknown' || error instanceof z.ZodError ? 'unknown' : 'failed', reason: 'response_unavailable' };
  }
}
export function reconcileDashboardAction(value: DashboardState): DashboardAction | undefined {
  const action = value.action; if (action?.state !== 'unknown') return action;
  const row = value.snapshot?.jobs.jobs.find(row => row.id === action.jobId);
  return value.connection === 'connected' && action.baseVersion !== null && row?.version !== undefined && row.version > action.baseVersion && row.state !== 'unknown'
    ? { ...action, state: 'observed', reason: row.reason } : action;
}
const text = (value: string, key: string, color?: string) => h(Text, { key, wrap: 'truncate-end', ...(color ? { color } : {}) }, value);
export function DashboardView({ value, tab = 0, offset = 0, rows = 24, selectedId }: { value: DashboardState; tab?: number; offset?: number; rows?: number; selectedId?: string | null }) {
  const s = value.snapshot; const lines = [text(`bosun ${s?.status.version ?? ''} · ${s?.status.primaryHost ?? 'daemon'} · ${value.connection}${value.connection === 'disconnected' && s ? ' (last snapshot)' : ''}`, 'title', 'cyan')];
  lines.push(text(`1 Jobs   2 Quota   3 Usage   4 Handoffs   r Refresh   q Quit · events ${value.stream}`, 'keys'));
  if (!s) lines.push(text('Waiting for daemon metadata.', 'waiting'));
  else if (tab === 0) {
    lines.push(text(`Daemon ${s.status.state} · ${s.jobs.jobs.length} recent jobs`, 'status'));
    lines.push(text('↑↓ Select · c Cancel selected · l Release held · unknown outcomes require inspection', 'actions'));
    if (value.action) lines.push(text(`${value.action.action} ${visible(value.action.jobId)} · ${value.action.state}${value.action.reason ? ` · ${value.action.reason}` : ''}`, 'action', value.action.state === 'unknown' ? 'yellow' : undefined));
    if (!s.jobs.jobs.length) lines.push(text('No jobs in this project.', 'empty'));
    for (const row of s.jobs.jobs) {
      const selected = s.usage.attempts.find(attempt => attempt.jobId === row.id);
      lines.push(text(`${selectedId === row.id ? '>' : ' '} ${row.state.padEnd(10)} ${visible(row.runnerId)} ${visible(row.id)}${row.reason ? ` · ${row.reason}` : ''}${selected ? ` · ${selected.model}` : ''}`, row.id,
        ['held', 'unknown', 'failed'].includes(row.state) ? 'yellow' : undefined));
    }
  } else if (tab === 1) {
    lines.push(text(`Quota ${s.quota.state} · clock passage alone never clears a hold`, 'quota'));
    if (!s.quota.buckets.length) lines.push(text('No supported quota observation. Usage remains unknown.', 'empty'));
    for (let n = 0; n < s.quota.buckets.length; n++) {
      const row = s.quota.buckets[n]; lines.push(text(`${row.source} ${row.model ?? 'shared pool'} · ${row.state}`, `q${n}`));
      for (const window of row.windows) lines.push(text(`  ${window.id}${window.durationMinutes === null ? '' : ` (${window.durationMinutes} min)`}: ${window.remainingPercent === null ? 'unknown' : `${window.remainingPercent}%`}${window.blocked ? ' · held' : ''}`, `q${n}_${window.id}`, window.blocked ? 'yellow' : undefined));
    }
  } else if (tab === 2) {
    lines.push(text('Native attempt counts · missing components and billing stay unknown', 'usage'));
    if (!s.usage.attempts.length) lines.push(text('No native attempts in this project.', 'empty'));
    for (const row of s.usage.attempts.slice(0, 20)) lines.push(text(`${row.jobId} #${row.generation} ${row.model}${row.effort ? ` (${row.effort})` : ''} · in ${row.tokensIn ?? 'unknown'} / out ${row.tokensOut ?? 'unknown'} · billing ${row.qualification === 'verified' ? row.kind : 'unknown'}`, `${row.jobId}_${row.generation}`));
  } else {
    lines.push(text('Public task artifacts · import and continuation require manual review', 'handoffs'));
    if (!s.artifacts.artifacts.length) lines.push(text('No artifacts in this project.', 'empty'));
    for (const row of s.artifacts.artifacts) lines.push(text(visible(row.id), row.id));
  }
  const body = lines.slice(2); const capacity = Math.max(1, Math.min(100, rows - 3));
  const start = Math.max(0, Math.min(offset, Math.max(0, body.length - capacity)));
  return h(Box, { flexDirection: 'column' }, ...lines.slice(0, 2), ...body.slice(start, start + capacity),
    text(`Rows ${start + 1}–${Math.min(start + capacity, body.length)} of ${body.length} · ↑↓ ${tab === 0 ? 'select' : 'scroll'}`, 'position'));
}

export async function runDashboard(options: { socket: string; scope: RpcScope; once?: boolean; write?: (text: string) => void;
  stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream }): Promise<void> {
  if (options.scope.audience !== 'owner') throw new BosunError('unsupported', 'Owner operation required');
  if (options.once) {
    const snapshot = await readDashboard(options); (options.write ?? (value => { process.stdout.write(value); }))(
      renderToString(h(DashboardView, { value: { connection: 'connected', stream: 'idle', snapshot } })) + '\n'); return;
  }
  const stdin = options.stdin ?? process.stdin; const stdout = options.stdout ?? process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) throw new BosunError('invalid', 'Use dashboard --once outside an interactive terminal');
  const shutdown = new AbortController(); let streamAbort: AbortController | undefined; let cursor = 0;
  let state: DashboardState = { connection: 'connecting', stream: 'idle', snapshot: null };
  let refreshPromise: Promise<void> | null = null; let streamPromise: Promise<void> | null = null; let refreshAgain = false;
  let actionPromise: Promise<void> | null = null;
  const listeners = new Set<(state: DashboardState) => void>();
  const update = (changes: Partial<DashboardState>) => { if (shutdown.signal.aborted) return; state = { ...state, ...changes }; for (const fn of listeners) fn(state); };
  const refresh = (): Promise<void> => {
    if (shutdown.signal.aborted) return Promise.resolve();
    if (refreshPromise) { refreshAgain = true; return refreshPromise; }
    refreshPromise = (async () => {
      do {
        refreshAgain = false;
        try { update({ snapshot: await readDashboard({ ...options, signal: shutdown.signal }), connection: 'connected' }); }
        catch { update({ connection: 'disconnected' }); streamAbort?.abort(); }
      } while (refreshAgain && !shutdown.signal.aborted);
    })().finally(() => { refreshPromise = null; }); return refreshPromise;
  };
  const stream = () => {
    if (shutdown.signal.aborted || streamPromise || state.connection !== 'connected') return;
    streamAbort = new AbortController(); const signal = AbortSignal.any([shutdown.signal, streamAbort.signal]);
    streamPromise = (async () => {
      try {
        update({ stream: 'live' });
        for await (const event of streamLocalJobEvents({ socket: options.socket, signal,
          request: { version: 1, id: crypto.randomUUID(), method: 'job.events', params: { after: cursor, limit: 100 }, scope: options.scope } })) {
          cursor = event.seq; void refresh();
        }
        update({ stream: 'ended' });
      } catch { update({ stream: 'ended', ...(shutdown.signal.aborted || streamAbort?.signal.aborted ? {} : { connection: 'disconnected' as const }) }); }
    })().finally(() => { streamPromise = null; });
  };
  const action = (kind: DashboardAction['action'], jobId: string) => {
    if (actionPromise || shutdown.signal.aborted || state.action?.state === 'unknown' && state.action.jobId === jobId) return;
    const captured = state;
    update({ action: { action: kind, jobId, baseVersion: captured.snapshot?.jobs.jobs.find(row => row.id === jobId)?.version ?? null, state: 'pending' } });
    actionPromise = (async () => {
      try { update({ action: await performDashboardAction({ ...options, value: captured, jobId, action: kind, signal: shutdown.signal }) }); }
      catch { update({ action: { action: kind, jobId, baseVersion: null, state: 'failed', reason: 'response_unavailable' } }); }
      await refresh();
    })().finally(() => { actionPromise = null; });
  };
  function Screen() {
    const [value, setValue] = useState(state); const [tab, setTab] = useState(0); const [offset, setOffset] = useState(0);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const selected = selectedId ?? value.snapshot?.jobs.jobs[0]?.id ?? null;
    const app = useApp(); const size = useWindowSize();
    useEffect(() => { listeners.add(setValue); return () => { listeners.delete(setValue); }; }, []);
    useInput((input, key) => {
      if (input === 'q' || key.escape) { shutdown.abort(); app.exit(); }
      else if (input === 'r') void refresh().then(() => { update({ action: reconcileDashboardAction(state) }); stream(); });
      else if (/^[1-4]$/.test(input)) { setTab(Number(input) - 1); setOffset(0); }
      else if (tab === 0 && selected && ['c', 'l'].includes(input)) { setSelectedId(selected); action(input === 'c' ? 'cancel' : 'release', selected); }
      else if (tab === 0 && (key.downArrow || key.upArrow)) {
        const rows = value.snapshot?.jobs.jobs ?? []; const position = rows.findIndex(row => row.id === selected);
        const next = Math.max(0, Math.min(rows.length - 1, position < 0 ? 0 : position + (key.downArrow ? 1 : -1)));
        if (rows[next]) { setSelectedId(rows[next].id); setOffset(Math.max(0, next + (value.action ? 4 : 3) - Math.max(1, (size.rows ?? 24) - 3))); }
      }
      else if (key.downArrow) setOffset(value => Math.min(512, value + 1));
      else if (key.upArrow) setOffset(value => Math.max(0, value - 1));
    });
    return h(DashboardView, { value, tab, offset, selectedId: selected, rows: size.rows ?? 24 });
  }
  const ui = render(h(Screen), { stdin, stdout, stderr: options.stderr ?? process.stderr, patchConsole: false, maxFps: 10,
    interactive: true, incrementalRendering: true, alternateScreen: true, kittyKeyboard: { mode: 'disabled' } });
  const interval = setInterval(() => { if (state.connection === 'connected') void refresh(); }, 5000); interval.unref();
  try { await refresh(); stream(); await ui.waitUntilExit(); }
  finally { shutdown.abort(); streamAbort?.abort(); clearInterval(interval); ui.unmount(); await Promise.allSettled([refreshPromise, streamPromise, actionPromise]); ui.cleanup(); }
}
