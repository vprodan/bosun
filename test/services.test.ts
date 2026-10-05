import "./bootstrap.ts";
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox, fresh, bosun } from './helpers.ts';
import * as s from '../lib/services.ts';

const plutil = (...a: string[]) => spawnSync('plutil', a, { encoding: 'utf8' });

test('services: plist is valid XML with escaped argv, env and workdir', () => {
  const sb = sandbox();
  try {
    fresh(sb);
    s.svcWrite('t', path.join(sb.root, 'a & b'), { PATH: '/x&y' }, ['/usr/bin/true', '--x', '<y>']);
    const f = path.join(sb.home, 'Library/LaunchAgents/com.bosun.t.plist');
    assert.equal(plutil('-lint', '-s', f).status, 0);
    assert.equal(plutil('-extract', 'ProgramArguments.2', 'raw', f).stdout.trim(), '<y>');
    assert.equal(plutil('-extract', 'EnvironmentVariables.PATH', 'raw', f).stdout.trim(), '/x&y');
    assert.equal(plutil('-extract', 'WorkingDirectory', 'raw', f).stdout.trim(), path.join(sb.root, 'a & b'));
    assert.equal(plutil('-extract', 'Label', 'raw', f).stdout.trim(), 'com.bosun.t');
  } finally { sb.cleanup(); }
});

test('services: vge compares dotted versions numerically', () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const { vge } = s;
    assert.ok(vge('0.34.4', '0.34.0'));
    assert.ok(vge('0.34.0', '0.34.0'));
    assert.ok(vge('1.0.0', '0.34.0'));
    assert.ok(!vge('0.9.1', '0.34.0'));
    assert.ok(!vge('0', '0.34.0'));
  } finally { sb.cleanup(); }
});

test('services: start/stop reject an unknown target before touching launchd', async () => {
  const sb = sandbox();
  try {
    for (const c of ['start', 'stop', 'restart']) {
      const r = await bosun([c, 'bogus'], { env: sb.env() });
      assert.equal(r.code, 2);
      assert.match(r.err, /target must be ollama, router or all/, c);
    }
  } finally { sb.cleanup(); }
});

test('services: svcOn retries a failing launchctl bootstrap before giving up', () => {
  const sb = sandbox({ stubs: ['launchctl'] });
  try {
    fresh(sb, { STUB_MAP: JSON.stringify({ 'launchctl bootstrap': { code: 5 } }) });
    s.svcWrite('t', sb.root, {}, ['/usr/bin/true']);
    assert.throws(() => s.svcOn('t'), /launchctl bootstrap t/);
    assert.equal(sb.calls().filter((c) => c.argv[0] === 'bootstrap').length, 4);
  } finally { sb.cleanup(); }
});
