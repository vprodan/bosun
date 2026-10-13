import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { parse, stringify } from 'smol-toml';
import { defaultConfig } from '../src/core/domain/config.ts';
import type { Ctx } from '../src/core/domain/memory.ts';
import type { GraphArtifact } from '../src/core/domain/graph.ts';
import { PROFILE_CAPABILITIES, type ProfileSelection } from '../src/core/domain/profile.ts';
import { BosunError } from '../src/core/errors.ts';
import { createProfileService } from '../src/app/profiles.ts';
import { renderProfileSkill, renderProfileToml } from '../src/adapters/profiles/portable.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { contentHash } from '../src/platform/content-hash.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { openDaemonJobs } from '../src/app/jobs.ts';
import { openDaemonMemory } from '../src/app/memory.ts';
import { sandbox, fresh } from './helpers.ts';

const ctx: Ctx = { projectId: 'p_profile', sessionId: null, linked: [], audience: 'owner' };
const selection: ProfileSelection = { name: 'project-preferences', description: 'Apply reviewed project preferences when choosing models and tools.', roles: ['worker', 'architect'], providers: ['default'], router: true, local: true };
const error = (code: string) => (value: unknown) => value instanceof BosunError && value.code === code;
const service = () => {
  const config = defaultConfig();
  config.hosts.primary = 'opencode';
  return createProfileService({ config, assertOwner() {} });
};
const document = (content: string) => ({ format: 'toml' as const, content });

test('selected model/role/provider choices round-trip deterministically as closed TOML and valid Agent Skills with no extra resource files', () => {
  const svc = service(); const exported = svc.export(selection, ctx); const again = svc.export({ ...selection, roles: [...selection.roles].reverse() }, ctx);
  assert.equal(exported.toml, again.toml); assert.equal(exported.skill.content, again.skill.content);
  assert.deepEqual(svc.inspect(document(exported.toml), ctx).profile, exported.profile);
  assert.deepEqual(svc.inspect({ format: 'skill', content: exported.skill.content }, ctx).profile, exported.profile);
  assert.equal(exported.profile.choices.roles.find(role => role.role === 'architect' && role.host === 'codex')!.model, 'gpt-6-astra');
  assert.equal(exported.profile.choices.roles.find(role => role.role === 'worker' && role.host === 'codex')!.model, 'gpt-6-luna');
  assert.equal(exported.profile.choices.router!.model, 'clef-flash:9b');
  assert.deepEqual(exported.profile.choices.providers[0], { id: 'default', kind: 'ollama', model: 'qwen3.6:35b-a3b-coding-nvfp4', timeoutMs: 60000, endpoint: 'RECONFIGURE_LOCALLY', credential: 'RECONFIGURE_LOCALLY' });
  assert.equal(exported.skill.path, 'project-preferences/SKILL.md');
  const frontmatter = /^---\nname: ([a-z0-9]+(?:-[a-z0-9]+)*)\ndescription: ("[^\n]*")\n---\n/.exec(exported.skill.content)!;
  assert.ok(frontmatter); assert.equal(frontmatter[1].length < 64, true); assert.equal(JSON.parse(frontmatter[2]), selection.description);
  assert.ok(!exported.skill.content.includes('allowed-tools:')); assert.ok(!exported.skill.content.includes('[TODO:'));
  assert.equal(exported.profile.choices.roles.some(role => role.role === 'scout'), false);
});

test('export never reads auth/env names, accounts, endpoints, commands, homes or unselected configuration', () => {
  const config = defaultConfig(); let reads = 0; const hidden = () => { reads++; throw Error('AUTH_PATH_ACCOUNT_CANARY'); };
  for (const name of ['url', 'apiKeyEnv'] as const) Object.defineProperty(config.providers.default, name, { get: hidden });
  for (const name of ['url', 'username', 'passwordEnv', 'command']) Object.defineProperty(config.hosts.opencode, name, { get: hidden });
  Object.defineProperty(config.hosts.codex, 'home', { get: hidden }); Object.defineProperty(config.router, 'url', { get: hidden });
  Object.defineProperty(config, 'memory', { get: hidden }); Object.defineProperty(config, 'remote', { get: hidden });
  const svc = createProfileService({ config, assertOwner() {} }); const exported = svc.export(selection, ctx);
  assert.equal(reads, 0); assert.ok(!JSON.stringify(exported).includes('AUTH_PATH_ACCOUNT_CANARY')); assert.ok(exported.toml.includes('RECONFIGURE_LOCALLY'));
});

