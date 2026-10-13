import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sandbox, type Sandbox } from './helpers.ts';
import { BosunError } from '../src/core/errors.ts';
import { CLAUDE_VERSION } from '../src/adapters/hosts/claude/runner.ts';
import { bindClaudeTranscript, readClaudeTranscript, readClaudeTranscriptSeed, CLAUDE_TRANSCRIPT_LIMITS } from '../src/adapters/hosts/claude/transcript.ts';
import { captureClaudeEvidence } from '../src/adapters/hosts/claude/evidence.ts';
import type { ManagedSession } from '../src/core/domain/session.ts';

const sha = (body: string | Buffer) => crypto.createHash('sha256').update(body).digest('hex');
const sessionId = '11111111-1111-4111-8111-111111111111';
const seedId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const assistantId = '44444444-4444-4444-8444-444444444444';
const model = 'claude-sonnet-fixture';
const seedText = 'Public constraints: preserve the original job and wait for ownership transfer.';
const unknown = (error: unknown) => error instanceof BosunError && error.code === 'unverified'
  && !/CANARY|password|\/projects\//.test(JSON.stringify(error));
function fixture(sb: Sandbox) {
  const home = path.join(sb.home, 'assigned-claude'), cwd = path.join(sb.home, 'workspace');
  const project = path.join(home, 'projects', 'bosun-' + sessionId);
  fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(cwd, { mode: 0o755 });
  fs.mkdirSync(path.join(home, 'projects'), { mode: 0o700 }); fs.mkdirSync(project, { mode: 0o700 });
  const file = path.join(project, sessionId + '.jsonl');
  const user = (uuid = seedId, text = seedText, parentUuid: string | null = null) => ({
    type: 'user', uuid, parentUuid, isSidechain: false, cwd, sessionId, version: CLAUDE_VERSION,
    timestamp: '2026-10-11T12:00:00Z', userType: 'external', gitBranch: 'fixture',
    message: { role: 'user', content: text },
  });
  const assistant = (text = 'Public assistant answer', uuid = assistantId, parentUuid = userId) => ({
    type: 'assistant', uuid, parentUuid, isSidechain: false, cwd, sessionId, version: CLAUDE_VERSION,
    timestamp: '2026-10-11T12:01:00Z', requestId: 'req_fixture',
    message: { id: 'msg_fixture', type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 } },
  });
  const write = (rows: unknown[]) => fs.writeFileSync(file, rows.map(row => JSON.stringify(row) + '\n').join(''), { mode: 0o600 });
  const append = (rows: unknown[]) => fs.appendFileSync(file, rows.map(row => JSON.stringify(row) + '\n').join(''));
  write([user()]);
  const bind = () => bindClaudeTranscript({ privacy: 'public', home, cwd, id: sessionId });
  const expected = { privacy: 'public' as const, uuid: seedId, text: seedText };
  const session: ManagedSession = { hostId: 'claude', sessionId, ownerId: 'owner_fixture', generation: 0, model, access: 'edit' };
  const input = () => ({ privacy: 'public' as const, afterCursor: null as string | null, seed: expected,
    users: new Map([[userId, { privacy: 'public' as const, text: 'Public literal $HOME, `backticks`, $(never-execute)' }]]),
    completedAssistants: new Set([assistantId]) });
  return { home, cwd, project, file, user, assistant, write, append, bind, expected, session, input };
}

test('Claude assigned transcript is independently retained and content hashes do not claim readiness', () => {
  const sb = sandbox();
  try {
    const f = fixture(sb), binding = f.bind();
    assert.ok(Object.isFrozen(binding));
    assert.equal(binding.projectKey, 'bosun-' + sessionId);
    const receipt = readClaudeTranscriptSeed(binding, f.expected);
    assert.equal(receipt.seedHash, sha(seedText)); assert.equal(receipt.snapshotHash, sha(fs.readFileSync(f.file)));
    assert.equal(receipt.nativeReadiness, 'unqualified');
    assert.equal('root' in receipt, false); assert.equal('idle' in receipt, false);
    assert.equal('model' in receipt, false); assert.equal('access' in receipt, false);
    assert.throws(() => readClaudeTranscript({ ...binding }), unknown);
    assert.equal(readClaudeTranscript(binding).messages[0].text, seedText);
    assert.deepEqual(sb.calls(), []);
  } finally { sb.cleanup(); }
});

