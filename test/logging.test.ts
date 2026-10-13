import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getLogger, getConfig } from '@logtape/logtape';
import { sandbox } from './helpers.ts';
import { footprint } from './read-view-prototype.ts';
import { openRuntimeLog } from '../src/platform/logging.ts';
import { BosunError } from '../src/core/errors.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { parseRuntimeConfig } from '../src/platform/config.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { startDaemon } from '../src/app/daemon.ts';
import { DaemonOwner } from '../src/platform/daemon-owner.ts';
function fixture() { const sb = sandbox(); const dir = path.join(sb.root, 'logs'); fs.mkdirSync(dir, { mode: 0o700 }); return { sb, dir, file: path.join(dir, 'daemon.log') }; }
function entries(dir: string) {
  return Object.fromEntries(['.', ...fs.readdirSync(dir)].map(name => {
    const file = path.join(dir, name); const stat = fs.lstatSync(file, { bigint: true });
    return [name, { mode: String(stat.mode), size: String(stat.size), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
      data: stat.isFile() ? fs.readFileSync(file).toString('base64') : stat.isSymbolicLink() ? fs.readlinkSync(file) : null }];
  }));
}

test('actual installed LogTape/file/redaction emits closed JSON metadata and no console, raw error, path, account or content canaries', () => {
  const f = fixture(); const logging = openRuntimeLog({ file: f.file }); const consoleError = console.error; let consoleCalls = 0;
  let serialized = false;
  const nested = { password: 'PRIVATE secret', account: 'PRIVATE account', toJSON() { serialized = true; return 'PRIVATE serialized'; } };
  try {
    console.error = () => { consoleCalls++; throw Error('console sink must not be used'); };
    assert.ok(logging.record({ event: 'daemon.start', state: 'running' }));
    assert.ok(logging.record({ event: 'job.usage', state: 'running', tokensIn: 50, tokensOut: 12,
      prompt: 'PRIVATE prompt', nested: { account: 'PRIVATE account', auth: 'PRIVATE auth' }, get result(): never { throw Error('PRIVATE result getter'); } } as never));
    getLogger(['bosun', 'runtime']).info('PRIVATE raw message', { event: 'job.state', state: 'succeeded', prompt: 'PRIVATE prompt', result: 'PRIVATE result', tool: 'PRIVATE tool', file: 'PRIVATE file', path: 'PRIVATE path',
      nested, error: Object.assign(new Error('PRIVATE error', { cause: nested }), { name: 'PRIVATE error name' }) });
    assert.equal(logging.record({ event: 'PRIVATE arbitrary event' } as never), false);
    assert.equal(logging.record({ event: 'job.state', reason: 'PRIVATE error' } as never), false);
    assert.equal(consoleCalls, 0);
    assert.equal(serialized, false, 'untrusted toJSON hooks never run while projecting log metadata');
    const body = fs.readFileSync(f.file, 'utf8'); assert.doesNotMatch(body, /PRIVATE|prompt|result|tool|file|path|account|auth|error|password|nested/i);
    const rows = body.trim().split('\n').map(line => JSON.parse(line)); assert.equal(rows.length, 4);
    assert.deepEqual(rows[2], { schema: 1, at: rows[2].at, event: 'job.usage', state: 'running', tokensIn: 50, tokensOut: 12 });
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o600); logging.close(); assert.equal(getConfig(), null);
  } finally { console.error = consoleError; logging.close(); f.sb.cleanup(); }
});

test('native private rotation is bounded, each new leaf stays0600 and valid logs resume without unknown file adoption', () => {
  const f = fixture(); let logging = openRuntimeLog({ file: f.file, maxBytes: 1024, archives: 2 });
  try {
    for (let i = 0; i < 150; i++) assert.ok(logging.record({ event: 'job.usage', tokensIn: i, tokensOut: i + 1 }));
    logging.close();
    const names = fs.readdirSync(f.dir); assert.deepEqual(names.sort(), ['daemon.log', 'daemon.log.1', 'daemon.log.2']);
    for (const name of names) { const file = path.join(f.dir, name); assert.ok(fs.statSync(file).size <= 1024); assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]).event, 'log.open'); }
    logging = openRuntimeLog({ file: f.file, maxBytes: 1024, archives: 2 }); assert.ok(logging.record({ event: 'daemon.start', state: 'running' }));
    logging.close(); fs.writeFileSync(f.file + '.2', 'PRIVATE unknown archive'); const before = footprint(f.dir);
    assert.throws(() => openRuntimeLog({ file: f.file, maxBytes: 1024, archives: 2 }), (error) => error instanceof BosunError && error.message === 'Runtime logging unavailable'); assert.deepEqual(footprint(f.dir), before);
  } finally { logging.close(); f.sb.cleanup(); }
});

