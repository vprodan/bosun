import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess, { spawn } from 'node:child_process';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { sandbox, fresh, gitRepo, bosun, mock, BIN, REPO, type Sandbox } from './helpers.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { norm } from '../src/core/text.ts';
import { openSchemaOneMemory, prepareTestRuntime, testCutoverPaths } from './memory-store-fixture.ts';
import { memoryScope, project } from '../src/platform/project.ts';
import { MemoryError } from '../src/core/errors.ts';
import type { Ctx } from '../src/core/domain/memory.ts';
import { cutoverMemory, publishMemoryView, CutoverError, type CutoverPaths } from '../src/adapters/memory/sqlite-cutover.ts';
import { SqlitePublicReadOnly } from '../src/adapters/memory/sqlite-public-readonly.ts';
import { openHookMemory } from '../src/adapters/memory/sqlite-readonly.ts';
import {
  PUBLIC_MAX_ROWS,
  PUBLIC_MAX_BYTES,
  VIEW_MAX_BYTES,
} from '../src/adapters/memory/sqlite-public-protocol.ts';
import { publishFixtureHook } from './hook-config-fixture.ts';
import { createTestMemoryStore, openTestLocalMemory } from './memory-store-fixture.ts';

const PROMPT = 'rename getCart to fetchCart in cart service';
const PUBLIC = 'PUBLIC-VIEW-HANDOFF-CANARY';
const FINITE = 'FINITE-EXPIRY-OMITTED-CANARY';
const PRIVATE = 'PRIVATE-AUDIT-BACKUP-CANARY';
const options = (paths: CutoverPaths, now = Date.now) => ({
  paths,
  now,
  id: crypto.randomUUID,
});
const error =
  (code = 'unavailable') =>
  (e: unknown) =>
    e instanceof MemoryError && e.code === code && !e.message.includes(PRIVATE);
const writerBusy = (e: unknown) =>
  e instanceof CutoverError && e.code === 'unavailable' && e.reason === 'busy' &&
  e.message === 'memory cutover unavailable (busy)' && e.cause === undefined;