test('Claude private/unclassified binding and seed requests reject before consulting path or text getters', () => {
  const sb = sandbox();
  try {
    const f = fixture(sb), binding = f.bind(); let reads = 0;
    for (const privacy of ['private', 'unknown', undefined]) {
      assert.throws(() => bindClaudeTranscript({ privacy,
        get home(): never { reads++; throw Error('PATH_CANARY'); } } as never),
      (error: unknown) => error instanceof BosunError && error.code === 'private_input');
      assert.throws(() => readClaudeTranscriptSeed(binding, { privacy,
        get text(): never { reads++; throw Error('BODY_CANARY'); } } as never),
      (error: unknown) => error instanceof BosunError && error.code === 'private_input');
    }
    assert.equal(reads, 0);
  } finally { sb.cleanup(); }
});

test('Claude root readback rejects foreign identities, ancestry, synthetic histories and seed changes finitely', () => {
  for (const change of [
    { sessionId: crypto.randomUUID() }, { cwd: '/FOREIGN_CANARY' }, { version: '2.1.293' },
    { parentUuid: userId }, { isSidechain: true }, { isMeta: true }, { isCompactSummary: true },
    { isApiErrorMessage: true }, { userType: 'internal' }, { agentId: 'AGENT_CANARY' },
    { forkedFromSessionId: sessionId }, { timestamp: 'invalid' }, { privacy: 'private' },
    { isMeta: 'UNKNOWN_CANARY' }, { gitBranch: { payload: 'BRANCH_CANARY' } },
    { message: { role: 'user', content: 'OTHER_SEED_CANARY' } },
  ]) {
    const sb = sandbox();
    try {
      const f = fixture(sb); f.write([{ ...f.user(), ...change }]);
      assert.throws(() => readClaudeTranscriptSeed(f.bind(), f.expected), unknown);
    } finally { sb.cleanup(); }
  }
});

test('Claude fresh seed readback accepts one exact text block and rejects extra user/assistant or metadata rows', () => {
  for (const mode of ['block', 'second-user', 'assistant', 'unknown-metadata', 'empty', 'duplicate']) {
    const sb = sandbox();
    try {
      const f = fixture(sb), seed = f.user();
      if (mode === 'block') seed.message.content = [{ type: 'text', text: seedText }] as never;
      const rows: unknown[] = mode === 'empty' ? [] : [seed];
      if (mode === 'second-user') rows.push(f.user(userId, 'Another user', seedId));
      if (mode === 'assistant') rows.push(f.assistant('Unrequested assistant', assistantId, seedId));
      if (mode === 'unknown-metadata') rows.push({ type: 'queue-operation', content: 'PAYLOAD_CANARY' });
      if (mode === 'duplicate') rows.push(f.user(seedId, seedText, seedId));
      f.write(rows);
      if (mode === 'block') assert.equal(readClaudeTranscriptSeed(f.bind(), f.expected).seedHash, sha(seedText));
      else assert.throws(() => readClaudeTranscriptSeed(f.bind(), f.expected), unknown);
    } finally { sb.cleanup(); }
  }
});

