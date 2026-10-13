declare module 'better-sqlite3' {
  export type NativeSqliteValue = null | number | bigint | string | Uint8Array;
  export type NativeSqliteRow = Record<string, NativeSqliteValue>;
  export type NativeSqliteParameters = (NativeSqliteValue | Readonly<Record<string, NativeSqliteValue>>)[];
  export type NativeSqliteAuthorizer = (action: number, first: string | null, second: string | null, database: string | null, trigger: string | null) => number;
  export type NativeSqliteFunction = (...values: NativeSqliteValue[]) => NativeSqliteValue;
  export interface NativeSqliteStatement {
    get(...parameters: NativeSqliteParameters): NativeSqliteRow | undefined;
    all(...parameters: NativeSqliteParameters): NativeSqliteRow[];
    run(...parameters: NativeSqliteParameters): { changes: number; lastInsertRowid: number | bigint };
    iterate(...parameters: NativeSqliteParameters): IterableIterator<NativeSqliteRow>;
    safeIntegers(enabled: boolean): NativeSqliteStatement;
  }
  export default class NativeSqliteDatabase {
    constructor(filename: string, options: { readonly: boolean; timeout: number; nativeBinding: object; allowExtension: boolean });
    readonly open: boolean;
    readonly inTransaction: boolean;
    prepare(sql: string): NativeSqliteStatement;
    exec(sql: string): NativeSqliteDatabase;
    function(name: string, options: { deterministic?: boolean; directOnly?: boolean; safeIntegers?: boolean; varargs?: boolean }, callback: NativeSqliteFunction): NativeSqliteDatabase;
    setAuthorizer(callback: NativeSqliteAuthorizer | null): NativeSqliteDatabase;
    setConnectionControls(allowExtension: boolean, defensive: boolean, doubleQuotedStringLiterals: boolean): NativeSqliteDatabase;
    location(databaseName?: string): string | null;
    loadExtension(filename: string): NativeSqliteDatabase;
    backup(filename: string, options: { attached: string; progress: (state: { totalPages: number; remainingPages: number }) => number }): Promise<{ totalPages: number; remainingPages: number }>;
    close(): NativeSqliteDatabase;
  }
}