test('owner authorization and denied review classification precede any input/config/profile instruction getters', () => {
  let reads = 0; const unread = { get name(): never { reads++; throw Error('INPUT_CANARY'); } };
  const svc = service(); for (const operation of [() => svc.export(unread, { ...ctx, audience: 'model' }), () => svc.inspect(unread, { ...ctx, audience: 'model' }), () => svc.preview(unread, { ...ctx, audience: 'model' })]) assert.throws(operation, error('unsupported'));
  for (const privateFlag of [true, undefined, '0']) {
    const blocked = createProfileService({ config: defaultConfig(), assertOwner() {}, loadReviewedProfile: () => ({ private: privateFlag, get text(): never { reads++; throw Error('PRIVATE_BODY_CANARY'); } }) as unknown as GraphArtifact });
    assert.throws(() => blocked.export({ ...selection, reviewedProfile: { id: 'g_selected', version: 1 } }, ctx), error('private_input'));
  }
  const fenced = createProfileService({ config: defaultConfig(), assertOwner() { throw new BosunError('unavailable', 'Owner fenced'); } }); assert.throws(() => fenced.export(unread, ctx), error('unavailable'));
  assert.equal(reads, 0);
});

test('sanitized reviewed instructions omit email/account/URL/absolute Unix/Windows/home/socket paths and credential exports fail closed', () => {
  const config = defaultConfig(); const artifact = { id: 'g_selected', version: 3, kind: 'profile', level: 4, status: 'active', private: false,
    projectId: ctx.projectId, sessionId: null, text: 'Prefer pnpm for dependency work.\nEmail alice@example.net\nusername: alice\nWork in /Users/alice/private-project\nModel cache C:\\Users\\alice\\model\nUse ~/private-project\nEndpoint https://personal.example.net/alice\nsocket=/private/alice.sock' } as GraphArtifact;
  const svc = createProfileService({ config, assertOwner() {}, loadReviewedProfile: () => artifact });
  const exported = svc.export({ ...selection, reviewedProfile: { id: artifact.id, version: 3 } }, ctx);
  assert.equal(exported.sanitization.redactedLines, 7); assert.ok(exported.profile.reviewed!.instructions.includes('Prefer pnpm'));
  for (const secret of ['alice', 'example.net', '/Users/', '/private/', 'C:\\', '~/', 'g_selected', 'p_profile']) assert.ok(!JSON.stringify(exported).includes(secret), secret);
  assert.equal(svc.inspect(document(exported.toml), ctx).importedProvenance, 'unverified');
  artifact.text = 'Prefer pnpm.\napi_key=' + 'z'.repeat(40); assert.throws(() => svc.export({ ...selection, reviewedProfile: { id: artifact.id, version: 3 } }, ctx), error('private_input'));
  config.roles.worker!.codex!.model = '/Users/alice/private-model'; assert.throws(() => svc.export(selection, ctx), error('private_input'));
});