test('Claude reader only uses the assigned namespace and refuses symlink, hardlink and nonprivate files', () => {
  for (const mode of ['foreign-namespace', 'symlink-file', 'hardlink-file', 'wide-file', 'wide-project', 'symlink-home', 'noncanonical-cwd', 'symlink-cwd']) {
    const sb = sandbox();
    try {
      const f = fixture(sb), original = fs.readFileSync(f.file);
      if (mode === 'foreign-namespace') {
        fs.renameSync(f.project, path.join(f.home, 'projects', 'foreign-project'));
      } else if (mode === 'symlink-file') {
        const target = path.join(f.project, 'different.jsonl'); fs.writeFileSync(target, original, { mode: 0o600 });
        fs.unlinkSync(f.file); fs.symlinkSync(target, f.file);
      } else if (mode === 'hardlink-file') fs.linkSync(f.file, path.join(f.project, 'linked.jsonl'));
      else if (mode === 'wide-file') fs.chmodSync(f.file, 0o644);
      else if (mode === 'wide-project') fs.chmodSync(f.project, 0o755);
      else if (mode === 'symlink-home') {
        const target = f.home + '-moved'; fs.renameSync(f.home, target); fs.symlinkSync(target, f.home);
      } else if (mode === 'symlink-cwd') {
        const target = f.cwd + '-moved'; fs.renameSync(f.cwd, target); fs.symlinkSync(target, f.cwd);
      }
      assert.throws(() => mode === 'noncanonical-cwd'
        ? bindClaudeTranscript({ privacy: 'public', home: f.home, cwd: f.cwd + '/.', id: sessionId }) : f.bind(), unknown);
    } finally { sb.cleanup(); }
  }
});

test('Claude binding repeats directory, cwd and file identities before each independently retained read', () => {
  for (const mode of ['file', 'project', 'projects', 'cwd', 'wide-parent']) {
    const sb = sandbox();
    try {
      const f = fixture(sb), binding = f.bind();
      if (mode === 'file') { fs.renameSync(f.file, f.file + '.old'); fs.copyFileSync(f.file + '.old', f.file); }
      else if (mode === 'wide-parent') fs.chmodSync(path.join(f.home, 'projects'), 0o755);
      else {
        const directory = mode === 'project' ? f.project : mode === 'projects' ? path.join(f.home, 'projects') : f.cwd;
        fs.renameSync(directory, directory + '-old'); fs.mkdirSync(directory, { mode: mode === 'cwd' ? 0o755 : 0o700 });
        if (mode === 'project') fs.copyFileSync(path.join(directory + '-old', sessionId + '.jsonl'), f.file);
        if (mode === 'projects') {
          fs.mkdirSync(f.project, { mode: 0o700 });
          fs.copyFileSync(path.join(directory + '-old', 'bosun-' + sessionId, sessionId + '.jsonl'), f.file);
        }
      }
      assert.throws(() => readClaudeTranscript(binding), unknown);
    } finally { sb.cleanup(); }
  }
});

test('Claude retained reads reject write/replacement/parent races while the original descriptor is open', t => {
  for (const mode of ['append', 'rewrite', 'replace-file', 'replace-parent']) {
    const sb = sandbox();
    try {
      const f = fixture(sb), binding = f.bind(), original = fs.readSync;
      let changed = false;
      const mock = t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
        const result = Reflect.apply(original, fs, args);
        if (!changed) {
          changed = true;
          if (mode === 'append') f.append([f.user(userId, 'Public next user', seedId)]);
          if (mode === 'rewrite') f.write([f.user(seedId, 'Public changed constraint')]);
          if (mode === 'replace-file') { fs.renameSync(f.file, f.file + '.old'); fs.copyFileSync(f.file + '.old', f.file); }
          if (mode === 'replace-parent') {
            fs.renameSync(f.project, f.project + '-old'); fs.mkdirSync(f.project, { mode: 0o700 });
            fs.copyFileSync(path.join(f.project + '-old', sessionId + '.jsonl'), f.file);
          }
        }
        return result;
      });
      try { assert.throws(() => readClaudeTranscript(binding), unknown); assert.equal(changed, true); }
      finally { mock.mock.restore(); }
    } finally { sb.cleanup(); }
  }
});

