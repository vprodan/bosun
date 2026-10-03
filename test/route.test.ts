import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, bosun, mock } from './helpers.ts';

test('route hook: host hints, risk override, silent cases, fail-open', async () => {
  const sb = sandbox();
  const m = await mock();
  try {
    const env = sb.env({ ROUTER_URL: m.url });
    const hook = (prompt: string, host = 'claude', extra = {}) =>
      bosun(['route', '--hook', '--host', host], { env: { ...env, ...extra }, input: JSON.stringify({ prompt }) });

    const r = await hook('rename getCart to fetchCart in cart-service');
    const out = JSON.parse(r.out).hookSpecificOutput;
    assert.equal(out.hookEventName, 'UserPromptSubmit');
    assert.match(out.additionalContext, /suggests: local \(conf 0\.9, risk low\)/);
    assert.match(out.additionalContext, /bosun run -f -/);
    assert.match((await hook('implement retry logic for the sync job')).out, /bosun-worker/);
    assert.match((await hook('implement retry logic for the sync job', 'codex')).out, /bosun_worker/);
    const risky = await hook('implement refund in payment-service');
    assert.match(risky.out, /suggests: main/);
    assert.match(risky.out, /risk=high overrides worker/);
    for (const p of ['what does this thing do', '/help me with this', '!ls -la here', 'fix it', 'rename a to b #noroute']) {
      assert.equal((await hook(p)).out, '', `silent: ${p}`);
    }
    assert.equal((await hook('rename a to b in x', 'claude', { BOSUN_DEPTH: '1' })).out, '', 'silent inside executors');
    const down = await hook('rename a to b in x', 'claude', { ROUTER_URL: 'http://127.0.0.1:1' });
    assert.deepEqual([down.code, down.out], [0, ''], 'fail open when Kev is down');
    assert.equal((await bosun(['route', '--hook'], { env, input: 'not json' })).code, 0);

    const manual = await bosun(['route', 'rename foo to bar please'], { env });
    assert.equal(JSON.parse(manual.out).final, 'local');
    const stats = await bosun(['stats'], { env });
    assert.match(stats.out, /decisions/);
  } finally { await m.close(); sb.cleanup(); }
});

test('route eval/stats: threshold suggestion, corrupt log lines are skipped', async () => {
  const sb = sandbox();
  try {
    const dir = path.join(sb.home, '.bosun');
    fs.mkdirSync(dir, { recursive: true });
    const rows = [];
    const labels = [];
    for (let i = 0; i < 12; i++) {
      const right = i < 10;
      rows.push(JSON.stringify({ ts: i, id: `id${i}`, prompt: `p${i}`, lane: 'local', conf: right ? 0.9 : 0.3, risk: 'low', risk_conf: 0.3, ms: 10 + i, router: 'kev', final: 'local', why: '' }));
      labels.push(JSON.stringify({ id: `id${i}`, label: right ? 'local' : 'worker' }));
    }
    fs.writeFileSync(path.join(dir, 'route-log.jsonl'), rows.join('\n') + '\n{"half-writ\n');
    fs.writeFileSync(path.join(dir, 'route-labels.jsonl'), labels.join('\n') + '\n');
    const ev = await bosun(['eval'], { env: sb.env() });
    assert.equal(ev.code, 0, ev.err);
    assert.match(ev.out, /12 labeled\. raw router accuracy: 83%/);
    assert.match(ev.out, /suggested ROUTER_MIN_CONF=0\.4/);
    assert.match(ev.out, /worker->local/);
    const st = await bosun(['stats'], { env: sb.env() });
    assert.match(st.out, /^12 decisions/m);
  } finally { sb.cleanup(); }
});

test('route eval: with too few labels, says how many it needs', async () => {
  const sb = sandbox();
  try {
    const r = await bosun(['eval'], { env: sb.env() });
    assert.match(r.out, /only 0 labeled decisions: label at least 10/);
  } finally { sb.cleanup(); }
});
