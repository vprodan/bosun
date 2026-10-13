import NativeSqliteDatabase from 'better-sqlite3';
import type { NativeSqliteParameters, NativeSqliteStatement, NativeSqliteValue } from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { BosunError } from '../core/errors.ts';
import { memorySqliteRuntime } from './sqlite-runtime.ts';

// Node-API loading is a native runtime boundary: Bun rejects ESM addon imports.
// A literal require also lets the compiler embed this exact owned artifact.
const nativeAddon: object = require('../../node_modules/better-sqlite3/build/Release/bosun_sqlite.node');

type NativeSqliteAddon = Readonly<{ Database?: { prototype?: Readonly<{ setAuthorizer?: unknown; setConnectionControls?: unknown; location?: unknown }> } }>;
const nativePrototype = (nativeAddon as NativeSqliteAddon).Database?.prototype;
if (typeof nativePrototype?.setAuthorizer !== 'function' || typeof nativePrototype.setConnectionControls !== 'function'
  || typeof nativePrototype.location !== 'function' || typeof NativeSqliteDatabase.prototype.setAuthorizer !== 'function'
  || typeof NativeSqliteDatabase.prototype.setConnectionControls !== 'function' || typeof NativeSqliteDatabase.prototype.location !== 'function')
  throw new BosunError('unsupported', 'Unqualified native SQLite binding');

export type SqliteValue = NativeSqliteValue;
export type SqliteRow = Record<string, SqliteValue>;
export type SqliteParameters = NativeSqliteParameters;
export type SqliteAuthorizer = (action: number, first: string | null, second: string | null, database: string | null, trigger: string | null) => number;
export type SqliteScalarFunction = (...values: SqliteValue[]) => SqliteValue;
export type SqliteOpenOptions = Readonly<{
  readOnly?: boolean;
  allowExtension?: boolean;
  defensive?: boolean;
  enableDoubleQuotedStringLiterals?: boolean;
}>;
export type SqliteFunctionOptions = Readonly<{
  deterministic?: boolean;
  directOnly?: boolean;
  useBigIntArguments?: boolean;
  varargs?: boolean;
}>;
export type SqliteBackupOptions = Readonly<{ source?: 'main'; target?: 'main'; rate?: number }>;
export type SqliteChanges = Readonly<{ changes: number; lastInsertRowid: number | bigint }>;

// SQLite's public authorizer action/result codes are stable C API constants.
const nativeCodes = {
  SQLITE_OK: 0, SQLITE_DENY: 1, SQLITE_IGNORE: 2,
  SQLITE_CREATE_INDEX: 1, SQLITE_CREATE_TABLE: 2,
  SQLITE_CREATE_TEMP_INDEX: 3, SQLITE_CREATE_TEMP_TABLE: 4,
  SQLITE_CREATE_TEMP_TRIGGER: 5, SQLITE_CREATE_TEMP_VIEW: 6,
  SQLITE_CREATE_TRIGGER: 7, SQLITE_CREATE_VIEW: 8, SQLITE_DELETE: 9,
  SQLITE_DROP_INDEX: 10, SQLITE_DROP_TABLE: 11, SQLITE_DROP_TEMP_INDEX: 12,
  SQLITE_DROP_TEMP_TABLE: 13, SQLITE_DROP_TEMP_TRIGGER: 14, SQLITE_DROP_TEMP_VIEW: 15,
  SQLITE_DROP_TRIGGER: 16, SQLITE_DROP_VIEW: 17, SQLITE_INSERT: 18, SQLITE_PRAGMA: 19,
  SQLITE_READ: 20, SQLITE_SELECT: 21, SQLITE_TRANSACTION: 22, SQLITE_UPDATE: 23,
  SQLITE_ATTACH: 24, SQLITE_DETACH: 25, SQLITE_ALTER_TABLE: 26,
  SQLITE_REINDEX: 27, SQLITE_ANALYZE: 28, SQLITE_CREATE_VTABLE: 29,
  SQLITE_DROP_VTABLE: 30, SQLITE_FUNCTION: 31, SQLITE_SAVEPOINT: 32, SQLITE_RECURSIVE: 33,
};
export const sqliteConstants = Object.freeze(nativeCodes);