test('Claude append-only linear history extends a binding, while prior accepted rows remain immutable', () => {
  for (const mode of ['extend', 'rewrite-seed', 'rewrite-newer', 'truncate', 'branch']) {
    const sb = sandbox();
    try {
      const f = fixture(sb), binding = f.bind(); readClaudeTranscriptSeed(binding, f.expected);
      f.append([f.user(userId, 'Public next user', seedId)]);
      assert.equal(readClaudeTranscript(binding).messages.length, 2);
      if (mode === 'extend') {
        f.append([f.assistant()]); assert.equal(readClaudeTranscript(binding).messages.length, 3);
        assert.throws(() => readClaudeTranscriptSeed(binding, f.expected), unknown);
      } else {
        if (mode === 'rewrite-seed') f.write([f.user(seedId, 'Public changed seed'), f.user(userId, 'Public next user', seedId)]);
        if (mode === 'rewrite-newer') f.write([f.user(), f.user(userId, 'Public changed task', seedId)]);
        if (mode === 'truncate') f.write([f.user()]);
        if (mode === 'branch') f.append([f.assistant('Public answer', assistantId, seedId)]);
        assert.throws(() => readClaudeTranscript(binding), unknown);
      }
    } finally { sb.cleanup(); }
  }
});

test('Claude unknown, partial, overbound and invalid-encoding JSONL stays held without exposing raw content', () => {
  for (const mode of ['partial', 'utf8', 'malformed', 'line', 'bytes', 'rows', 'blank', 'foreign-block']) {
    const sb = sandbox();
    try {
      const f = fixture(sb);
      if (mode === 'partial') fs.writeFileSync(f.file, JSON.stringify(f.user()));
      if (mode === 'utf8') fs.writeFileSync(f.file, Buffer.from([0xff, 0x0a]));
      if (mode === 'malformed') fs.writeFileSync(f.file, '{"type":"BODY_CANARY"\n');
      if (mode === 'line') f.write([f.user(seedId, 'x'.repeat(CLAUDE_TRANSCRIPT_LIMITS.lineBytes))]);
      if (mode === 'bytes') fs.writeFileSync(f.file, 'x'.repeat(CLAUDE_TRANSCRIPT_LIMITS.bytes + 1));
      if (mode === 'rows') {
        let parent: string | null = null;
        f.write(Array.from({ length: CLAUDE_TRANSCRIPT_LIMITS.rows + 1 }, () => {
          const id = crypto.randomUUID(), row = f.user(id, 'Public next task', parent); parent = id; return row;
        }));
      }
      if (mode === 'blank') fs.appendFileSync(f.file, '\n');
      if (mode === 'foreign-block') f.write([{ ...f.user(), message: { role: 'user', content: [{ type: 'document', payload: 'BODY_CANARY' }] } }]);
      assert.throws(() => readClaudeTranscript(f.bind()), unknown);
    } finally { sb.cleanup(); }
  }
});

test('Claude public evidence admits exact users and completed exact-model assistants and keeps native private metadata local', () => {
  const sb = sandbox();
  try {
    const f = fixture(sb), binding = f.bind(), input = f.input(), answer = f.assistant();
    answer.message.content.unshift({ type: 'thinking', thinking: 'THINKING_CANARY', signature: 'SIGNATURE_CANARY' } as never);
    answer.message.usage = { private_usage: 'ACCOUNT_CANARY' } as never;
    f.append([f.user(userId, input.users.get(userId)!.text, seedId), answer]);
    const snapshot = readClaudeTranscript(binding);
    assert.doesNotMatch(JSON.stringify(snapshot), /CANARY|usage|requestId|gitBranch/);
    const window = captureClaudeEvidence(f.session, binding, input, sha);
    assert.equal(window.complete, true); assert.equal(window.totalEvents, 2);
    assert.deepEqual(window.evidence.map(row => row.text), [input.users.get(userId)!.text, 'Public assistant answer']);
    assert.deepEqual(window.references.map(row => row.kind), ['user', 'assistant']);
    assert.equal(window.references[0].sha256, sha(window.evidence[0].text));
    assert.doesNotMatch(JSON.stringify(window), /CANARY|usage|requestId|gitBranch/);
    const next = captureClaudeEvidence(f.session, binding, { ...input, afterCursor: window.completedEventCursor }, sha);
    assert.equal(next.evidence.length, 0); assert.equal(next.complete, true); assert.equal(next.snapshotHash, window.snapshotHash);
  } finally { sb.cleanup(); }
});

