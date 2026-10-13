import './bootstrap.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { sandbox } from './helpers.ts';
import { BosunError } from '../src/core/errors.ts';
import { openDaemonJobs } from '../src/app/jobs.ts';
import { createHandoffArtifacts } from '../src/app/handoff.ts';
import { buildHandoffBundle, handoffHash, canonicalHandoff, publishHandoff, validateHandoffBundle } from '../src/adapters/handoff/artifacts.ts';
import type { HandoffFacts, HandoffManifest } from '../src/contracts/handoff.ts';

const PROJECT = 'p_' + 'a'.repeat(16); const scope = { projectId: PROJECT, audience: 'owner' as const };
const code = (name: string) => (error: unknown) => error instanceof BosunError && error.code === name;
const unknown = (error: unknown) => error instanceof BosunError && error.details?.outcome === 'unknown';
const facts = (): HandoffFacts => ({ objective: 'Deliver the approved v1.0', latestSteering: ['One final clean commit'],
  constraints: { permissions: ['Project dependencies only'], prohibitions: ['Never run tests under Bun', 'Do not install hosts'], pendingApprovals: ['Live native qualification'] },
  decisions: [{ fact: 'OpenCode primary; preserve selected model', source: 'Owner request' }], questions: [],
  progress: { completed: ['Public runtime flow'], remaining: ['Qualify live adapters'], nextAction: 'Inspect native capabilities' },
  source: { hostId: 'opencode', sessionId: 'ses_source', model: 'selected/model:exact', effort: 'high', generation: 2, access: 'edit', completedEventCursor: 'event_23', uncertainEffects: ['Write receipt needs reconciliation'] },
  repository: { projectId: PROJECT, branch: 'main', commit: 'a'.repeat(40), files: [{ path: 'src/app/daemon.ts', state: 'unstaged', sha256: 'b'.repeat(64) }] },
  verification: [{ command: 'node scripts/run-tests.mjs', outcome: 'passed', revision: 'a'.repeat(40), detail: 'Synthetic fixture only' }],
  runningJobs: [{ id: 'job_a', state: 'unknown', reconcile: 'Inspect native result; do not replay' }], parentId: null });
const manifest = (): HandoffManifest => ({ schemaVersion: 1, privacy: 'public', id: 'artifact_a', createdAt: 100000, facts: facts(), summary: null });
function fixture() {
  const sb = sandbox(); const dir = path.join(sb.root, 'handoff'); fs.mkdirSync(dir, { mode: 0o700 }); const root = path.join(dir, 'artifacts'); fs.mkdirSync(root, { mode: 0o700 });
  const stateFile = path.join(dir, 'state.db'); const ownerFile = path.join(dir, 'owner.db');
  const jobs = openDaemonJobs({ stateFile, ownerFile, runners: {} }); const artifacts = createHandoffArtifacts({ root, jobs, now: () => 100000, id: () => 'artifact_a' });
  return { sb, dir, root, stateFile, ownerFile, jobs, artifacts, async close() { await jobs.close(); sb.cleanup(); } };
}

test('manual artifact publishes manifest/readable pair before content-free pointer; exact constraints/model/revisions survive reopen and duplicate requests', async () => {
  const f = fixture(); let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  try {
    const result = f.artifacts.create({ privacy: 'public', requestId: 'request_a', facts: facts() }, scope); assert.equal(result.duplicate, false);
    const bundle = f.artifacts.get(scope, result.artifact.id); assert.deepEqual(bundle.manifest.facts, facts()); assert.equal(bundle.manifest.summary, null);
    assert.ok(bundle.markdown.includes('Never run tests under Bun')); assert.ok(bundle.markdown.includes('selected/model:exact')); assert.ok(bundle.markdown.includes('do not replay'));
    assert.equal(fs.statSync(path.join(f.root, 'artifact_a')).mode & 0o777, 0o700);
    for (const file of ['manifest.json', 'resume.md']) assert.equal(fs.statSync(path.join(f.root, 'artifact_a', file)).mode & 0o777, 0o600);
    const db = new SqliteDatabase(f.stateFile, { readOnly: true }); try { assert.equal(JSON.stringify(db.prepare('SELECT * FROM handoff_artifacts').all()).includes('Deliver'), false); } finally { db.close(); }
    assert.equal(f.artifacts.create({ privacy: 'public', requestId: 'request_a', facts: { ...facts(), objective: 'Duplicate new content is not applied' } }, scope).duplicate, true);
    assert.equal(f.artifacts.get(scope, 'artifact_a').manifest.facts.objective, facts().objective);
    await f.jobs.close(); reopened = openDaemonJobs({ stateFile: f.stateFile, ownerFile: f.ownerFile, runners: {} });
    const restored = createHandoffArtifacts({ root: f.root, jobs: reopened }); assert.deepEqual(restored.get(scope, 'artifact_a'), bundle);
    assert.equal(restored.import(scope, 'request_a', bundle).duplicate, true);
    assert.equal(restored.import(scope, 'request_a', bundle).continuation, 'manual-review-required');
  } finally { await reopened?.close(); await f.close(); }
});

