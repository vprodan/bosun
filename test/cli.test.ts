import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, bosun } from './helpers.ts';

test('cli: help exits 0, unknown command exits 2', async () => {
  const sb = sandbox();
  try {
    const h = await bosun(['help'], { env: sb.env() });
    assert.equal(h.code, 0);
    assert.match(h.out, /bosun run/);
    assert.equal((await bosun(['nope'], { env: sb.env() })).code, 2);
  } finally { sb.cleanup(); }
});

test('cli: doctor reports problems in an empty sandbox without crashing', async () => {
  const sb = sandbox();
  try {
    const r = await bosun(['doctor'], { env: sb.env({ OLLAMA_URL: 'http://127.0.0.1:1', ROUTER_PORT: '1' }) });
    assert.equal(r.code, 1);
    assert.match(r.out, /router hook missing: bosun install/);
    assert.match(r.out, /ollama down/);
    assert.match(r.out, /kev down/);
  } finally { sb.cleanup(); }
});

test('cli: install rejects a bad option before touching anything', async () => {
  const sb = sandbox();
  try {
    const r = await bosun(['install', '--bogus'], { env: sb.env() });
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown option --bogus/);
    assert.ok(!fs.existsSync(path.join(sb.home, '.claude')));
  } finally { sb.cleanup(); }
});

test('cli: install and uninstall check every config file before changing anything', async () => {
  const sb = sandbox({ stubs: ['claude', 'codex', 'orca', 'launchctl'] });
  try {
    fs.mkdirSync(path.join(sb.home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(sb.home, '.codex', 'hooks.json'), '{ broken');
    for (const c of ['install', 'uninstall']) {
      const r = await bosun([c], { env: sb.env() });
      assert.equal(r.code, 1, c);
      assert.match(r.err, /hooks\.json is not valid JSON/, c);
    }
    assert.equal(sb.calls().filter((x) => x.bin === 'launchctl').length, 0, 'no service was touched');
  } finally { sb.cleanup(); }
});

test('cli: doctor notices Ollama.app lost bosun env (reboot)', async () => {
  const sb = sandbox({ stubs: ['claude', 'codex', 'orca', 'launchctl'] });
  try {
    const app = path.join(sb.root, 'Ollama.app');
    fs.mkdirSync(app);
    const r = await bosun(['doctor'], { env: sb.env({ BOSUN_OLLAMA_APP: app, STUB_MAP: JSON.stringify({ 'launchctl getenv': { out: '4096' } }) }) });
    assert.match(r.out, /Ollama\.app lost bosun env/);
  } finally { sb.cleanup(); }
});

test('cli: uninstall only removes what bosun added (its link, its .zshrc line, its launchctl values)', async () => {
  const sb = sandbox({ stubs: ['claude', 'codex', 'orca', 'launchctl'] });
  try {
    const h = sb.home;
    const app = path.join(sb.root, 'Ollama.app');
    fs.mkdirSync(app);
    fs.mkdirSync(path.join(h, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(h, '.local', 'bin', 'bosun'), 'someone else\n');
    const line = 'export PATH="$HOME/.local/bin:$PATH"';
    fs.writeFileSync(path.join(h, '.zshrc'), `alias ll="ls -la"\n\n${line}\nexport EDITOR=vim\n`);
    fs.mkdirSync(path.join(h, '.bosun'), { recursive: true });
    fs.writeFileSync(path.join(h, '.bosun', 'state.json'), JSON.stringify({ zshrcLine: line, appEnvPrev: { OLLAMA_KEEP_ALIVE: '5m', OLLAMA_CONTEXT_LENGTH: null } }));
    const r = await bosun(['uninstall'], { env: sb.env({ BOSUN_OLLAMA_APP: app }) });
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.readFileSync(path.join(h, '.local', 'bin', 'bosun'), 'utf8'), 'someone else\n', 'a bosun binary that is not our link stays');
    assert.equal(fs.readFileSync(path.join(h, '.zshrc'), 'utf8'), 'alias ll="ls -la"\n\nexport EDITOR=vim\n');
    const lc = sb.calls().filter((c) => c.bin === 'launchctl').map((c) => c.argv.join(' '));
    assert.ok(lc.includes('setenv OLLAMA_KEEP_ALIVE 5m'), lc.join('\n'));
    assert.ok(lc.includes('unsetenv OLLAMA_CONTEXT_LENGTH'));
    assert.ok(!lc.some((x) => x.startsWith('unsetenv OLLAMA_NUM_PARALLEL')), 'keys bosun never touched stay as they were');
    const st = JSON.parse(fs.readFileSync(path.join(h, '.bosun', 'state.json'), 'utf8'));
    assert.equal(st.zshrcLine, undefined);
    assert.equal(st.appEnvPrev, undefined);
  } finally { sb.cleanup(); }
});