test('Claude public evidence refuses unadmitted user text, changed models, uncompleted frames and foreign completion claims', () => {
  for (const mode of ['user', 'model', 'incomplete', 'extra-user', 'extra-completion', 'wrong-source', 'wrong-seed', 'seed-admitted']) {
    const sb = sandbox();
    try {
      const f = fixture(sb), binding = f.bind(), input = f.input(), answer = f.assistant();
      if (mode === 'model') answer.message.model = 'claude-different-fixture';
      f.append([f.user(userId, input.users.get(userId)!.text, seedId), answer]);
      if (mode === 'user') input.users.set(userId, { privacy: 'public', text: 'Different admitted prompt' });
      if (mode === 'incomplete') input.completedAssistants.clear();
      if (mode === 'extra-user') input.users.set(crypto.randomUUID(), { privacy: 'public', text: 'Not retained' });
      if (mode === 'extra-completion') input.completedAssistants.add(crypto.randomUUID());
      if (mode === 'wrong-seed') input.seed = { ...input.seed, text: 'Different seed' };
      if (mode === 'seed-admitted') input.users.set(seedId, { privacy: 'public', text: seedText });
      assert.throws(() => captureClaudeEvidence(mode === 'wrong-source' ? { ...f.session, sessionId: crypto.randomUUID() } : f.session,
        binding, input, sha), unknown);
    } finally { sb.cleanup(); }
  }
});

test('Claude private text/block classifications, credentials and tool results are held before public evidence can escape', () => {
  for (const mode of ['private-row', 'private-message', 'private-block', 'secret-user', 'secret-assistant', 'tool-use', 'tool-result']) {
    const sb = sandbox();
    try {
      const f = fixture(sb), binding = f.bind(), input = f.input(), user = f.user(userId, input.users.get(userId)!.text, seedId), answer = f.assistant();
      if (mode === 'private-row') Object.assign(answer, { privacy: 'private' });
      if (mode === 'private-message') Object.assign(answer.message, { privacy: 'unknown' });
      if (mode === 'private-block') Object.assign(answer.message.content[0], { privacy: 'private' });
      if (mode === 'secret-user') user.message.content = 'api_key=' + 'z'.repeat(40);
      if (mode === 'secret-assistant') answer.message.content[0].text = 'api_key=' + 'z'.repeat(40);
      if (mode === 'tool-use') answer.message.content = [{ type: 'tool_use', id: 'tool_fixture', name: 'Read', input: { path: 'PATH_CANARY' } }] as never;
      if (mode === 'tool-result') user.message.content = [{ type: 'tool_result', tool_use_id: 'tool_fixture', content: 'OUTPUT_CANARY' }] as never;
      f.append([user, answer]);
      assert.throws(() => captureClaudeEvidence(f.session, binding, input, sha),
        (error: unknown) => (unknown(error) || error instanceof BosunError && error.code === 'private_input')
          && !/CANARY|zzzz|api_key/.test(JSON.stringify(error)));
    } finally { sb.cleanup(); }
  }
});

