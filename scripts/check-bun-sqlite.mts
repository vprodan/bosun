// Native API diagnostics only, inside the same Bun OS/JS barriers. No app imports.
import type * as TestEnvironment from './test-env.cjs';
import type * as TestRuntime from './test-runtime.cjs';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { assertRuntime, createRun, launch } = require('./test-runtime.cjs') as typeof TestRuntime;
const { environment, cleanupRun } = require('./test-env.cjs') as typeof TestEnvironment;
type SqlRow = Record<string, unknown>;
interface DiagnosticStatement { all(): SqlRow[]; get(): SqlRow | null | undefined; finalize?: unknown }
interface DiagnosticDatabase {
  exec(sql: string): void;
  prepare(sql: string): DiagnosticStatement;
  close(force?: boolean): void;
  [Symbol.dispose](): void;
  isOpen: boolean;
}
interface NativeDatabase extends Pick<DiagnosticDatabase, 'exec' | 'prepare' | 'close'> {
  function?: unknown;
  setAuthorizer?: unknown;
  backup?: unknown;
}
type Failure = { code: unknown; errcode: unknown; message: string };
type Artifacts = Record<string, number | null>;
interface BackupReport {
  journal: string; readOnly: boolean; memoryTemp: boolean; immutable: boolean;
  readback: boolean; stage: string; pages?: number; header?: number[];
  beforeReadback?: Artifacts; afterReadback?: Artifacts;
  directoryAccess?: Record<string, boolean | Failure>; rows?: number;
  nativeReadback?: { readback: boolean } & Partial<Failure>;
}
interface NativeReport {
  sqlite: unknown; function: string; authorizer: string; backup: string; finalize: string;
  lockReleased?: boolean; lockError?: unknown; retainedStatementRejected?: boolean;
}
interface SqliteReport {
  runtime: string | undefined; sqlite: unknown; close: string; statementKeys: string[];
  statementPrototype: string[]; databaseKeys: string[]; finalize: string;
  lockReleased?: boolean; lockError?: unknown;
  closeVariants?: { mode: string; released: boolean; closeError: unknown; retained: string }[];
  bunNative?: NativeReport; backup?: BackupReport; backupControls?: BackupReport[];
}
const errorField = (error: unknown, key: string): unknown =>
  typeof error === 'object' && error !== null && key in error
    ? (error as Record<string, unknown>)[key] : undefined;
