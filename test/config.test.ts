import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fresh } from './helpers.ts';
import * as config from '../lib/config.ts';
import { P } from '../lib/config.ts';

test('config: defaults, then config.env, then env; partial config keeps defaults; setKey', () => {
  const sb = sandbox();
  try {
    fresh(sb);
    let c = config.load();
    assert.equal(c.LOCAL_MODEL, 'qwen3.6:35b-a3b-coding-nvfp4');
    assert.ok(fs.existsSync(config.P.CFG), 'config.env is created on first load');
    fs.writeFileSync(config.P.CFG, 'LOCAL_MODEL=my-model  # mine\n');
    c = config.load();
    assert.equal(c.LOCAL_MODEL, 'my-model');
    assert.equal(c.CTX, '65536', 'missing keys fall back to defaults');
    process.env.LOCAL_MODEL = 'from-env';
    assert.equal(config.load().LOCAL_MODEL, 'from-env');
    delete process.env.LOCAL_MODEL;
    config.setKey('LOCAL_MODEL', 'other');
    config.setKey('HOSTS', 'codex');
    assert.equal(fs.readFileSync(config.P.CFG, 'utf8'), 'LOCAL_MODEL=other  # mine\nHOSTS=codex\n');
  } finally { sb.cleanup(); }
});

test('config: spec, role, hosts, harness', () => {
  const sb = sandbox({ stubs: ['claude', 'codex'] });
  try {
    fresh(sb);
    const c = config.load();
    assert.deepEqual(config.spec('opus:high'), { model: 'opus', effort: 'high' });
    assert.deepEqual(config.spec('haiku'), { model: 'haiku', effort: '' });
    assert.deepEqual(config.role(c, 'architect', 'codex'), { model: 'gpt-6-astra', effort: 'high' });
    assert.deepEqual(config.hosts(c), ['claude', 'codex']);
    assert.deepEqual(config.hosts({ ...c, HOSTS: 'both' }), ['claude', 'codex']);
    assert.deepEqual(config.hosts({ ...c, HOSTS: 'codex' }), ['codex']);
    assert.equal(config.harness(c), 'claude');
    assert.equal(config.harness({ ...c, LOCAL_HARNESS: 'codex' }), 'codex');
  } finally { sb.cleanup(); }
});

test('config: paths follow HOME at call time, so tests switch sandboxes without reloading modules', () => {
  const a = sandbox();
  const b = sandbox();
  try {
    fresh(a);
    assert.equal(P.BOSUN, path.join(a.home, '.bosun'));
    fresh(b);
    assert.equal(P.CFG, path.join(b.home, '.bosun', 'config.env'));
    assert.equal(P.DB, path.join(b.home, '.bosun', 'memory.db'));
    fresh(b, { BOSUN_HOME: path.join(b.root, 'elsewhere') });
    assert.equal(P.STATE, path.join(b.root, 'elsewhere', 'state.json'));
  } finally { a.cleanup(); b.cleanup(); }
});