test('Claude evidence validates the full source after a cursor and keeps UTF-8 bounded windows incremental', () => {
  const sb = sandbox();
  try {
    const f = fixture(sb), binding = f.bind(), input = f.input(); input.users.clear(); input.completedAssistants.clear();
    let parent = seedId;
    const rows: unknown[] = [];
    for (let i = 0; i < 30; i++) {
      const user = crypto.randomUUID(), assistant = crypto.randomUUID(), body = '🙂'.repeat(1700) + ' public ' + i;
      input.users.set(user, { privacy: 'public', text: 'Public task ' + i }); input.completedAssistants.add(assistant);
      rows.push(f.user(user, 'Public task ' + i, parent), f.assistant(body, assistant, user)); parent = assistant;
    }
    f.append(rows);
    const first = captureClaudeEvidence(f.session, binding, input, sha);
    assert.equal(first.complete, false); assert.ok(first.evidence.length > 1);
    assert.ok(first.evidence.every(row => Buffer.byteLength(row.text) <= 6144 && !row.text.includes('�')));
    assert.ok(first.evidence.reduce((n, row) => n + Buffer.byteLength(row.text), 0) <= 128 * 1024);
    const second = captureClaudeEvidence(f.session, binding, { ...input, afterCursor: first.completedEventCursor }, sha);
    assert.equal(second.complete, true); assert.equal(second.snapshotHash, first.snapshotHash);
    assert.equal(first.evidence.length + second.evidence.length, first.totalEvents);
    assert.equal(new Set([...first.evidence, ...second.evidence].map(row => row.id)).size, first.totalEvents);
    for (const cursor of ['malformed', 'e_00000001_' + '0'.repeat(64)])
      assert.throws(() => captureClaudeEvidence(f.session, binding, { ...input, afterCursor: cursor }, sha),
        (error: unknown) => error instanceof BosunError && ['unverified', 'conflict'].includes(error.code));
    assert.throws(() => captureClaudeEvidence({ ...f.session, generation: 1 }, binding,
      { ...input, afterCursor: first.completedEventCursor }, sha),
    (error: unknown) => error instanceof BosunError && error.code === 'conflict');
    assert.throws(() => captureClaudeEvidence(f.session, binding, input, () => 'not-a-hash'), unknown);
    const last = crypto.randomUUID();
    f.append([f.user(last, 'password=' + 's'.repeat(32), parent)]);
    assert.throws(() => captureClaudeEvidence(f.session, binding,
      { ...input, afterCursor: second.completedEventCursor }, sha),
    (error: unknown) => error instanceof BosunError && error.code === 'private_input');
  } finally { sb.cleanup(); }
});

test('Claude evidence rejects private request/user classification before disk access and binds cursors to the original inode', () => {
  const sb = sandbox();
  try {
    const f = fixture(sb), binding = f.bind(), input = f.input();
    f.append([f.user(userId, input.users.get(userId)!.text, seedId), f.assistant()]);
    const first = captureClaudeEvidence(f.session, binding, input, sha);
    for (const privacy of ['private', 'unknown', undefined]) {
      assert.throws(() => captureClaudeEvidence(f.session, binding, { privacy,
        get seed(): never { throw Error('BODY_CANARY'); } } as never, sha),
      (error: unknown) => error instanceof BosunError && error.code === 'private_input');
    }
    input.users.set(userId, { privacy: 'private', text: 'PRIVATE_CANARY' } as never);
    fs.renameSync(f.file, f.file + '.old');
    assert.throws(() => captureClaudeEvidence(f.session, binding, input, sha),
    (error: unknown) => error instanceof BosunError && error.code === 'private_input');
    input.users.set(userId, { privacy: 'public', text: 'Public literal $HOME, `backticks`, $(never-execute)' });
    f.write([f.user(), f.user(userId, input.users.get(userId)!.text, seedId), f.assistant()]);
    const rebound = f.bind();
    assert.notEqual(rebound.ino, binding.ino);
    assert.throws(() => captureClaudeEvidence(f.session, rebound,
      { ...input, afterCursor: first.completedEventCursor }, sha),
    (error: unknown) => error instanceof BosunError && error.code === 'conflict');
  } finally { sb.cleanup(); }
});
