import './bootstrap.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { sandbox, fresh, gitRepo } from './helpers.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { parseRuntimeConfig } from '../src/platform/config.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { externalSources, approveClaudeMemReview } from '../src/app/external-sources.ts';
import { claudeMemRevision } from '../src/adapters/memory/claude-mem.ts';
import { project } from '../src/platform/project.ts';
import { main } from '../src/app/cli.ts';
import { startDaemon } from '../src/app/daemon.ts';
import { BosunError } from '../src/core/errors.ts';

test('final external registry is inert; exact owner review metadata enables source context without observation copies and later source edits revoke it', async () => {
  const sb = sandbox(); fresh(sb); const workspace = gitRepo(sb, 'workspace'); const pid = project(workspace).id;
  const cm = path.join(sb.root, 'external.db'); const db = new SqliteDatabase(cm);
  db.exec(`CREATE TABLE schema_versions(id INTEGER PRIMARY KEY,version INTEGER,applied_at TEXT); INSERT INTO schema_versions VALUES(1,40,'fixture');
    CREATE TABLE observations(id INTEGER PRIMARY KEY,memory_session_id TEXT,project TEXT,title TEXT,subtitle TEXT,narrative TEXT,created_at_epoch INTEGER);
    CREATE TABLE session_summaries(id INTEGER PRIMARY KEY,memory_session_id TEXT,project TEXT,request TEXT,learned TEXT,completed TEXT,next_steps TEXT,created_at_epoch INTEGER);`);
  db.prepare('INSERT INTO observations VALUES(1,?,?,?,?,?,?)').run('native_s', 'NativeCase', 'Zebra strategy', '', 'Zebra strategy uses pnpm', 1000);
  db.prepare('INSERT INTO observations VALUES(2,?,?,?,?,?,?)').run('native_s', 'NativeCase', 'Zebra credential', '', 'api_key=' + 'x'.repeat(40), 1000); db.close();
  const socket = path.join(process.env.BOSUN_TEST_RUN_ROOT!, `cm${process.pid}`); const env = sb.env({ BOSUN_SOCKET: socket }); const paths = runtimePaths(env);
  const config = parseRuntimeConfig(`[memory]\nclaudeMemDb = ${JSON.stringify(cm)}\n`); await setupRuntime(paths, config);
  const sources = externalSources(config, paths, env); const ctx = { projectId: pid, linked: [], sessionId: null };
  let runtime: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    const original = fs.readFileSync(cm); const stamp = claudeMemRevision(cm);
    assert.deepEqual(await sources[0].search('zebra strategy', ctx, 20), []); assert.deepEqual(fs.readFileSync(cm), original);
    assert.equal(fs.existsSync(path.join(paths.home, 'claude-mem-review.json')), false);
    const records = [1, 2].map(id => ({ kind: 'observation', id, projectId: pid, nativeProject: 'NativeCase', nativeSessionId: 'native_s', createdAt: 1000, privacy: 'public', scope: 'project' }));
    const review = { schemaVersion: 1, revision: stamp, records };
    assert.deepEqual(approveClaudeMemReview(review, pid, paths, config, env), { records: 2 });
    const metadata = fs.readFileSync(path.join(paths.home, 'claude-mem-review.json'), 'utf8'); assert.equal(metadata.includes('pnpm'), false); assert.equal(metadata.includes('api_key'), false);
    const hits = await sources[0].search('zebra', ctx, 20); assert.equal(hits.length, 1); assert.equal(hits[0].id, 'cm_o1'); assert.ok(hits[0].text.includes('pnpm'));
    assert.deepEqual(fs.readFileSync(cm), original); assert.equal(claudeMemRevision(cm), stamp);
    assert.throws(() => approveClaudeMemReview(review, 'p_' + 'b'.repeat(16), paths, config, env), (error: unknown) => error instanceof BosunError && error.code === 'invalid');
    runtime = await startDaemon({ paths, config, runners: {}, externalSources: sources });
    let out = ''; let err = '';
    const code = await main(['context', 'zebra strategy'], { env, cwd: workspace, stdout: text => out += text, stderr: text => err += text }); assert.equal(code, 0, err);
    const result = JSON.parse(out); assert.ok(result.ids.includes('cm_o1')); assert.ok(result.text.includes('pnpm'));
    const ownerDb = new SqliteDatabase(paths.memory, { readOnly: true }); try { assert.equal(JSON.stringify(ownerDb.prepare('SELECT id,title,body FROM memories').all()).includes('pnpm'), false); } finally { ownerDb.close(); }
    const edit = new SqliteDatabase(cm); edit.prepare('UPDATE observations SET narrative=? WHERE id=1').run('Zebra changed content'); edit.close();
    assert.deepEqual(await sources[0].search('zebra', ctx, 20), []);
    const previous = fs.readFileSync(path.join(paths.home, 'claude-mem-review.json')); assert.throws(() => approveClaudeMemReview(review, pid, paths, config, env), (error: unknown) => error instanceof BosunError && error.code === 'unverified'); assert.deepEqual(fs.readFileSync(path.join(paths.home, 'claude-mem-review.json')), previous);
  } finally { await runtime?.close(); sources.forEach(source => source.close?.()); sb.cleanup(); }
});