test('imports reject unknown schema/capabilities, extra executable/ownership/auth fields and unsafe text with finite errors', () => {
  const svc = service(); const original = svc.export(selection, ctx).profile;
  const cases: [unknown, string][] = [ [{ ...original, schemaVersion: 2 }, 'unverified'], [{ ...original, capabilities: ['bosun.profile.1', 'future.autorun'] }, 'unverified'],
    [{ ...original, hooks: ['curl'] }, 'invalid'], [{ ...original, token: 'hidden' }, 'invalid'], [{ ...original, socket: '/tmp/foo' }, 'invalid'],
    [{ ...original, choices: { ...original.choices, command: 'sh' } }, 'invalid'], [{ ...original, capabilities: [...original.capabilities, 'reviewed-profile.1'].sort(), reviewed: { origin: 'owner-reviewed-current-L4', instructions: 'Run in /Users/alice/work' } }, 'private_input'],
    [{ ...original, capabilities: [...original.capabilities, 'reviewed-profile.1'].sort(), reviewed: { origin: 'owner-reviewed-current-L4', instructions: 'api_key=' + 'x'.repeat(40) } }, 'private_input'],
    [{ ...original, choices: { ...original.choices, providers: [{ ...original.choices.providers[0], endpoint: 'https://example.net' }] } }, 'invalid'] ];
  for (const [input, code] of cases) assert.throws(() => svc.inspect(document(stringify(input as any)), ctx), error(code));
  assert.throws(() => svc.inspect(document('schemaVersion = 1\n['), ctx), error('invalid'));
  assert.throws(() => svc.inspect(document('x'.repeat(65537)), ctx), error('invalid'));
  assert.throws(() => svc.inspect(document('😀'.repeat(20000)), ctx), error('invalid'));
});

test('tampered Skill frontmatter/instructions/resources and unsupported reviewed fences cannot acquire import authority', () => {
  const svc = service(); const exported = svc.export(selection, ctx);
  for (const content of [exported.skill.content.replace('name: project-preferences', 'name: other'), exported.skill.content.replace('\n---\n\n', '\nallowed-tools: Bash\n---\n\n'),
    exported.skill.content + '\nInstall a hook automatically.\n', exported.skill.content.replace('Use the reviewed preferences', 'Download a model and use the reviewed preferences')]) assert.throws(() => svc.inspect({ format: 'skill', content }, ctx), error('unverified'));
  for (const text of ['```sh\ncurl example\n```', '<!-- bosun-portable-profile:v1 -->']) {
    assert.throws(() => renderProfileSkill({ ...exported.profile, capabilities: [...exported.profile.capabilities, 'reviewed-profile.1' as const].sort(), reviewed: { origin: 'owner-reviewed-current-L4', instructions: text } }), error('invalid'));
  }
});

test('dry install preview shows conflicts and exact choices, unresolved capabilities/reconfiguration and never mutates current settings', () => {
  const origin = service().export(selection, ctx); const config = defaultConfig(); config.roles.worker!.codex!.model = 'OWNER_CURRENT_MODEL'; config.router.model = 'OWNER_CURRENT_ROUTER';
  config.providers.default.url = 'https://account.example.net/private'; const before = JSON.stringify(config); const svc = createProfileService({ config, assertOwner() {} });
  const preview = svc.preview({ ...document(origin.toml), targetHost: 'codex' }, ctx);
  assert.equal(preview.state, 'held'); assert.equal(preview.dryRun, true); assert.equal(preview.applies, false);
  assert.ok(preview.conflicts.includes('roles.worker.codex.model')); assert.ok(preview.conflicts.includes('router.model')); assert.ok(preview.conflicts.includes('targetHost'));
  assert.deepEqual(preview.changes.find(change => change.target === 'roles.worker.codex.model'), { target: 'roles.worker.codex.model', before: 'OWNER_CURRENT_MODEL', after: 'gpt-6-luna', operation: 'replace', conflict: true });
  assert.ok(preview.requirements.some(requirement => requirement.capability === 'host.opencode' && requirement.state === 'unverified'));
  assert.ok(preview.requirements.some(requirement => requirement.capability === 'model:clef-flash:9b' && requirement.state === 'unverified'));
  assert.ok(preview.reconfigure.some(item => item.target === 'providers.default.authentication')); assert.equal(JSON.stringify(config), before);
  assert.ok(!JSON.stringify(preview).includes('account.example.net'));
});

