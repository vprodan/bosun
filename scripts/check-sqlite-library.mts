// App-free qualification of the explicitly selected native binding, never owner data.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type NativeSqliteDatabase from 'better-sqlite3';
import type { NativeSqliteFunction, NativeSqliteStatement } from 'better-sqlite3';
import type * as TestRuntime from './test-runtime.cjs';
import type * as TestEnvironment from './test-env.cjs';
interface QualificationStatement extends Omit<NativeSqliteStatement, 'safeIntegers'> {
  readonly busy: boolean;
  safeIntegers(enabled: boolean): QualificationStatement;
}
interface BackupProgress {
  totalPages: number;
  remainingPages: number;
}
interface QualificationDatabase extends Omit<NativeSqliteDatabase, 'prepare' | 'function' | 'setAuthorizer' | 'backup'> {
  prepare(sql: string): QualificationStatement;
  function(name: string, callback: NativeSqliteFunction): QualificationDatabase;
  function(name: string, options: { deterministic?: boolean; safeIntegers?: boolean }, callback: NativeSqliteFunction): QualificationDatabase;
  // Deliberately accepts invalid callback results: this checker exercises native rejection.
  setAuthorizer(callback: ((action: number, first: string | null, second: string | null, database: string | null, trigger: string | null) => unknown) | null): QualificationDatabase;
  pragma(sql: string, options: { simple: true }): unknown;
  backup(filename: string, options?: { progress?: (state: BackupProgress) => number }): Promise<BackupProgress>;
}
interface QualificationSqliteError extends Error {
  code: string;
  errcode: number;
}
interface QualificationDatabaseConstructor {
  new(filename: string, options: { readonly?: boolean; timeout: number }): QualificationDatabase;
  SqliteError: new(message: string, code: string) => QualificationSqliteError;
}
const require = createRequire(import.meta.url);
const { assertRuntime, createRun, launch } = require('./test-runtime.cjs') as typeof TestRuntime;
const { cleanupRun } = require('./test-env.cjs') as typeof TestEnvironment;
assertRuntime();
const repo = path.resolve(import.meta.dirname, '..');
const candidate = path.join(repo, '.omp/tooling/sqlite-native-13.0.3/candidate/better-sqlite3');
const installed = path.join(repo, 'node_modules/better-sqlite3');
if (process.argv[2] !== '--worker') {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--candidate')) throw Error('Usage: check-sqlite-library.mts [--candidate]');
  const selected = args.length ? candidate : installed;
  const root = createRun('bosun-sqlite-library');
  try {
    // Application preload deliberately requires the installed package; initial
    // candidate admission instead uses the inherited OS barrier and no app imports.
    const result = launch(root, [path.join(repo, 'scripts/check-sqlite-library.mts'), '--worker', root, selected], { guarded: false });
    process.exitCode = result.status ?? 1;
  } finally { cleanupRun(root); }
} else {
  const root = process.argv[3], selected = process.argv[4];
  if (!process.env.BOSUN_TEST_SANDBOX || ![candidate, installed].includes(selected)
    || !path.isAbsolute(root) || fs.realpathSync(root) !== root) throw Error('Native library qualification containment missing');
  // The selected trusted native module is loaded only after the OS barrier.
  const Database = require(path.join(selected, 'lib/index.js')) as QualificationDatabaseConstructor;
  const nextTurn = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));
  const withinDeadline = async <T,>(promise: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Native backup promise did not settle')), 10000);
      })]);
    } finally { clearTimeout(timer); }
  };
  const memory = new Database(':memory:', { timeout: 0 });
  const sqlite = memory.prepare('SELECT sqlite_version() AS version').get()!.version;
  assert.ok(typeof sqlite === 'string');
  const parts = sqlite.split('.').map(Number);
  assert.equal(parts[0], 3);
  assert.ok(parts[1] > 51 || parts[1] === 51 && parts[2] >= 3 || parts[1] === 50 && parts[2] >= 7 || parts[1] === 44 && parts[2] >= 6, 'Patched WAL engine required');
  assert.equal(memory.location(), null);
  memory.setConnectionControls(false, true, false);
  assert.throws(() => memory.loadExtension(path.join(root, 'never-loaded.dylib')));
  assert.throws(() => memory.prepare('SELECT "not_a_column"').get());
  memory.function('sum_public', { deterministic: true }, (left, right) => {
    assert.ok(typeof left === 'number' && typeof right === 'number');
    return left + right;
  });
  assert.equal(memory.prepare('SELECT sum_public(3,4) AS value').get()!.value, 7);
  const integer = memory.prepare('SELECT ? AS value');
  assert.throws(() => integer.get(9007199254740993n), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ERR_OUT_OF_RANGE');
  assert.equal(integer.safeIntegers(true).get(9007199254740993n)!.value, 9007199254740993n);
  memory.function('integer_identity', { safeIntegers: true }, value => value);
  assert.equal(memory.prepare('SELECT integer_identity(?) AS value').safeIntegers(true).get(9007199254740993n)!.value, 9007199254740993n);
  const wideInteger = 9007199254740993n;
  const rows = memory.prepare('SELECT 1 AS value UNION ALL SELECT ? AS value');
  const outOfRange = (error: unknown): boolean => error instanceof RangeError && 'code' in error && error.code === 'ERR_OUT_OF_RANGE';
  assert.throws(() => rows.all(wideInteger), outOfRange);
  const unsafeCursor = rows.iterate(wideInteger);
  assert.deepEqual(unsafeCursor.next(), { value: { value: 1 }, done: false });
  assert.throws(() => unsafeCursor.next(), outOfRange);
  assert.equal(rows.busy, false);
  rows.safeIntegers(true);
  const exactRows = [{ value: 1n }, { value: wideInteger }];
  assert.deepEqual(rows.all(wideInteger), exactRows);
  assert.deepEqual([...rows.iterate(wideInteger)], exactRows);
  let unsafeUdfCalls = 0;
  memory.function('unsafe_integer_argument', value => { unsafeUdfCalls++; return value; });
  assert.throws(() => memory.prepare('SELECT unsafe_integer_argument(?) AS value').get(wideInteger), outOfRange);
  assert.equal(unsafeUdfCalls, 0, 'Unsafe UDF argument must fail before entering JavaScript');
  assert.equal(memory.prepare('SELECT unsafe_integer_argument(7) AS value').get()!.value, 7);
  assert.equal(unsafeUdfCalls, 1);
  const blobQuery = memory.prepare('SELECT typeof(?) AS kind, ? AS value');
  memory.function('blob_identity', value => value);
  const backing = new Uint8Array([99, 0, 255, 17, 88]);
  for (const bytes of [Buffer.from([0, 255, 17]), backing.subarray(1, 4), new Uint8Array(0)]) {
    const expected = Buffer.from(bytes);
    const bound = blobQuery.get(bytes, bytes)!;
    assert.equal(bound.kind, 'blob');
    assert.ok(Buffer.isBuffer(bound.value));
    assert.deepEqual(bound.value, expected);
    const echoed = memory.prepare('SELECT blob_identity(?) AS value').get(bytes)!.value;
    assert.ok(Buffer.isBuffer(echoed));
    assert.deepEqual(echoed, expected);
  }
  memory.function('typed_array_result', () => backing.subarray(1, 4));
  assert.deepEqual(memory.prepare('SELECT typed_array_result() AS value').get()!.value, Buffer.from([0, 255, 17]));
  memory.exec('CREATE TABLE protected_payload(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO protected_payload VALUES(1,\'public\')');
  const read = memory.prepare('SELECT value FROM protected_payload');
  let authorizations = 0;
  memory.setAuthorizer((action) => { authorizations++; return action === 11 ? 1 : 0; });
  assert.throws(() => memory.exec('DROP TABLE protected_payload'), (error: unknown) => error instanceof Database.SqliteError && error.errcode === 23);
  assert.equal(read.get()!.value, 'public');
  assert.ok(authorizations > 0);
  const failure = new Error('DOMAIN_CALLBACK_CANARY');
  memory.setAuthorizer(() => { throw failure; });
  assert.throws(() => memory.prepare('SELECT 1'), (error: unknown) => error === failure);
  memory.setAuthorizer(() => Promise.resolve(0));
  assert.throws(() => memory.prepare('SELECT 1'));
  memory.setAuthorizer(() => { memory.exec('SELECT 2'); return 0; });
  assert.throws(() => memory.prepare('SELECT 1'));
  memory.setAuthorizer((action, table, column) => action === 20 && table === 'protected_payload' && column === 'value' ? 2 : 0);
  assert.deepEqual(read.get(), { value: null }, 'SQLITE_IGNORE must redact the requested column');
  memory.setAuthorizer(null);
  assert.deepEqual(read.get(), { value: 'public' }, 'Removing IGNORE must reprepare the retained statement');
  for (const invalid of [undefined, null, false, '0', 3, NaN, 0n]) {
    memory.setAuthorizer(() => invalid);
    assert.throws(() => memory.prepare('SELECT value FROM protected_payload'), (error: unknown) =>
      error instanceof TypeError && /synchronously return SQLITE_OK, SQLITE_DENY, or SQLITE_IGNORE/.test(error.message));
    memory.setAuthorizer(null);
    assert.equal(read.get()!.value, 'public', 'Invalid authorizer must not poison later engine reads');
  }
  for (const primitive of ['PRIMITIVE_AUTHORIZER_CANARY', 17, null, undefined, true]) {
    memory.setAuthorizer(() => { throw primitive; });
    let caught = false;
    try { read.get(); } catch (error) { caught = true; assert.equal(error, primitive); }
    assert.equal(caught, true, 'Automatic statement reprepare must preserve primitive callback exceptions');
    memory.setAuthorizer(null);
    assert.equal(read.get()!.value, 'public', 'Retained statement must recover after failed reprepare');
  }
  let previousReads = 0, replacementReads = 0;
  memory.setAuthorizer(action => { if (action === 20) previousReads++; return 0; });
  assert.equal(read.get()!.value, 'public');
  assert.ok(previousReads > 0);
  memory.exec('CREATE TABLE reprepare_canary(value TEXT)');
  const previousCount = previousReads;
  memory.setAuthorizer(action => { if (action === 20) { replacementReads++; return 1; } return 0; });
  assert.throws(() => read.get(), (error: unknown) => error instanceof Database.SqliteError && error.errcode === 23);
  assert.ok(replacementReads > 0, 'Replacement must authorize retained statement reprepare');
  assert.equal(previousReads, previousCount, 'Replacement must release the old policy');
  memory.setAuthorizer(null);
  memory.close();
  const file = path.join(root, 'literal database.sqlite ');
  const db = new Database(file, { timeout: 0 });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE payload(id INTEGER PRIMARY KEY, value TEXT); CREATE VIRTUAL TABLE search USING fts5(value); INSERT INTO payload VALUES(1,\'committed public\'); INSERT INTO search VALUES(\'committed public\');');
  assert.equal(db.location(), file);
  assert.equal(fs.existsSync(file.trim()), false);
  const retained = db.prepare('SELECT value FROM payload');
  const retainedWrite = db.prepare('INSERT INTO payload VALUES(?,?)');
  db.exec('BEGIN IMMEDIATE; UPDATE payload SET value=\'uncommitted\'; INSERT INTO search VALUES(\'uncommitted\');');
  const iterator = retained.iterate(); iterator.next();
  db.close();
  assert.throws(() => retained.get());
  assert.throws(() => retainedWrite.run(2, 'must not replay'));
  assert.throws(() => iterator.next());
  const reopened = new Database(file, { timeout: 0 });
  reopened.exec('BEGIN IMMEDIATE');
  assert.equal(reopened.prepare('SELECT value FROM payload').get()!.value, 'committed public');
  assert.equal(reopened.prepare('SELECT count(*) AS n FROM search WHERE search MATCH \'uncommitted\'').get()!.n, 0);
  reopened.exec('COMMIT');
  const backup = path.join(root, ' backup destination.sqlite ');
  const trimmedBackup = backup.trim();
  const trimmedSentinel = Buffer.from('TRIMMED_BACKUP_MUST_NOT_BE_OVERWRITTEN');
  fs.writeFileSync(trimmedBackup, trimmedSentinel);
  await assert.rejects(reopened.backup(path.join(root, 'nul-backup\0.db')), (error: unknown) =>
    error instanceof TypeError && /NUL/.test(error.message));
  const result = await reopened.backup(backup);
  assert.equal(result.remainingPages, 0);
  assert.deepEqual(fs.readFileSync(trimmedBackup), trimmedSentinel);
  assert.ok(fs.existsSync(backup));
  const exactBackup = new Database(backup, { readonly: true, timeout: 0 });
  assert.equal(exactBackup.location(), backup);
  assert.equal(exactBackup.prepare('SELECT value FROM payload').get()!.value, 'committed public');
  exactBackup.close();
  reopened.close();
  const readonly = new Database(backup, { readonly: true, timeout: 0 });
  assert.equal(readonly.prepare('SELECT value FROM payload').get()!.value, 'committed public');
  assert.throws(() => readonly.prepare('INSERT INTO payload VALUES(2,\'readonly\')').run());
  readonly.close();
  const immutable = new Database(pathToFileURL(backup).href + '?immutable=1&mode=ro', { readonly: true, timeout: 0 });
  assert.equal(immutable.prepare('SELECT value FROM payload').get()!.value, 'committed public');
  immutable.close();
  // WAL destinations cannot change page size during an online backup. This
  // produces real SQLITE_READONLY errors in both step and backup_finish.
  const failingSource = new Database(':memory:', { timeout: 0 });
  failingSource.exec('PRAGMA page_size=4096; CREATE TABLE transfer_source(value TEXT); INSERT INTO transfer_source VALUES(\'source\')');
  const failingDestination = path.join(root, 'page-size-mismatch.sqlite');
  const destination = new Database(failingDestination, { timeout: 0 });
  destination.exec('PRAGMA page_size=1024; CREATE TABLE destination_canary(value TEXT); INSERT INTO destination_canary VALUES(\'untouched\')');
  assert.equal(destination.pragma('journal_mode=WAL', { simple: true }), 'wal');
  assert.notEqual(destination.pragma('page_size', { simple: true }), failingSource.pragma('page_size', { simple: true }));
  const nativeErrors: QualificationSqliteError[] = [];
  const captureStackTrace = Error.captureStackTrace;
  assert.equal(typeof captureStackTrace, 'function');
  // Observe the actual native-created exceptions without replacing transfer,
  // cleanup, the error constructor, or any engine result.
  Error.captureStackTrace = function (error: object, ...args: [constructorOpt?: Function]): void {
    if (error instanceof Database.SqliteError) nativeErrors.push(error);
    return captureStackTrace.call(Error, error, ...args);
  };
  let transferError: unknown;
  try {
    await assert.rejects(withinDeadline(failingSource.backup(failingDestination)), (error: unknown) => {
      transferError = error;
      return error instanceof Database.SqliteError && (error.errcode & 255) === 8;
    });
  } finally { Error.captureStackTrace = captureStackTrace; }
  assert.equal(nativeErrors.length, 2, 'Both transfer and cleanup must report their real engine errors');
  assert.equal(transferError, nativeErrors[0], 'Promise must reject with the original transfer error');
  assert.notEqual(nativeErrors[0], nativeErrors[1]);
  assert.equal(nativeErrors[1].errcode & 255, 8);
  assert.equal(destination.prepare('SELECT value FROM destination_canary').get()!.value, 'untouched');
  destination.close();
  failingSource.close();
  const partialSource = new Database(':memory:', { timeout: 0 });
  partialSource.exec('CREATE TABLE partial_payload(value BLOB); WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<512) INSERT INTO partial_payload SELECT zeroblob(8192) FROM n');
  const partialPath = path.join(root, 'closed-partial-backup.sqlite');
  let progressCalls = 0, copiedPages = 0;
  await assert.rejects(withinDeadline(partialSource.backup(partialPath, { progress(progress) {
    progressCalls++;
    assert.ok(progress.remainingPages > 0);
    const copied = progress.totalPages - progress.remainingPages;
    if (copied > 0) { copiedPages = copied; partialSource.close(); }
    return 1;
  } })), (error: unknown) => error instanceof TypeError && /not open/.test(error.message));
  assert.ok(progressCalls >= 2, 'Close must happen after a page transfer, not only backup initialization');
  assert.ok(copiedPages > 0);
  assert.equal(partialSource.open, false);
  assert.equal(fs.existsSync(partialPath), false, 'Closing must remove the newly created incomplete destination');
  const replacement = new Database(partialPath, { timeout: 0 });
  replacement.exec('CREATE TABLE replacement_canary(value TEXT); INSERT INTO replacement_canary VALUES(\'no delayed writes\')');
  replacement.close();
  const replacementBytes = fs.readFileSync(partialPath);
  await nextTurn();
  await nextTurn();
  assert.deepEqual(fs.readFileSync(partialPath), replacementBytes, 'Settled backup must not write later');
  const reopenedReplacement = new Database(partialPath, { readonly: true, timeout: 0 });
  assert.equal(reopenedReplacement.prepare('SELECT value FROM replacement_canary').get()!.value, 'no delayed writes');
  reopenedReplacement.close();
  console.log(JSON.stringify({ runtime: process.versions.bun, package: 'better-sqlite3@13.0.3', sqlite,
    selected: path.relative(repo, selected), retainedStatementClose: true, nativeWriterReacquired: true,
    unfinishedFtsRollback: true, authorizerDdlDenied: true, callbackErrorIdentity: true,
    asyncAuthorizerDenied: true, authorizerReentryDenied: true, authorizerIgnore: true,
    invalidAuthorizerRecovery: true, primitiveAuthorizerIdentity: true, authorizerReplacementReprepare: true,
    udf: true, exactIntegers: true, allIterateExactIntegers: true, unsafeUdfArgumentDenied: true, typedArrayBlobParity: true,
    literalFilename: true, literalBackupFilename: true, backupNulDenied: true,
    extensionDenied: true, doubleQuotedStringsDenied: true, onlineBackup: true,
    backupTransferCleanupErrorIdentity: true, partiallyRunningBackupClose: true, noDelayedBackupWrites: true,
    readonlyBackup: true, immutableUri: true, applicationAdmissionLifted: false }, null, 2));
}