export class SqliteStatement {
  readonly #native: NativeSqliteStatement;
  constructor(statement: NativeSqliteStatement) { this.#native = statement; }
  get(...parameters: SqliteParameters): SqliteRow | undefined { return this.#native.get(...parameters); }
  all(...parameters: SqliteParameters): SqliteRow[] { return this.#native.all(...parameters); }
  run(...parameters: SqliteParameters): SqliteChanges { return this.#native.run(...parameters); }
  iterate(...parameters: SqliteParameters): IterableIterator<SqliteRow> { return this.#native.iterate(...parameters); }
  setReadBigInts(enabled: boolean): void { this.#native.safeIntegers(enabled); }
}

export class SqliteDatabase {
  readonly #native: NativeSqliteDatabase;
  #defensive: boolean;
  readonly #doubleQuotedStrings: boolean;
  #extensions: boolean;
  constructor(file: string | Buffer | URL, options: SqliteOpenOptions = {}) {
    if (!memorySqliteRuntime())
      throw new BosunError('unsupported', 'Native SQLite requires qualified Bun on darwin/arm64; no Node fallback');
    const filename = file instanceof URL ? fileURLToPath(file) : Buffer.isBuffer(file) ? file.toString('utf8') : file;
    this.#extensions = options.allowExtension ?? false;
    this.#defensive = options.defensive ?? false;
    this.#doubleQuotedStrings = options.enableDoubleQuotedStringLiterals ?? false;
    const db = new NativeSqliteDatabase(filename, {
      readonly: options.readOnly ?? false, timeout: 0, nativeBinding: nativeAddon,
      // Forward original privilege to the pre-native containment boundary too.
      allowExtension: this.#extensions,
    });
    try {
      // Connection controls are installed before any caller SQL executes.
      db.setConnectionControls(this.#extensions, this.#defensive, this.#doubleQuotedStrings);
      this.#native = db;
    } catch (error) { db.close(); throw error; }
  }
  get isOpen(): boolean { return this.#native.open; }
  get isTransaction(): boolean { return this.#native.inTransaction; }
  location(databaseName = 'main'): string | null { return this.#native.location(databaseName); }
  prepare(sql: string): SqliteStatement { return new SqliteStatement(this.#native.prepare(sql)); }
  exec(sql: string): void { this.#native.exec(sql); }
  function(name: string, callback: SqliteScalarFunction): void;
  function(name: string, options: SqliteFunctionOptions, callback: SqliteScalarFunction): void;
  function(name: string, options: SqliteFunctionOptions | SqliteScalarFunction, callback?: SqliteScalarFunction): void {
    const settings = typeof options === 'function' ? {} : options;
    const selected = typeof options === 'function' ? options : callback;
    if (!selected) throw new TypeError('SQLite function callback required');
    this.#native.function(name, {
      deterministic: settings.deterministic ?? false, directOnly: settings.directOnly ?? false,
      safeIntegers: settings.useBigIntArguments ?? false, varargs: settings.varargs ?? false,
    }, selected);
  }
  setAuthorizer(callback: SqliteAuthorizer | null): void { this.#native.setAuthorizer(callback); }
  loadExtension(file: string): void { this.#native.loadExtension(file); }
  enableLoadExtension(enabled: boolean): void {
    this.#native.setConnectionControls(enabled, this.#defensive, this.#doubleQuotedStrings);
    this.#extensions = enabled;
  }
  enableDefensive(enabled: boolean): void {
    this.#native.setConnectionControls(this.#extensions, enabled, this.#doubleQuotedStrings);
    this.#defensive = enabled;
  }
  close(): void { this.#native.close(); }
  [Symbol.dispose](): void { this.close(); }
  async backup(file: string, options: SqliteBackupOptions = {}): Promise<number> {
    if (options.source !== undefined && options.source !== 'main' || options.target !== undefined && options.target !== 'main')
      throw new BosunError('unsupported', 'Only the admitted main SQLite database can be backed up');
    const rate = options.rate ?? 100;
    if (!Number.isSafeInteger(rate) || rate < 1) throw new TypeError('SQLite backup rate must be a positive integer');
    const result = await this.#native.backup(file, { attached: 'main', progress: () => rate });
    return result.totalPages;
  }
}

export function sqliteBackup(database: SqliteDatabase, file: string, options: SqliteBackupOptions = {}): Promise<number> {
  return database.backup(file, options);
}