for (const bad of ['symlink', 'mode', 'unknown', 'directory'] as const) test(`log ${bad} is held without permission repair or content overwrite`, () => {
  const f = fixture();
  try {
    const outside = path.join(f.sb.root, 'outside'); fs.writeFileSync(outside, 'PRIVATE outside body');
    if (bad === 'symlink') fs.symlinkSync(outside, f.file);
    if (bad === 'mode') fs.writeFileSync(f.file, 'PRIVATE mode body', { mode: 0o644 });
    if (bad === 'unknown') fs.writeFileSync(f.file, 'PRIVATE unknown body', { mode: 0o600 });
    if (bad === 'directory') fs.mkdirSync(f.file, { mode: 0o700 });
    const before = { files: entries(f.dir), outside: fs.readFileSync(outside, 'utf8') };
    assert.throws(() => openRuntimeLog({ file: f.file }), (error) => error instanceof BosunError && !error.message.includes('PRIVATE'));
    assert.deepEqual({ files: entries(f.dir), outside: fs.readFileSync(outside, 'utf8') }, before); assert.equal(getConfig(), null);
  } finally { f.sb.cleanup(); }
});

test('post-open path replacement holds logging without touching the replacement; second global logger cannot steal first policy', () => {
  const f = fixture(); const logging = openRuntimeLog({ file: f.file });
  try {
    assert.throws(() => openRuntimeLog({ file: path.join(f.dir, 'second.log') }), BosunError); assert.equal(fs.existsSync(path.join(f.dir, 'second.log')), false);
    assert.ok(logging.record({ event: 'daemon.start' }));
    fs.renameSync(f.file, path.join(f.dir, 'saved.log')); fs.writeFileSync(f.file, 'PRIVATE unrelated replacement', { mode: 0o600 });
    const before = footprint(f.dir); assert.equal(logging.record({ event: 'job.state', state: 'succeeded' }), false);
    assert.equal(logging.state(), 'held'); assert.deepEqual(footprint(f.dir), before);
  } finally { logging.close(); f.sb.cleanup(); }
});

test('invalid wall clock never becomes a content-bearing initialization record or partial log leaf', () => {
  const f = fixture(); const clock = Date.now;
  try {
    Date.now = (() => 'PRIVATE-CLOCK-CANARY') as unknown as typeof clock;
    assert.throws(() => openRuntimeLog({ file: f.file }), BosunError);
    Date.now = clock; assert.equal(fs.existsSync(f.file), false); assert.equal(getConfig(), null);
  } finally { Date.now = clock; f.sb.cleanup(); }
});

test('actual daemon opens its structured log after owner admission; a losing start cannot append or steal logging policy', async () => {
  const sb = sandbox(); const paths = runtimePaths(sb.env({ BOSUN_SOCKET: path.join(process.env.BOSUN_TEST_RUN_ROOT!, `l${process.pid}_usage`) }));
  const config = parseRuntimeConfig(''); let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    await setupRuntime(paths, config);
    daemon = await startDaemon({ paths, config, runners: {}, admit: async () => ({ allowed: false, reason: 'approval' }) });
    assert.equal(daemon.status().logging, 'ready'); const file = path.join(paths.home, 'daemon.log'); const before = fs.readFileSync(file);
    await assert.rejects(startDaemon({ paths, config, runners: {} }), (error) => error instanceof BosunError && error.code === 'unavailable');
    assert.deepEqual(fs.readFileSync(file), before); assert.equal(daemon.status().state, 'running');
    const close = DaemonOwner.prototype.close; let checked = false;
    DaemonOwner.prototype.close = function() {
      try {
        const last = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').at(-1)!);
        assert.equal(last.event, 'daemon.stop'); assert.equal(getConfig(), null); checked = true;
      } finally { close.call(this); }
    };
    try { await daemon.close(); daemon = undefined; assert.equal(checked, true); }
    finally { DaemonOwner.prototype.close = close; }
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(rows.map(row => row.event), ['log.open', 'daemon.start', 'daemon.stop']); assert.equal(getConfig(), null);
  } finally { await daemon?.close(); sb.cleanup(); }
});
