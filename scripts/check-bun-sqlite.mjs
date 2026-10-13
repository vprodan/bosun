// Native API diagnostics only, inside the same Bun OS/JS barriers. No app imports.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { assertRuntime, createRun, launch } = require('./test-runtime.cjs');
const { environment, cleanupRun } = require('./test-env.cjs');
assertRuntime();
if (process.argv[2] !== '--worker') {
  const root = createRun('bosun-sqlite-probe-');
  try {
    const env = environment(path.join(root, 'fixture'), root);
    const result = launch(root, [import.meta.filename, '--worker'], { env });
    process.exitCode = result.status ?? 1;
  } finally { cleanupRun(root); }
} else {
  const guard = globalThis[Symbol.for('bosun.test.guard')];
  if (!guard) throw Error('SQLite probe requires the guarded Bun launcher');
  guard.assertEnvironment(process.env);
  const { DatabaseSync, backup } = require('node:sqlite');
  const file = path.join(process.env.HOME, 'probe.db');
  const db = new DatabaseSync(file);
  db.exec('pragma journal_mode=wal; create table notes(id integer); insert into notes values(1); begin immediate;');
  const statement = db.prepare('select * from notes');
  statement.all();
  const report = { runtime: process.versions.bun, sqlite: db.prepare('select sqlite_version() version').get().version,
    close: DatabaseSync.prototype.close.toString(), statementKeys: Object.getOwnPropertyNames(statement),
    statementPrototype: Object.getOwnPropertyNames(Object.getPrototypeOf(statement)),
    databaseKeys: Object.getOwnPropertyNames(db), finalize: typeof statement.finalize };
  db.close();
  const other = new DatabaseSync(file);
  try { other.exec('begin immediate;rollback;'); report.lockReleased = true; }
  catch (e) { report.lockReleased = false; report.lockError = e.code; }
  other.close();
  report.closeVariants = [];
  for (const mode of ['boolean-true', 'dispose']) {
    const file = path.join(process.env.HOME, mode + '.db'), db = new DatabaseSync(file);
    db.exec('pragma journal_mode=wal;create table notes(id integer);begin immediate;');
    const retained = db.prepare('select * from notes'); retained.all();
    let closeError;
    try { if(mode === 'boolean-true') db.close(true); else db[Symbol.dispose](); }
    catch(e) { closeError=e.code; }
    const reopened = new DatabaseSync(file); let released=false;
    try { reopened.exec('begin immediate;rollback;'); released=true; } catch {}
    reopened.close();
    report.closeVariants.push({mode,released,closeError,retained:typeof retained.get});
  }
  // Probe the documented native API, without replacing libraries or opening
  // owner files. Its close contract is useful only if all writer guards survive.
  const { Database } = require('bun:sqlite');
  const nativeFile = path.join(process.env.HOME, 'bun-native.db');
  const native = new Database(nativeFile, { create: true, strict: true });
  native.exec('pragma journal_mode=wal;create table notes(id integer);insert into notes values(1);begin immediate;');
  const retained = native.prepare('select * from notes'); retained.all();
  const nativeReport = { sqlite: native.prepare('select sqlite_version() version').get().version,
    function: typeof native.function, authorizer: typeof native.setAuthorizer, backup: typeof native.backup,
    finalize: typeof retained.finalize };
  native.close(true);
  const second = new Database(nativeFile, { readwrite: true });
  try { second.exec('begin immediate;rollback;'); nativeReport.lockReleased = true; }
  catch(e) { nativeReport.lockReleased = false; nativeReport.lockError=e.code; }
  try { retained.get(); nativeReport.retainedStatementRejected = false; }
  catch { nativeReport.retainedStatementRejected = true; }
  second.close(true);
  report.bunNative = nativeReport;
  // Repeat the original backup/readback shape with the *current* containment
  // profile, so a tempfile/access denial cannot masquerade as a backup bug.
  const expectedRows=[{id:1,body:'public first'},{id:2,body:'public second'}];
  async function backupDiagnostic(name, journal, readOnly, memoryTemp=false, immutable=false) {
    const sourceFile=path.join(process.env.HOME,name+'-source.db'), target=path.join(process.env.HOME,name+'.db');
    const source=new DatabaseSync(sourceFile);
    source.exec(`pragma journal_mode=${journal};create table notes(id integer primary key,body text);insert into notes values(1,'public first'),(2,'public second');begin immediate;`);
    const copySource=new DatabaseSync(sourceFile,{readOnly:true});
    let copy;
    const result={journal,readOnly,memoryTemp,immutable,readback:false,stage:'reserve'};
    const failure=e=>({code:e.code,errcode:e.errcode,message:String(e.message).replaceAll(process.env.BOSUN_TEST_RUN_ROOT,'<fixture>')});
    const artifacts=()=>Object.fromEntries(['','-wal','-shm'].map(suffix=>{
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
      for(const [name,mode] of [['read',fs.constants.R_OK],['write',fs.constants.W_OK],['search',fs.constants.X_OK]]) {
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
      let nativeCopy;
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