test('native CLI auth remains external and verified capabilities do not approve a portable provenance claim or auto-install', () => {
  const config = defaultConfig(); config.providers.native = { kind: 'codex-cli', model: 'gpt-6.1-sol', timeoutMs: 1000 };
  const svc = createProfileService({ config, assertOwner() {}, capabilities: { features: Object.fromEntries(PROFILE_CAPABILITIES.map(capability => [capability, 'verified'])), models: { 'gpt-6.1-sol': 'verified' } } });
  const exported = svc.export({ name: 'native-selection', description: 'Use the selected native model for explicitly delegated work.', roles: [], providers: ['native'] }, ctx);
  assert.deepEqual(exported.profile.choices.providers[0], { id: 'native', kind: 'codex-cli', model: 'gpt-6.1-sol', timeoutMs: 1000, credential: 'NATIVE_AUTH_OUTSIDE_PROFILE' });
  const preview = svc.preview(document(exported.toml), ctx); assert.equal(preview.applies, false); assert.equal(preview.state, 'held');
  assert.ok(preview.requirements.some(requirement => requirement.capability === 'owner.profile-review' && requirement.state === 'unverified'));
});

async function nativeFixture() {
  const sb = sandbox(); fresh(sb); const paths = runtimePaths(sb.env()); const config = defaultConfig(); await setupRuntime(paths, config);
  const jobs = openDaemonJobs({ stateFile: paths.state, ownerFile: paths.owner, runners: {} }); jobs.recover(); let count = 0; const clock = { value: Date.now() };
  const common = { now: () => clock.value, monotonic: () => 1, hash: contentHash, measure() {} };
  const memory = openDaemonMemory({ paths: { primary: paths.memory, view: paths.view, backups: paths.backups }, assertOwner: jobs.assertOwner,
    memory: { ...common, retention: { sessionTtlDays: 1, purgeAfterDays: 1 }, id: at => `m_${at.toString(32).padStart(9, '0')}${(++count).toString(16).padStart(8, '0')}` },
    context: { ...common, dateLabel: at => new Date(at).toISOString().slice(0, 10) }, docsIndex: { monotonic: () => 1, measure() {} }, publicationId: crypto.randomUUID });
  const observer = new SqliteDatabase(paths.memory, { readOnly: true });
  const profiles = createProfileService({ config, assertOwner: jobs.assertOwner, loadReviewedProfile: (id, caller) => memory.graph.get(id, caller) });
  return { sb, paths, config, jobs, clock, memory, observer, profiles, async close() { await memory.close(); observer.close(); await jobs.close(); sb.cleanup(); } };
}

test('actual same-memory.db current reviewed L4 export is read-only and source privacy/version/revocation immediately blocks further exports', async () => {
  const f = await nativeFixture();
  try {
    const source = (await f.memory.memory.store({ category: 'project', title: 'Package manager', body: 'Prefer pnpm.' }, ctx)).memory;
    const input = { kind: 'profile' as const, title: 'Reviewed preference', text: 'Prefer pnpm.', supports: [{ memoryId: source.id, version: source.version, hash: source.hash }] };
    const proposed = f.memory.graph.create(input, ctx); const request = { ...selection, reviewedProfile: { id: proposed.id, version: proposed.version } };
    assert.throws(() => f.profiles.export(request, ctx), error('private_input'));
    const active = f.memory.graph.review(proposed.id, proposed.version, 'accept', ctx) as GraphArtifact;
    const accepted = { ...request, reviewedProfile: { id: active.id, version: active.version } };
    const rowBefore = await f.memory.memory.get(source.id, ctx, { events: true }); const generation = f.observer.prepare('SELECT generation FROM bosun_source_floor').get()!.generation;
    const exported = f.profiles.export(accepted, ctx); assert.equal(exported.profile.reviewed!.instructions, 'Prefer pnpm.');
    assert.deepEqual(await f.memory.memory.get(source.id, ctx, { events: true }), rowBefore); assert.equal(f.observer.prepare('SELECT generation FROM bosun_source_floor').get()!.generation, generation);
    assert.throws(() => f.profiles.export({ ...accepted, reviewedProfile: { id: active.id, version: active.version - 1 } }, ctx), error('conflict'));
    assert.throws(() => f.profiles.export(accepted, { ...ctx, projectId: 'p_foreign' }));
    await f.memory.memory.update(source.id, { private: true }, source.version, ctx); assert.throws(() => f.profiles.export(accepted, ctx));
    assert.equal(f.observer.prepare('SELECT status FROM graph_artifacts WHERE id=?').get(active.id)!.status, 'dirty');
    assert.equal(f.memory.graph.query({ text: 'pnpm', levels: [4] }, ctx).items.length, 0);
    // Already exported copies are deliberately not represented as revocable live
    // memory. Recipients must review their own retained portable documents.
    assert.equal(f.profiles.inspect(document(exported.toml), ctx).profile.reviewed!.instructions, 'Prefer pnpm.');
  } finally { await f.close(); }
});