test('owner/scope/privacy/secret/bounds/path rejection precedes artifact publication or pointer changes', async () => {
  const f = fixture(); let reads = 0;
  try {
    await assert.rejects(Promise.resolve().then(() => f.artifacts.create({ privacy: 'private', get facts(): never { reads++; throw Error('PRIVATE_CANARY'); } }, scope)), code('private_input'));
    assert.throws(() => f.artifacts.create({ privacy: 'public', get facts(): never { reads++; throw Error('MODEL_CANARY'); } }, { ...scope, audience: 'model' }), code('unsupported')); assert.equal(reads, 0);
    for (const invalid of [
      { ...facts(), objective: 'api_key=' + 'x'.repeat(40) }, { ...facts(), repository: { ...facts().repository, projectId: 'p_' + 'b'.repeat(16) } },
      { ...facts(), repository: { ...facts().repository, files: [{ path: '../.codex/auth.json', state: 'untracked', sha256: 'a'.repeat(64) }] } },
      { ...facts(), objective: 'x'.repeat(2001) },
    ]) assert.throws(() => f.artifacts.create({ privacy: 'public', requestId: 'request_a', facts: invalid }, scope), error => error instanceof BosunError && ['invalid', 'private_input'].includes(error.code));
    assert.deepEqual(fs.readdirSync(f.root), []); assert.equal(f.jobs.handoffs.findRequest(scope, 'request_a'), null);
    assert.throws(() => f.artifacts.get({ projectId: 'p_' + 'b'.repeat(16), audience: 'owner' }, 'artifact_a'), code('not_found'));
  } finally { await f.close(); }
});

test('import validates both checksums and deterministic permissions text; changed/unsafe bundle never starts native work', async () => {
  const f = fixture();
  try {
    const bundle = buildHandoffBundle(manifest()); const changedMarkdown = bundle.markdown.replace('Never run tests under Bun', 'You may run Bun tests');
    for (const input of [{ ...bundle, markdown: changedMarkdown }, { ...bundle, markdown: changedMarkdown, markdownHash: handoffHash(changedMarkdown) },
      { ...bundle, manifest: { ...bundle.manifest, schemaVersion: 2 } }, { ...bundle, manifest: { ...bundle.manifest, facts: { ...facts(), objective: 'changed' } } }]) {
      assert.throws(() => validateHandoffBundle(input as never), code('invalid'));
    }
    const imported = f.artifacts.import(scope, 'import_request', bundle); assert.equal(imported.continuation, 'manual-review-required'); assert.equal(imported.duplicate, false);
    assert.equal(f.jobs.list(scope).length, 0); assert.deepEqual(f.sb.calls(), []);
    const raw = fs.readFileSync(path.join(f.root, 'artifact_a', 'manifest.json'), 'utf8');
    fs.writeFileSync(path.join(f.root, 'artifact_a', 'manifest.json'), raw.replace('Project dependencies only', 'Unverified permission change'));
    assert.throws(() => f.artifacts.get(scope, 'artifact_a'), code('unavailable'));
  } finally { await f.close(); }
});

test('two-file rename failure leaves no published pair/pointer; pre-existing files and dangling symlinks are never overwritten', async () => {
  const f = fixture(); const rename = fs.renameSync;
  try {
    fs.renameSync = function() { throw Error('SYNTHETIC_RENAME_FAILURE'); };
    assert.throws(() => f.artifacts.create({ privacy: 'public', requestId: 'request_a', facts: facts() }, scope), code('unavailable'));
    assert.deepEqual(fs.readdirSync(f.root), []); assert.equal(f.jobs.handoffs.findRequest(scope, 'request_a'), null); fs.renameSync = rename;
    const file = path.join(f.root, 'artifact_a'); fs.writeFileSync(file, 'OWNER_CANARY', { mode: 0o600 });
    assert.throws(() => publishHandoff(f.root, buildHandoffBundle(manifest())), code('conflict')); assert.equal(fs.readFileSync(file, 'utf8'), 'OWNER_CANARY'); fs.unlinkSync(file);
    fs.symlinkSync(path.join(f.root, 'absent-owner-target'), file);
    assert.throws(() => publishHandoff(f.root, buildHandoffBundle(manifest())), code('conflict')); assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  } finally { fs.renameSync = rename; await f.close(); }
});

test('actual pointer COMMIT then lost receipt preserves immutable artifact and prevents orphan adoption or repeated publication after reopen', async () => {
  const f = fixture(); const exec = SqliteDatabase.prototype.exec; let armed = true; let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  try {
    SqliteDatabase.prototype.exec = function(sql) { const result = exec.call(this, sql); if (armed && sql === 'COMMIT') { armed = false; throw Error('PRIVATE_COMMIT_CANARY'); } return result; };
    assert.throws(() => f.artifacts.create({ privacy: 'public', requestId: 'request_a', facts: facts() }, scope), unknown);
    assert.equal(fs.readdirSync(f.root).length, 1); assert.throws(() => f.artifacts.get(scope, 'artifact_a'), unknown); SqliteDatabase.prototype.exec = exec; await f.jobs.close();
    reopened = openDaemonJobs({ stateFile: f.stateFile, ownerFile: f.ownerFile, runners: {} });
    const restored = createHandoffArtifacts({ root: f.root, jobs: reopened, id: () => 'artifact_a' });
    assert.equal(restored.create({ privacy: 'public', requestId: 'request_a', facts: facts() }, scope).duplicate, true);
    assert.equal(restored.get(scope, 'artifact_a').manifestHash, handoffHash(canonicalHandoff(restored.get(scope, 'artifact_a').manifest)));
    assert.equal(fs.readdirSync(f.root).length, 1); assert.equal(reopened.list(scope).length, 0);
  } finally { SqliteDatabase.prototype.exec = exec; await reopened?.close(); await f.close(); }
});