const tick = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const POSIX = {
  skip:
    process.platform === 'win32' ? 'native public-view reader qualification is POSIX only' : false,
};
function footprint(dir: string): object {
  const visit = (file: string): object => {
    const s = fs.lstatSync(file, { bigint: true });
    const metadata = {
      dev: String(s.dev),
      ino: String(s.ino),
      mode: String(s.mode),
      size: String(s.size),
      mtime: String(s.mtimeNs),
      ctime: String(s.ctimeNs),
    };
    if (s.isSymbolicLink()) return { ...metadata, link: fs.readlinkSync(file) };
    if (s.isDirectory())
      return {
        ...metadata,
        children: Object.fromEntries(
          fs
            .readdirSync(file)
            .sort()
            .map((name) => [name, visit(path.join(file, name))]),
        ),
      };
    return {
      ...metadata,
      digest: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    };
  };
  return visit(dir);
}
async function fixture({ finite = false, extra = 0, published = true } = {}) {
  const sb = sandbox();
  fresh(sb);
  prepareTestRuntime();
  const paths = testCutoverPaths();
  fs.mkdirSync(path.dirname(paths.view), { mode: 0o700 });
  fs.mkdirSync(paths.backups, { mode: 0o700 });
  const repo = gitRepo(sb, 'public-reader', 'git@github.com:org/public-reader.git');
  const ctx = memoryScope(project(repo), [], 's_a', 'owner');
  const db = openSchemaOneMemory(paths.primary);
  const old = createTestMemoryStore(db);
  const own = (
    await old.store(
      {
        category: 'project',
        title: 'Cart naming',
        body: `${PROMPT} ${PUBLIC}`,
        tags: ['cart'],
        sourceRef: 'public provenance',
      },
      ctx,
    )
  ).memory;
  const personal = (
    await old.store(
      { category: 'personal', title: 'Personal cart', body: 'rename personal cart policy' },
      ctx,
    )
  ).memory;
  const foreign = (
    await old.store(
      { category: 'project', title: 'Foreign cart', body: 'rename foreign cart policy' },
      { ...ctx, projectId: 'p_b' },
    )
  ).memory;
  const shared = (
    await old.store(
      {
        category: 'project',
        title: 'Shared cart',
        body: 'rename shared cart policy',
        shared: true,
      },
      { ...ctx, projectId: 'p_c' },
    )
  ).memory;
  const session = (
    await old.store(
      { category: 'session', title: 'Session cart', body: `${PROMPT} ${FINITE}` },
      ctx,
    )
  ).memory;
  if (finite)
    db.prepare('UPDATE memories SET expires_at=? WHERE id=?').run(Date.now() + 1000, session.id);
  const secret = (
    await old.store(
      {
        category: 'personal',
        title: `${PRIVATE} title`,
        body: `${PRIVATE} body`,
        private: true,
        source: `${PRIVATE} source`,
        sourceRef: `${PRIVATE} ref`,
      },
      ctx,
    )
  ).memory;
  const unknown = (
    await old.store(
      { category: 'personal', title: 'Unknown cart', body: `${PRIVATE} unknown` },
      ctx,
    )
  ).memory;
  db.prepare("UPDATE memories SET private='unknown' WHERE id=?").run(unknown.id);
  db.prepare('INSERT INTO memory_events(memory_id,op,at,source,hash_after) VALUES(?,?,?,?,?)').run(
    own.id,
    'test',
    1,
    `${PRIVATE} audit`,
    `${PRIVATE} hash`,
  );
  for (let i = 0; i < extra; i++)
    await old.store(
      {
        category: 'personal',
        title: `Spill cart ${i}`,
        body: `spill cart ${i} ${'x'.repeat(500)}`,
      },
      ctx,
    );
  const floor = await cutoverMemory(options(paths));
  if (published) await publishMemoryView(options(paths));
  const readOptions = { primary: paths.primary, view: paths.view, sourceId: floor.sourceId };
  publishFixtureHook(sb, paths, floor.sourceId);
  return {
    sb,
    paths,
    repo,
    ctx,
    db,
    old,
    own,
    personal,
    foreign,
    shared,
    session,
    secret,
    unknown,
    floor,
    readOptions,
    close() {
      old.close();
      sb.cleanup();
    },
  };
}
function mutateView(file: string, fn: (db: SqliteDatabase) => void): void {
  const db = new SqliteDatabase(file);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

// Drives the real hook root with native stdout; gates contain no memory content in IPC.
function hook(
  sb: Sandbox,
  repo: string,
  url: string,
  sourceId: string,
  mode = 'gate',
  extraEnv: Record<string, string> = {},
) {
  const script = path.join(sb.root, `public-hook-${mode}.mjs`);
  fs.writeFileSync(
    script,
    `
await import(${JSON.stringify(path.join(REPO, 'test/bootstrap.ts'))});
const selectedMode=${JSON.stringify(mode)}, fdMode=selectedMode.startsWith('fd-'), mode=fdMode?selectedMode.slice(3):selectedMode;
const {hookOutput,createFdHookOutput}=await import(${JSON.stringify(path.join(REPO, 'src/platform/hook-output.ts'))});
const output=fdMode?createFdHookOutput():hookOutput(), stream=output.stream;
const nativeWrite=stream.write.bind(stream);
let pending,intercepted=false;
stream.write=function(chunk,encoding,callback){
 if(typeof encoding==='function'){callback=encoding;encoding=undefined;}
 if(!intercepted && String(chunk).includes('"hookSpecificOutput"')){
  intercepted=true; pending={chunk,encoding,callback}; process.send?.({phase:'queued'});
  if(mode==='stall') { const until=Date.now()+1250; while(Date.now()<until){}; return nativeWrite(chunk,encoding,callback); }
  if(mode!=='backpressure'||fdMode) return false;
 }
 return nativeWrite(chunk,encoding,callback);
};
if(mode==='backpressure') (fdMode?process.stdout.write.bind(process.stdout):nativeWrite)(Buffer.alloc(2*1024*1024,120));
process.on('message',(command)=>{
 if(command==='flush') nativeWrite(pending.chunk,pending.encoding,pending.callback);
 if(command==='fail') pending.callback?.(new Error('fixture failure'));
 if(command==='quit') process.exit(0);
});
const {main}=await import(${JSON.stringify(path.join(REPO, 'src/app/hook.ts'))});
await main(process.env,{output:()=>output}); process.send?.({phase:'returned'});
`,
  );
  const p = spawn(process.execPath, [script], {
    env: sb.env({ ROUTER_URL: url, MEMORY_SOURCE_ID: sourceId, ...extraEnv }),
    cwd: repo,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  const messages: string[] = [];
  let out = '';
  let err = '';
  const waiters: { name: string; resolve: () => void }[] = [];
  p.stdout!.on('data', (c) => {
    out += c;
  });
  if (mode === 'backpressure' || mode === 'fd-backpressure') p.stdout!.pause();
  p.stderr!.on('data', (c) => {
    err += c;
  });
  p.on('message', (m: any) => {
    messages.push(m.phase);
    for (const w of [...waiters])
      if (w.name === m.phase) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
  });
  const exited = new Promise<number | null>((resolve) => p.once('exit', (code) => resolve(code)));
  const closed = new Promise<number | null>((resolve) => p.once('close', (code) => resolve(code)));
  p.stdin!.end(JSON.stringify({ prompt: PROMPT }));
  const phase = async (name: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        messages.includes(name)
          ? Promise.resolve()
          : new Promise<void>((resolve) => waiters.push({ name, resolve })),
        exited.then(() => {
          throw Error(`hook exited before ${name}: ${err}`);
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Error(`hook phase ${name} unavailable`)), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    p,
    phase,
    exited,
    closed,
    output: () => out,
    stderr: () => err,
    stop: async () => {
      if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
      p.stdout!.resume();
      await closed;
    },
  };
}

test(
  'public reader projects scoped search/get with exact IDs/hash/provenance, FTS terms and no filesystem footprint',
  POSIX,
  async () => {
    const f = await fixture();
    let reader: SqlitePublicReadOnly | undefined;
    try {
      const before = footprint(runtimePaths(process.env).home);
      reader = new SqlitePublicReadOnly(f.readOptions, Date.now);
      assert.deepEqual(
        footprint(runtimePaths(process.env).home),
        before,
        'constructor does not open primary/backup or change any sidecars',
      );
      const hits = await reader.search({ text: 'rename cart' }, f.ctx);
      assert.deepEqual(
        hits.map((m) => m.id).sort(),
        [f.own, f.personal, f.shared, f.session].map((m) => m.id).sort(),
      );
      assert.ok(hits.every((m) => m.rank < 0 && m.matched! >= 2));
      assert.deepEqual(await reader.get(f.own.id, f.ctx), f.own);
      assert.equal((await reader.search({ text: 'cart', tags: ['cart'] }, f.ctx))[0].id, f.own.id);
      assert.equal(
        (await reader.search({ text: 'cart', category: 'personal' }, f.ctx))[0].id,
        f.personal.id,
      );
      assert.ok(
        (await reader.search({ text: 'cart' }, { ...f.ctx, linked: ['p_b'] })).some(
          (m) => m.id === f.foreign.id,
        ),
      );
      for (const m of [f.foreign, f.secret, f.unknown])
        await assert.rejects(reader.get(m.id, f.ctx), error('not_found'));
      await assert.rejects(reader.get(f.own.id, f.ctx, { events: true }), error('invalid'));
      assert.doesNotMatch(
        JSON.stringify(hits),
        new RegExp(PRIVATE + '|backup_name|backup_hash|source_id|publication_id|generation'),
      );
      assert.deepEqual(
        footprint(runtimePaths(process.env).home),
        before,
        'lease queries have no retention/access/telemetry writes',
      );
      reader.close();
      reader.close();
      assert.deepEqual(footprint(runtimePaths(process.env).home), before, 'native close keeps footprint');
    } finally {
      reader?.close();
      f.close();
    }
  },
);

test(
  'public reader validates query inputs and escaped FTS before content queries; ordinary finite-expiry reads remain query-time only',
  POSIX,
  async () => {
    const f = await fixture();
    const reader = new SqlitePublicReadOnly(f.readOptions, Date.now);
    try {
      for (const query of [
        { limit: 0 },
        { limit: 51 },
        { text: 'x'.repeat(20001) },
        { includePrivate: true },
        { touch: true },
        { status: ['archived'] },
        { tags: ['x; DROP TABLE public_memories'] },
      ])
        await assert.rejects(reader.search(query as never, f.ctx), error('invalid'));
      await assert.rejects(
        reader.search({}, { ...f.ctx, linked: Array(51).fill('p_b') }),
        error('invalid'),
      );
      await assert.rejects(reader.get('', f.ctx), error('invalid'));
      for (const query of [
        'cart" OR "rename',
        'cart); DROP TABLE public_memories; --',
        'NEAR(cart rename)',
        '* : ^',
      ])
        await reader.search({ text: query }, f.ctx);
      assert.deepEqual(await reader.search({ text: 'the of a' }, f.ctx), []);
      reader.close();
      await assert.rejects(reader.get(f.own.id, f.ctx), error());
    } finally {
      reader.close();
      f.close();
    }
    const finite = await fixture({ finite: true });
    let now = Date.now();
    try {
      const ordinary = new SqlitePublicReadOnly(finite.readOptions, () => now);
      assert.equal((await ordinary.get(finite.session.id, finite.ctx)).id, finite.session.id);
      now += 1001;
      await assert.rejects(ordinary.get(finite.session.id, finite.ctx), error());
      ordinary.close();
      assert.throws(
        () => new SqlitePublicReadOnly(finite.readOptions, () => now),
        error(),
        'earliest-expiry stale READY is held without archive/refresh',
      );
    } finally {
      finite.close();
    }
  },
);

test(
  'independent expected epoch is mandatory; missing/wrong/malformed binding and any explicit/unknown view hold without downgrade',
  POSIX,
  async () => {
    const f = await fixture();
    try {
      const before = footprint(runtimePaths(process.env).home);
      for (const sourceId of ['', 'not-a-uuid', crypto.randomUUID()])
        assert.throws(
          () => openHookMemory({ primary: f.paths.primary, sourceId }, Date.now),
          error(),
        );
      assert.throws(
        () =>
          openHookMemory(
            {
              primary: f.paths.primary,
              view: path.join(path.dirname(f.paths.view), 'missing.db'),
              sourceId: f.floor.sourceId,
            },
            Date.now,
          ),
        error(),
      );
      assert.deepEqual(footprint(runtimePaths(process.env).home), before);
      const reader = openHookMemory(
        { primary: f.paths.primary, sourceId: f.floor.sourceId },
        Date.now,
      );
      assert.equal((await reader.get(f.own.id, f.ctx)).id, f.own.id);
      reader.close();
      fs.renameSync(f.paths.view, f.paths.view + '.reserved');
      assert.throws(
        () => openHookMemory({ primary: f.paths.primary, sourceId: f.floor.sourceId }, Date.now),
        error(),
      );
      assert.throws(
        () => openHookMemory({ primary: f.paths.primary }, Date.now),
        error(),
        'unbound default WAL remains held',
      );
    } finally {
      f.close();
    }
    const old = await fixture({ published: false });
    try {
      const before = footprint(runtimePaths(process.env).home);
      assert.throws(
        () => new SqlitePublicReadOnly(old.readOptions, Date.now),
        error(),
        'gate-only floor-1 has no public admission',
      );
      assert.deepEqual(footprint(runtimePaths(process.env).home), before);
    } finally {
      old.close();
    }
  },
);

test(
  'schema/format/readiness/generation/epoch/publication/time/data mismatch stays finite and unchanged',
  POSIX,
  async () => {
    const changes = [
      'CREATE TABLE foreign_schema(x)',
      "UPDATE bosun_public_state SET state='HOLD'",
      'UPDATE bosun_public_state SET generation=-1',
      `UPDATE bosun_public_state SET source_id='${crypto.randomUUID()}'`,
      `UPDATE bosun_cutover_gate SET source_id='${crypto.randomUUID()}'`,
      "UPDATE bosun_public_state SET publication_id='bad'",
      'UPDATE bosun_public_state SET published_at=8640000000000000',
      'UPDATE bosun_public_state SET valid_until=1',
      "UPDATE public_memories SET hash='bad'",
      "UPDATE public_memories SET tags='bad'",
      'PRAGMA ignore_check_constraints=ON; UPDATE bosun_public_state SET format=1',
      "PRAGMA ignore_check_constraints=ON; UPDATE public_memories SET private=1,title='PRIVATE-AUDIT-BACKUP-CANARY'",
      "UPDATE bosun_cutover_gate SET phase='backed'",
      "UPDATE bosun_cutover_gate SET view_ino='0'",
    ];
    for (const sql of changes) {
      const f = await fixture();
      let reader: SqlitePublicReadOnly | undefined;
      try {
        mutateView(f.paths.view, (db) => db.exec(sql));
        const before = footprint(runtimePaths(process.env).home);
        try {
          reader = new SqlitePublicReadOnly(f.readOptions, Date.now);
          await assert.rejects(reader.search({ text: 'cart' }, f.ctx), error());
        } catch (e) {
          assert.ok(error()(e), `finite rejection: ${sql}`);
        }
        reader?.close();
        assert.deepEqual(footprint(runtimePaths(process.env).home), before);
      } finally {
        reader?.close();
        f.close();
      }
    }
  },
);

test(
  'canonical paths, aliases, inode replacements, modes, source headers, oversized files and dangling journals fail before native recovery',
  POSIX,
  async () => {
    for (const kind of [
      'view-inode',
      'source-inode',
      'symlink',
      'hardlink',
      'mode',
      'special-mode',
      'oversized',
      'journal',
      'dangling',
      'wal',
      'uri',
      'truncate',
      'corrupt-source',
      'offline-restore',
      'source-wal-size',
      'source-wal-header',
      'source-wal-mode',
      'source-wal-dangling',
    ]) {
      const f = await fixture();
      try {
        let candidate = { ...f.readOptions };
        if (kind === 'view-inode' || kind === 'source-inode') {
          const file = kind === 'view-inode' ? f.paths.view : f.paths.primary;
          const copy = file + '.copy';
          fs.copyFileSync(file, copy);
          fs.renameSync(copy, file);
        }
        if (kind === 'symlink') {
          const alias = f.paths.view + '.alias';
          fs.symlinkSync(f.paths.view, alias);
          candidate.view = alias;
        }
        if (kind === 'hardlink') fs.linkSync(f.paths.view, f.paths.view + '.alias');
        if (kind === 'mode') fs.chmodSync(f.paths.view, 0o644);
        if (kind === 'special-mode') fs.chmodSync(f.paths.view, 0o1600);
        if (kind === 'oversized') fs.truncateSync(f.paths.view, VIEW_MAX_BYTES + 1);
        if (kind === 'source-wal-size')
          fs.truncateSync(
            f.paths.primary + '-wal',
            64 * 1024 * 1024 - fs.statSync(f.paths.primary).size + 1,
          );
        if (kind === 'source-wal-header') {
          const fd = fs.openSync(f.paths.primary + '-wal', 'r+');
          try {
            fs.writeSync(fd, Buffer.alloc(4), 0, 4, 0);
          } finally {
            fs.closeSync(fd);
          }
        }
        if (kind === 'source-wal-mode') fs.chmodSync(f.paths.primary + '-wal', 0o644);
        if (kind === 'source-wal-dangling') {
          fs.renameSync(f.paths.primary + '-wal', f.paths.primary + '-wal.saved');
          fs.symlinkSync(path.join(f.sb.root, 'never-created'), f.paths.primary + '-wal');
        }
        if (kind === 'journal' || kind === 'wal')
          fs.writeFileSync(f.paths.view + (kind === 'journal' ? '-journal' : '-wal'), PRIVATE);
        if (kind === 'dangling')
          fs.symlinkSync(path.join(f.sb.root, 'never-created'), f.paths.view + '-journal');
        if (kind === 'uri') candidate.view = 'file:' + f.paths.view + '?immutable=1';
        if (kind === 'truncate') fs.truncateSync(f.paths.primary, 0);
        if (kind === 'corrupt-source') {
          const fd = fs.openSync(f.paths.primary, 'r+');
          try {
            fs.writeSync(fd, Buffer.from('broken'), 0, 6, 0);
          } finally {
            fs.closeSync(fd);
          }
        }
        if (kind === 'offline-restore')
          fs.writeFileSync(
            f.paths.primary,
            fs.readFileSync(path.join(f.paths.backups, f.floor.attemptId + '.db')),
          );
        const before = footprint(runtimePaths(process.env).home);
        assert.throws(() => new SqlitePublicReadOnly(candidate, Date.now), error());
        assert.deepEqual(footprint(runtimePaths(process.env).home), before, kind);
      } finally {
        f.close();
      }
    }
  },
);

test(
  'reader independently enforces encoded and row ceilings inside the physical bound without projecting content',
  POSIX,
  async () => {
    for (const kind of ['encoded', 'rows']) {
      const f = await fixture();
      try {
        mutateView(f.paths.view, (db) => {
          const base = db.prepare('SELECT * FROM public_memories WHERE id=?').get(f.own.id)!;
          const keys = Object.keys(base);
          const insert = db.prepare(
            `INSERT INTO public_memories(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
          );
          db.exec('BEGIN IMMEDIATE');
          try {
            for (let i = 0; i < (kind === 'encoded' ? 1450 : PUBLIC_MAX_ROWS); i++) {
              const title = `Bound cart ${i}`;
              const body = kind === 'encoded' ? '漢'.repeat(4000) : 'bounded cart';
              const hash = crypto
                .createHash('sha256')
                .update(norm(`${title}\n${body}`))
                .digest('hex')
                .slice(0, 32);
              const row: Record<string, any> = {
                ...base,
                seq: 100 + i,
                id: `bound_${i}`,
                title,
                body,
                hash,
              };
              insert.run(...keys.map((key) => row[key]));
            }
            db.exec('COMMIT');
          } catch (e) {
            db.exec('ROLLBACK');
            throw e;
          }
          if (kind === 'encoded') {
            const records = db.prepare('SELECT * FROM public_memories').all();
            assert.ok(records.length < PUBLIC_MAX_ROWS);
            assert.ok(
              records.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0) >
                PUBLIC_MAX_BYTES,
            );
          }
        });
        assert.ok(
          fs.statSync(f.paths.view).size < VIEW_MAX_BYTES,
          'logical limits are checked before any scoped DTO/hash',
        );
        const before = footprint(runtimePaths(process.env).home);
        assert.throws(() => new SqlitePublicReadOnly(f.readOptions, Date.now), error());
        assert.deepEqual(footprint(runtimePaths(process.env).home), before);
      } finally {
        f.close();
      }
    }
  },
);

test(
  'source WAL absent/empty housekeeping remains read-only while retained WAL inode replacements and aliases hold',
  POSIX,
  async () => {
    const f = await fixture();
    let reader: SqlitePublicReadOnly | undefined;
    try {
      reader = new SqlitePublicReadOnly(f.readOptions, Date.now);
      fs.renameSync(f.paths.primary + '-wal', f.paths.primary + '-wal.saved');
      assert.deepEqual(
        await reader.get(f.own.id, f.ctx),
        f.own,
        'absent WAL is permitted without opening primary SQLite',
      );
      fs.writeFileSync(f.paths.primary + '-wal', '', { mode: 0o600 });
      await assert.rejects(reader.get(f.own.id, f.ctx), error());
      reader.close();
      reader = undefined;
      const empty = new SqlitePublicReadOnly(f.readOptions, Date.now);
      assert.deepEqual(await empty.get(f.own.id, f.ctx), f.own);
      empty.close();
      fs.unlinkSync(f.paths.primary + '-wal');
      fs.linkSync(f.paths.primary, f.paths.primary + '-wal');
      assert.throws(() => new SqlitePublicReadOnly(f.readOptions, Date.now), error());
      fs.unlinkSync(f.paths.primary + '-wal');
      fs.renameSync(f.paths.primary + '-wal.saved', f.paths.primary + '-wal');
    } finally {
      reader?.close();
      f.close();
    }
  },
);

test(
  'malformed dependency getters/proxies stay finite before filesystem effects; scoped decoding ignores foreign content',
  POSIX,
  async () => {
    const f = await fixture();
    try {
      const before = footprint(runtimePaths(process.env).home);
      const getter = Object.defineProperty({}, 'sourceId', {
        get() {
          throw Error(PRIVATE);
        },
      });
      const proxy = new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw Error(PRIVATE);
          },
        },
      );
      for (const input of [getter, proxy]) {
        assert.throws(() => new SqlitePublicReadOnly(input as never, Date.now), error());
        assert.throws(() => openHookMemory(input as never, Date.now), error('invalid'));
      }
      const extra = Object.defineProperty({ ...f.readOptions }, 'private_extra', {
        get() {
          throw Error(PRIVATE);
        },
      });
      const reader = new SqlitePublicReadOnly(extra, Date.now);
      await assert.rejects(reader.search(proxy, f.ctx), error('invalid'));
      await assert.rejects(reader.search({}, proxy as Ctx), error('invalid'));
      const eventGetter = Object.defineProperty({}, 'events', {
        get() {
          throw Error(PRIVATE);
        },
      });
      await assert.rejects(reader.get(f.own.id, f.ctx, eventGetter), error('invalid'));
      reader.close();
      assert.deepEqual(footprint(runtimePaths(process.env).home), before);
      const originalStat = fs.lstatSync;
      for (const message of [PRIVATE, 'local memory unavailable (path)']) {
        const typed = Object.assign(new MemoryError('unavailable', message), {
          private_extra: PRIVATE,
        });
        fs.lstatSync = (() => {
          throw typed;
        }) as typeof fs.lstatSync;
        try {
          assert.throws(
            () =>
              openHookMemory({ primary: f.paths.primary, sourceId: f.floor.sourceId }, Date.now),
            (e) => {
              assert.ok(error()(e));
              assert.doesNotMatch(JSON.stringify(e), new RegExp(PRIVATE));
              assert.notEqual(e, typed);
              return true;
            },
          );
        } finally {
          fs.lstatSync = originalStat;
        }
      }
      mutateView(f.paths.view, (db) =>
        db.prepare("UPDATE public_memories SET tags='bad',hash='bad' WHERE id=?").run(f.foreign.id),
      );
      const scoped = new SqlitePublicReadOnly(f.readOptions, Date.now);
      assert.equal((await scoped.get(f.own.id, f.ctx)).id, f.own.id);
      assert.ok((await scoped.search({ text: 'cart' }, f.ctx)).every((m) => m.id !== f.foreign.id));
      await assert.rejects(scoped.get(f.foreign.id, { ...f.ctx, linked: ['p_b'] }), error());
      scoped.close();
    } finally {
      f.close();
    }
  },
);

test(
  'encoded aggregate matches publisher JSON for multibyte, quotation, backslash and control characters',
  POSIX,
  async () => {
    const f = await fixture();
    const writer = openTestLocalMemory(f.paths);
    try {
      const weird = (
        await writer.store(
          {
            category: 'personal',
            title: 'Encoded cart 漢語 😀',
            body: 'rename cart quotation " slash / backslash \\ control \u0001 \u0002 \t \r \n 漢語 😀',
            sourceRef: 'ref " \\ \u0001 😀',
          },
          f.ctx,
        )
      ).memory;
      await publishMemoryView(options(f.paths));
      mutateView(f.paths.view, (db) => {
        const records = db.prepare('SELECT * FROM public_memories ORDER BY seq').all();
        const keys = Object.keys(records[0]);
        const sqlBytes = db
          .prepare(
            `SELECT sum(length(CAST(json_object(${keys.map((key) => `'${key}',${key}`).join(',')}) AS BLOB))) AS n FROM public_memories`,
          )
          .get()!.n;
        assert.equal(
          sqlBytes,
          records.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0),
        );
      });
      const reader = new SqlitePublicReadOnly(f.readOptions, Date.now);
      assert.deepEqual(await reader.get(weird.id, f.ctx), weird);
      reader.close();
    } finally {
      writer.close();
      f.close();
    }
  },
);

test(
  'retained native public lease blocks registered source revocation before primary DML and release allows HOLD mutation',
  POSIX,
  async () => {
    const f = await fixture();
    const writer = openTestLocalMemory(f.paths);
    let reader: SqlitePublicReadOnly | undefined;
    try {
      const sourceBefore = f.db.prepare('SELECT * FROM memories WHERE id=?').get(f.own.id);
      const generation = f.db
        .prepare('SELECT generation FROM bosun_source_floor')
        .get()!.generation;
      const before = fs.readFileSync(f.paths.view);
      reader = new SqlitePublicReadOnly(f.readOptions, Date.now);
      await assert.rejects(writer.update(f.own.id, { private: true }, 1, f.ctx), writerBusy);
      assert.deepEqual(
        f.db.prepare('SELECT * FROM memories WHERE id=?').get(f.own.id),
        sourceBefore,
      );
      assert.equal(
        f.db.prepare('SELECT generation FROM bosun_source_floor').get()!.generation,
        generation,
      );
      assert.equal((await reader.get(f.own.id, f.ctx)).private, false);
      assert.deepEqual(
        fs.readFileSync(f.paths.view),
        before,
        'blocked writer cannot change public state or rows; writer attempts may touch telemetry/directory metadata',
      );
      reader.close();
      assert.equal((await writer.update(f.own.id, { private: true }, 1, f.ctx)).private, true);
      assert.throws(() => new SqlitePublicReadOnly(f.readOptions, Date.now), error());
      await publishMemoryView(options(f.paths));
      const after = new SqlitePublicReadOnly(f.readOptions, Date.now);
      await assert.rejects(after.get(f.own.id, f.ctx), error('not_found'));
      after.close();
    } finally {
      reader?.close();
      writer.close();
      f.close();
    }
  },
);

test(
  'lease rechecks source/view inode and nonmonotonic clock; publication metadata is pinned to its retained snapshot',
  POSIX,
  async () => {
    for (const kind of ['view', 'source', 'clock']) {
      const f = await fixture();
      let now = Date.now();
      const reader = new SqlitePublicReadOnly(f.readOptions, () => now);
      try {
        if (kind === 'clock') now -= 1;
        else {
          const file = kind === 'view' ? f.paths.view : f.paths.primary;
          fs.copyFileSync(file, file + '.copy');
          fs.renameSync(file + '.copy', file);
        }
        await assert.rejects(reader.search({ text: 'cart' }, f.ctx), error());
      } finally {
        reader.close();
        f.close();
      }
    }
  },
);

test(
  'actual owner CLI hook uses explicit public binding, retains the view through native stdout, and releases before source privatization',
  POSIX,
  async () => {
    const f = await fixture();
    const router = await mock();
    const writer = openTestLocalMemory(f.paths);
    let child: ReturnType<typeof hook> | undefined;
    try {
      const viewBefore = footprint(path.dirname(f.paths.view));
      for (const sourceId of ['', crypto.randomUUID()]) {
        publishFixtureHook(f.sb, f.paths, sourceId || null);
        const held = await bosun(['route', '--hook'], {
          env: f.sb.env({ ROUTER_URL: router.url, MEMORY_SOURCE_ID: sourceId }),
          cwd: f.repo,
          input: JSON.stringify({ prompt: PROMPT }),
        });
        assert.equal(held.code, 0);
        assert.doesNotMatch(
          held.out,
          new RegExp(PUBLIC),
          'missing/wrong binding holds an otherwise READY view',
        );
      }
      publishFixtureHook(f.sb, f.paths, f.floor.sourceId);
      const admitted = await bosun(['route', '--hook'], {
        env: f.sb.env({ ROUTER_URL: router.url, MEMORY_SOURCE_ID: f.floor.sourceId }),
        cwd: f.repo,
        input: JSON.stringify({ prompt: PROMPT }),
      });
      assert.equal(admitted.code, 0);
      assert.match(admitted.out, new RegExp(PUBLIC));
      assert.deepEqual(
        footprint(path.dirname(f.paths.view)),
        viewBefore,
        'real CLI reading retains zero view footprint',
      );
      child = hook(f.sb, f.repo, router.url, f.floor.sourceId);
      await child.phase('queued');
      await assert.rejects(writer.update(f.own.id, { private: true }, 1, f.ctx), writerBusy);
      assert.equal(child.output(), '');
      child.p.send('flush');
      await child.phase('returned');
      await tick();
      assert.match(child.output(), new RegExp(PUBLIC));
      assert.doesNotMatch(
        child.output() + child.stderr(),
        new RegExp(PRIVATE + '|backup_hash|source_id|generation'),
      );
      assert.equal((await writer.update(f.own.id, { private: true }, 1, f.ctx)).private, true);
      const absent = await bosun(['route', '--hook'], {
        env: f.sb.env({ ROUTER_URL: router.url }),
        cwd: f.repo,
        input: JSON.stringify({ prompt: PROMPT }),
      });
      assert.equal(absent.code, 0);
      assert.doesNotMatch(absent.out, new RegExp(PUBLIC));
    } finally {
      await child?.stop();
      writer.close();
      await router.close();
      f.close();
    }
  },
);

test(
  'source hook joins a closed-pipe producer without late EPIPE errors or a retained public-view lease',
  POSIX,
  async () => {
    const f = await fixture();
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const input = JSON.stringify({ prompt: PROMPT, cwd: f.repo });
      const control = await bosun(['route', '--hook'], { env: f.sb.env(), cwd: f.repo, input });
      assert.equal(control.code, 0, control.err);
      assert.ok(
        control.out.includes(PUBLIC),
        'the independently bound view must deliver useful notes',
      );
      child = childProcess.spawn(process.execPath, [
        ...(process.versions.bun ? ['--no-env-file', '--no-install'] : []),
        BIN, 'route', '--hook',
      ], {
        env: f.sb.env(),
        cwd: f.repo,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr!.on('data', (value) => {
        stderr += value;
      });
      const closed = new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          child!.once('error', reject);
          child!.once('close', (code, signal) => resolve({ code, signal }));
        },
      );
      child.stdout!.destroy();
      child.stdin!.end(input);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(Error('closed-pipe hook did not exit')), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      assert.doesNotMatch(stderr, /EPIPE|Unhandled|PUBLIC-VIEW|PRIVATE-AUDIT/);

      const writer = openTestLocalMemory(f.paths);
      try {
        assert.equal((await writer.update(f.own.id, { private: true }, 1, f.ctx)).private, true);
      } finally {
        writer.close();
      }
      await publishMemoryView(options(f.paths));
      const hidden = await bosun(['route', '--hook'], { env: f.sb.env(), cwd: f.repo, input });
      assert.equal(hidden.code, 0, hidden.err);
      assert.doesNotMatch(hidden.out, new RegExp(PUBLIC));
      assert.deepEqual(f.sb.calls(), []);
    } finally {
      if (child?.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) => child!.once('close', () => resolve()));
        child.kill('SIGKILL');
        await closed;
      }
      f.close();
    }
  },
);

test(
  'actual public hook failed write/signal/SIGKILL/backpressure retains lease to teardown and cannot accept late memory',
  POSIX,
  async () => {
    for (const cause of ['fail', 'signal', 'kill', 'backpressure']) {
      const f = await fixture();
      const router = await mock();
      const writer = openTestLocalMemory(f.paths);
      let child: ReturnType<typeof hook> | undefined;
      try {
        child = hook(
          f.sb,
          f.repo,
          router.url,
          f.floor.sourceId,
          cause === 'backpressure' ? cause : 'gate',
        );
        await child.phase('queued');
        await assert.rejects(writer.update(f.own.id, { private: true }, 1, f.ctx), writerBusy);
        if (cause === 'fail') child.p.send('fail');
        if (cause === 'signal') child.p.kill('SIGTERM');
        if (cause === 'kill') child.p.kill('SIGKILL');
        await child.exited;
        assert.equal((await writer.update(f.own.id, { private: true }, 1, f.ctx)).private, true);
        child.p.stdout!.resume();
        await child.closed;
        assert.doesNotMatch(
          child.output() + child.stderr(),
          new RegExp(PUBLIC + '|' + PRIVATE + '|hookSpecificOutput'),
        );
      } finally {
        await child?.stop();
        writer.close();
        await router.close();
        f.close();
      }
    }
  },
);

test('explicit native fs hook write retains the real reader through its original callback', POSIX, async () => {
  const f = await fixture(), router = await mock(), writer = openTestLocalMemory(f.paths);
  let child: ReturnType<typeof hook> | undefined;
  try {
    const before = footprint(path.dirname(f.paths.view));
    child = hook(f.sb, f.repo, router.url, f.floor.sourceId, 'fd-gate');
    await child.phase('queued');
    assert.deepEqual(footprint(path.dirname(f.paths.view)), before);
    await assert.rejects(writer.update(f.own.id, { private: true }, 1, f.ctx), writerBusy);
    const blocked = footprint(path.dirname(f.paths.view));
    assert.equal(child.output(), '');
    child.p.send('flush'); await child.phase('returned'); await tick();
    assert.match(child.output(), new RegExp(PUBLIC));
    assert.doesNotMatch(child.output() + child.stderr(), new RegExp(PRIVATE));
    assert.deepEqual(footprint(path.dirname(f.paths.view)), blocked);
    assert.equal((await writer.update(f.own.id, { private: true }, 1, f.ctx)).private, true);
    assert.deepEqual(f.sb.calls(), []);
  } finally { await child?.stop(); writer.close(); await router.close(); f.close(); }
});

test('uncertain explicit fs hook writes hold their lease until the original producer is killed and joined', POSIX, async () => {
  for (const cause of ['fail', 'signal', 'backpressure']) {
    const f = await fixture(), router = await mock(), writer = openTestLocalMemory(f.paths);
    let child: ReturnType<typeof hook> | undefined;
    try {
      child = hook(f.sb, f.repo, router.url, f.floor.sourceId, cause === 'backpressure' ? 'fd-backpressure' : 'fd-gate');
      await child.phase('queued');
      await assert.rejects(writer.update(f.own.id, { private: true }, 1, f.ctx), writerBusy);
      if (cause === 'fail') child.p.send('fail');
      if (cause === 'signal') child.p.kill('SIGTERM');
      if (cause === 'backpressure') child.p.send('flush');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([child.exited, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error('original producer did not terminate')), 5000); })]); }
      finally { clearTimeout(timer); }
      assert.equal(child.p.signalCode, 'SIGKILL');
      assert.equal((await writer.update(f.own.id, { private: true }, 1, f.ctx)).private, true);
      child.p.stdout!.resume(); await child.closed;
      assert.doesNotMatch(child.output() + child.stderr(), new RegExp(PUBLIC + '|' + PRIVATE + '|hookSpecificOutput'));
      assert.deepEqual(f.sb.calls(), []);
    } finally { await child?.stop(); writer.close(); await router.close(); f.close(); }
  }
});

test(
  'local public handoff omits finite-expiry records before packing under real backpressure and a stalled event loop',
  POSIX,
  async () => {
    for (const mode of ['gate', 'backpressure', 'stall']) {
      const f = await fixture({ finite: true });
      const router = await mock();
      let child: ReturnType<typeof hook> | undefined;
      try {
        const ordinary = new SqlitePublicReadOnly(f.readOptions, Date.now);
        assert.equal((await ordinary.get(f.session.id, f.ctx)).id, f.session.id);
        ordinary.close();
        const local = openHookMemory(
          { primary: f.paths.primary, sourceId: f.floor.sourceId },
          Date.now,
        );
        await assert.rejects(local.get(f.session.id, f.ctx), error('not_found'));
        local.close();
        child = hook(f.sb, f.repo, router.url, f.floor.sourceId, mode);
        await child.phase('queued');
        if (mode === 'gate') {
          child.p.send('flush');
          await child.phase('returned');
        }
        if (mode === 'stall') {
          await child.exited;
          await child.closed;
        }
        if (mode === 'backpressure') {
          await child.exited;
          child.p.stdout!.resume();
          await child.closed;
        }
        await tick();
        assert.doesNotMatch(child.output(), new RegExp(FINITE));
        if (mode !== 'backpressure')
          assert.match(
            child.output(),
            new RegExp(PUBLIC),
            'useful non-expiring content can be accepted even after finite note expires',
          );
      } finally {
        await child?.stop();
        await router.close();
        f.close();
      }
    }
  },
);

test(
  'actual hot rollback spill journal holds the public reader and selector without recovery or filesystem changes',
  POSIX,
  async () => {
    const f = await fixture({ extra: 100 });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const beforeBytes = fs.readFileSync(f.paths.view);
      const script = path.join(f.sb.root, 'spill.mjs');
      fs.writeFileSync(
        script,
        `await import(${JSON.stringify(path.join(REPO, 'test/bootstrap.ts'))});
const {SqliteDatabase}=await import(${JSON.stringify(path.join(REPO, 'src/platform/sqlite.ts'))}); const db=new SqliteDatabase(${JSON.stringify(f.paths.view)});
db.exec('PRAGMA cache_size=8; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
db.prepare('UPDATE public_memories SET body=?').run('spill cart '+ 'y'.repeat(3000));
process.send?.({phase:'spilled'}); setInterval(()=>{},1000);`,
      );
      child = spawn(process.execPath, [script], {
        env: f.sb.env(),
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      await new Promise<void>((resolve, reject) => {
        child!.on('message', (m: any) => {
          if (m.phase === 'spilled') resolve();
        });
        child!.once('error', reject);
        child!.once('exit', () => reject(Error('spill boundary missing')));
      });
      assert.equal(
        fs
          .readFileSync(f.paths.view + '-journal')
          .subarray(0, 8)
          .toString('hex'),
        'd9d505f920a163d7',
      );
      assert.equal(
        fs.readFileSync(f.paths.view).equals(beforeBytes),
        false,
        'dirty pages reached view before process crash',
      );
      const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
      const before = footprint(runtimePaths(process.env).home);
      assert.throws(() => new SqlitePublicReadOnly(f.readOptions, Date.now), error());
      assert.throws(
        () => openHookMemory({ primary: f.paths.primary, sourceId: f.floor.sourceId }, Date.now),
        error(),
      );
      assert.deepEqual(
        footprint(runtimePaths(process.env).home),
        before,
        'ordinary read never invokes native journal recovery',
      );
    } finally {
      if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      f.close();
    }
  },
);