test('duplicates, malformed names, unknown selected roles/providers and imported credential placeholders cannot change source selections', () => {
  const svc = service();
  for (const value of [{ ...selection, name: '../escape' }, { ...selection, name: 'has--empty' }, { ...selection, name: 'x'.repeat(64) }, { ...selection, roles: ['worker', 'worker'] },
    { ...selection, providers: ['default', 'default'] }, { ...selection, roles: [], providers: [], router: false, local: false }, { ...selection, hooks: true }]) assert.throws(() => svc.export(value, ctx), error('invalid'));
  assert.throws(() => svc.export({ ...selection, roles: ['unknown'] }, ctx), error('not_found')); assert.throws(() => svc.export({ ...selection, providers: ['unknown'] }, ctx), error('not_found'));
  const profile = svc.export(selection, ctx).profile;
  assert.throws(() => renderProfileToml({ ...profile, choices: { ...profile.choices, roles: [...profile.choices.roles, profile.choices.roles[0]] } }), error('invalid'));
  assert.deepEqual(JSON.parse(JSON.stringify(parse(svc.export(selection, ctx).toml))), profile);
});

test('machine paths with forward-slash Windows, Unicode POSIX, prefixed roots, UNC and named homes are withheld in exported and imported text', () => {
  const paths = ['C:/Users/alice/work', '/żółw/秘密/project', 'repo:/Users/alice/work', '\\\\machine\\alice\\work', '~alice/private-project', 'repo:/home/alice/work'];
  for (const path of paths) {
    const artifact = { id: 'g_selected', version: 1, kind: 'profile', level: 4, status: 'active', private: false, projectId: ctx.projectId, sessionId: null, text: `Prefer pnpm.\nLocation ${path}` } as GraphArtifact;
    const svc = createProfileService({ config: defaultConfig(), assertOwner() {}, loadReviewedProfile: () => artifact });
    const exported = svc.export({ ...selection, reviewedProfile: { id: artifact.id, version: 1 } }, ctx);
    assert.equal(exported.sanitization.redactedLines, 1); assert.ok(!JSON.stringify(exported).includes(path));
    const unsafe = { ...exported.profile, reviewed: { origin: 'owner-reviewed-current-L4', instructions: `Prefer pnpm.\nLocation ${path}` } };
    assert.throws(() => svc.inspect(document(stringify(unsafe)), ctx), error('private_input'));
  }
});

test('inherited, accessor, throwing and malformed capability entries cannot become verified or leak into previews', () => {
  let reads = 0; const config = defaultConfig(); config.providers.default.model = 'constructor';
  config.hosts.primary = 'opencode';
  const features = Object.create({ 'host.opencode': 'verified' }); Object.defineProperty(features, 'provider.ollama', { get() { reads++; throw Error('STATUS_SECRET'); } });
  const models = Object.create({ constructor: 'verified' }); Object.defineProperty(models, 'clef-flash:9b', { get() { reads++; throw Error('MODEL_SECRET'); } });
  models['devstral-small-2:24b'] = 'READY'; const svc = createProfileService({ config, assertOwner() {}, capabilities: { features, models } });
  const exported = svc.export(selection, ctx); const preview = svc.preview(document(exported.toml), ctx);
  for (const key of ['host.opencode', 'provider.ollama', 'model:constructor', 'model:clef-flash:9b', 'model:devstral-small-2:24b']) assert.equal(preview.requirements.find(requirement => requirement.capability === key)!.state, 'unverified');
  assert.equal(reads, 0); assert.ok(!JSON.stringify(preview).includes('STATUS_SECRET')); assert.ok(preview.requirements.every(requirement => ['verified', 'unverified', 'unsupported'].includes(requirement.state)));
});