assertRuntime();
if (process.argv[2] !== '--worker') {
  const root = createRun('bosun-sqlite-probe-');
  try {
    const env = environment(path.join(root, 'fixture'), root);
    const result = launch(root, [import.meta.filename, '--worker'], { env });
    process.exitCode = result.status ?? 1;
  } finally { cleanupRun(root); }
} else {
  const guardedGlobal = globalThis as typeof globalThis & { [key: symbol]: { assertEnvironment(env: NodeJS.ProcessEnv): void } | undefined };
  const guard = guardedGlobal[Symbol.for('bosun.test.guard')];
  if (!guard) throw Error('SQLite probe requires the guarded Bun launcher');
  guard.assertEnvironment(process.env);
  const { DatabaseSync, backup } = require('node:sqlite') as {
    DatabaseSync: { new(file: string, options?: { readOnly?: boolean }): DiagnosticDatabase; prototype: DiagnosticDatabase };
    backup(database: DiagnosticDatabase, file: string, options: Record<string, never>): Promise<number>;
  };
  const homeValue = process.env.HOME;
  const runRootValue = process.env.BOSUN_TEST_RUN_ROOT;
  if (!homeValue || !runRootValue) throw new Error('SQLite probe requires contained HOME and run root');
  const home: string = homeValue;
  const runRoot: string = runRootValue;
  const file = path.join(home, 'probe.db');
  const db = new DatabaseSync(file);
  db.exec('pragma journal_mode=wal; create table notes(id integer); insert into notes values(1); begin immediate;');
  const statement = db.prepare('select * from notes');
  statement.all();
  const report: SqliteReport = { runtime: process.versions.bun, sqlite: db.prepare('select sqlite_version() version').get()!.version,
    close: DatabaseSync.prototype.close.toString(), statementKeys: Object.getOwnPropertyNames(statement),
    statementPrototype: Object.getOwnPropertyNames(Object.getPrototypeOf(statement)),
    databaseKeys: Object.getOwnPropertyNames(db), finalize: typeof statement.finalize };
  db.close();
  const other = new DatabaseSync(file);
  try { other.exec('begin immediate;rollback;'); report.lockReleased = true; }
  catch (e) { report.lockReleased = false; report.lockError = errorField(e, 'code'); }
  other.close();
  report.closeVariants = [];
  for (const mode of ['boolean-true', 'dispose']) {
    const file = path.join(home, mode + '.db'), db = new DatabaseSync(file);
    db.exec('pragma journal_mode=wal;create table notes(id integer);begin immediate;');
    const retained = db.prepare('select * from notes'); retained.all();
    let closeError: unknown;
    try { if(mode === 'boolean-true') db.close(true); else db[Symbol.dispose](); }
    catch(e) { closeError=errorField(e, 'code'); }
    const reopened = new DatabaseSync(file); let released=false;
    try { reopened.exec('begin immediate;rollback;'); released=true; } catch {}
    reopened.close();
    report.closeVariants.push({mode,released,closeError,retained:typeof retained.get});
  }
  // Probe the documented native API, without replacing libraries or opening
  // owner files. Its close contract is useful only if all writer guards survive.
  const { Database } = require('bun:sqlite') as {
    Database: new(file: string, options: { create?: boolean; strict?: boolean; readwrite?: boolean; readonly?: boolean }) => NativeDatabase;
  };
  const nativeFile = path.join(home, 'bun-native.db');
  const native = new Database(nativeFile, { create: true, strict: true });
  native.exec('pragma journal_mode=wal;create table notes(id integer);insert into notes values(1);begin immediate;');
  const retained = native.prepare('select * from notes'); retained.all();
  const nativeReport: NativeReport = { sqlite: native.prepare('select sqlite_version() version').get()!.version,
    function: typeof native.function, authorizer: typeof native.setAuthorizer, backup: typeof native.backup,
    finalize: typeof retained.finalize };
  native.close(true);
  const second = new Database(nativeFile, { readwrite: true });
  try { second.exec('begin immediate;rollback;'); nativeReport.lockReleased = true; }
  catch(e) { nativeReport.lockReleased = false; nativeReport.lockError=errorField(e, 'code'); }
  try { retained.get(); nativeReport.retainedStatementRejected = false; }
  catch { nativeReport.retainedStatementRejected = true; }
  second.close(true);
  report.bunNative = nativeReport;
  // Repeat the original backup/readback shape with the *current* containment
  // profile, so a tempfile/access denial cannot masquerade as a backup bug.
  const expectedRows=[{id:1,body:'public first'},{id:2,body:'public second'}];
  async function backupDiagnostic(name: string, journal: string, readOnly: boolean, memoryTemp=false, immutable=false): Promise<BackupReport> {
    const sourceFile=path.join(home,name+'-source.db'), target=path.join(home,name+'.db');
    const source=new DatabaseSync(sourceFile);
    source.exec(`pragma journal_mode=${journal};create table notes(id integer primary key,body text);insert into notes values(1,'public first'),(2,'public second');begin immediate;`);
    const copySource=new DatabaseSync(sourceFile,{readOnly:true});
    let copy: DiagnosticDatabase | undefined;
    const result: BackupReport={journal,readOnly,memoryTemp,immutable,readback:false,stage:'reserve'};
    const failure=(e: unknown): Failure=>({code:errorField(e,'code'),errcode:errorField(e,'errcode'),message:String(errorField(e,'message')).replaceAll(runRoot,'<fixture>')});
    const artifacts=(): Artifacts=>Object.fromEntries(['','-wal','-shm'].map(suffix=>{
      const file=target+suffix;
      return [suffix||'main',fs.existsSync(file)?fs.statSync(file).size:null];
    }));
    try {
      fs.closeSync(fs.openSync(target,'wx',0o600));
      result.stage='backup';
      result.pages=await backup(copySource,target,{}); copySource.close();
      result.header=[...fs.readFileSync(target).subarray(18,20)];
      result.beforeReadback=artifacts();
      result.directoryAccess={};
      for(const [name,mode] of [['read',fs.constants.R_OK],['write',fs.constants.W_OK],['search',fs.constants.X_OK]] as const) {
        try { fs.accessSync(path.dirname(target),mode); result.directoryAccess[name]=true; }
        catch(e) { result.directoryAccess[name]=failure(e); }
      }
      result.stage='readback-open';
      // Immutable is diagnostic-only and applies to this completed offline
      // artifact, never a live database or a replacement for lease assertions.
      const location=immutable?pathToFileURL(target).href+'?immutable=1&mode=ro':target;
      copy=new DatabaseSync(location,{readOnly});
      if(memoryTemp) {
        result.stage='temp-store';
        copy.exec('pragma temp_store=memory;');
      }
      result.stage='readback-query';
      const rows=copy.prepare('select * from notes order by 1').all();
      result.readback=JSON.stringify(rows)===JSON.stringify(expectedRows);
      result.rows=rows.length;
      result.stage='complete';
    } catch(e) { Object.assign(result,failure(e)); }
    finally {
      copy?.close();
      result.afterReadback=artifacts();
      // Same artifact and OS barrier, but the other native API: a comparison,
      // never a production fallback or a substitute for node:sqlite readback.
      let nativeCopy: NativeDatabase | undefined;
      result.nativeReadback={readback:false};
      try {
        nativeCopy=new Database(target,{readonly:true,strict:true});
        result.nativeReadback.readback=JSON.stringify(nativeCopy.prepare('select * from notes order by 1').all())===JSON.stringify(expectedRows);
      } catch(e) { Object.assign(result.nativeReadback,failure(e)); }
      finally { nativeCopy?.close(true); }
      if(copySource.isOpen)copySource.close();
      source.exec('rollback'); source.close();
    }
    return result;
  }
  report.backup=await backupDiagnostic('backup','wal',true);
  report.backupControls=[
    await backupDiagnostic('backup-wal-readwrite','wal',false),
    await backupDiagnostic('backup-delete-readonly','delete',true),
    await backupDiagnostic('backup-wal-readonly-memory','wal',true,true),
    await backupDiagnostic('backup-wal-readonly-immutable','wal',true,false,true),
  ];
  console.log(JSON.stringify(report, null, 2));
}
