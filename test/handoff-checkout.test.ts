import './bootstrap.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sandbox, gitRepo } from './helpers.ts';
import { project } from '../src/platform/project.ts';
import { inspectHandoffCheckout } from '../src/platform/handoff-checkout.ts';

const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
test('portable checkout checks loose/packed/detached heads and file hashes without Git changes, symlink reads or claiming staged blobs', () => {
  const sb = sandbox(); const workspace = gitRepo(sb, 'workspace', 'https://example.invalid/owner/repo.git');
  try {
    const git = path.join(workspace, '.git'); const commit = fs.readFileSync(path.join(git, 'refs/heads/main'), 'utf8').trim();
    const file = path.join(workspace, 'public.txt'); fs.writeFileSync(file, 'Public source'); fs.symlinkSync(file, path.join(workspace, 'linked.txt'));
    const facts = { repository: { projectId: project(workspace).id, commit, branch: 'main', files: [
      { path: 'public.txt', state: 'unstaged' as const, sha256: hash('Public source') },
      { path: 'missing.txt', state: 'untracked' as const, sha256: hash('Not transferred') },
      { path: 'linked.txt', state: 'untracked' as const, sha256: hash('Public source') },
      { path: 'public.txt', state: 'staged' as const, sha256: hash('Different index blob') },
    ] } };
    const head = fs.readFileSync(path.join(git, 'HEAD')); const branch = fs.readFileSync(path.join(git, 'refs/heads/main'));
    const result = inspectHandoffCheckout(workspace, facts);
    assert.equal(result.base, 'matches'); assert.equal(result.branch, 'matches'); assert.deepEqual(result.files.map(file => file.state), ['matches', 'unavailable', 'unavailable', 'requires-index-validation']);
    assert.equal(result.continuation, 'manual-review-required'); assert.deepEqual(fs.readFileSync(path.join(git, 'HEAD')), head); assert.deepEqual(fs.readFileSync(path.join(git, 'refs/heads/main')), branch);
    fs.writeFileSync(file, 'Owner changed content'); assert.equal(inspectHandoffCheckout(workspace, facts).files[0].state, 'mismatch');
    assert.equal(inspectHandoffCheckout(workspace, { repository: { ...facts.repository, commit: 'a'.repeat(40) } }).base, 'mismatch');
    fs.writeFileSync(path.join(git, 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${commit} refs/heads/main\n`); fs.unlinkSync(path.join(git, 'refs/heads/main'));
    assert.equal(inspectHandoffCheckout(workspace, facts).base, 'matches');
    fs.writeFileSync(path.join(git, 'HEAD'), commit + '\n'); const detached = inspectHandoffCheckout(workspace, facts); assert.equal(detached.base, 'matches'); assert.equal(detached.branch, 'mismatch');
    fs.writeFileSync(path.join(git, 'HEAD'), 'unsupported head metadata\n'); assert.equal(inspectHandoffCheckout(workspace, facts).base, 'unverified');
    assert.throws(() => inspectHandoffCheckout(workspace, { repository: { ...facts.repository, projectId: 'p_' + 'b'.repeat(16) } }), /project mismatch/);
  } finally { sb.cleanup(); }
});

test('portable worktree metadata reads common refs while retaining the selected worktree HEAD', () => {
  const sb = sandbox(); const common = gitRepo(sb, 'clone', 'https://example.invalid/owner/repo.git'); const workspace = path.join(sb.root, 'worktree'); fs.mkdirSync(workspace);
  try {
    const git = path.join(common, '.git'); const administrative = path.join(git, 'worktrees', 'selected'); fs.mkdirSync(administrative, { recursive: true });
    fs.writeFileSync(path.join(workspace, '.git'), `gitdir: ${administrative}\n`); fs.writeFileSync(path.join(administrative, 'commondir'), '../..\n'); fs.writeFileSync(path.join(administrative, 'HEAD'), 'ref: refs/heads/main\n');
    const commit = fs.readFileSync(path.join(git, 'refs/heads/main'), 'utf8').trim();
    const result = inspectHandoffCheckout(workspace, { repository: { projectId: project(workspace).id, commit, branch: 'main', files: [] } }); assert.equal(result.base, 'matches'); assert.equal(result.branch, 'matches');
  } finally { sb.cleanup(); }
});
