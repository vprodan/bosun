// Exact public-view format literals shared by explicit publisher and zero-write reader. No IO.
export const GATE_SQL = `CREATE TABLE bosun_cutover_gate (
  id INTEGER PRIMARY KEY CHECK(id=1), protocol INTEGER NOT NULL CHECK(protocol=1),
  state TEXT NOT NULL CHECK(state='HOLD'), phase TEXT NOT NULL CHECK(phase IN ('copying','backed','applied')),
  source_id TEXT NOT NULL, attempt_id TEXT NOT NULL, source_dev TEXT NOT NULL, source_ino TEXT NOT NULL,
  view_dev TEXT NOT NULL, view_ino TEXT NOT NULL, backup_name TEXT NOT NULL, backup_dev TEXT NOT NULL,
  backup_ino TEXT NOT NULL, backup_hash TEXT, started_at INTEGER NOT NULL
)`;
export const PUBLIC_STATE_SQL = `CREATE TABLE bosun_public_state (id INTEGER PRIMARY KEY CHECK(id=1),format INTEGER NOT NULL CHECK(format=2),
  state TEXT NOT NULL CHECK(state IN ('HOLD','READY')),source_id TEXT NOT NULL,generation INTEGER,
  publication_id TEXT,published_at INTEGER,valid_until INTEGER)`;
export const PUBLIC_MEMORY_SQL = `CREATE TABLE public_memories (seq INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,category TEXT NOT NULL,
  project_id TEXT,session_id TEXT,title TEXT NOT NULL,body TEXT NOT NULL,tags TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status='active'),shared INTEGER NOT NULL,private INTEGER NOT NULL CHECK(private=0),source TEXT NOT NULL,source_ref TEXT,hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,expires_at INTEGER,accessed_at INTEGER,access_count INTEGER NOT NULL,version INTEGER NOT NULL)`;
export const PUBLIC_FTS_SQL = `CREATE VIRTUAL TABLE public_memories_fts USING fts5(title,body,tags,content='public_memories',content_rowid='seq',tokenize='porter unicode61')`;
export const PUBLIC_FTS_TRIGGERS = {
  public_memories_ai: `CREATE TRIGGER public_memories_ai AFTER INSERT ON public_memories BEGIN
    INSERT INTO public_memories_fts(rowid,title,body,tags) VALUES(new.seq,new.title,new.body,new.tags); END`,
  public_memories_ad: `CREATE TRIGGER public_memories_ad AFTER DELETE ON public_memories BEGIN
    INSERT INTO public_memories_fts(public_memories_fts,rowid,title,body,tags) VALUES('delete',old.seq,old.title,old.body,old.tags); END`,
};
// Exact SQLite-created external-content shadow schema on the qualified runtime.
export const PUBLIC_SQL = new Map(Object.entries({
  bosun_cutover_gate: GATE_SQL, bosun_public_state: PUBLIC_STATE_SQL, public_memories: PUBLIC_MEMORY_SQL,
  public_memories_fts: PUBLIC_FTS_SQL, ...PUBLIC_FTS_TRIGGERS,
  public_memories_fts_data: "CREATE TABLE 'public_memories_fts_data'(id INTEGER PRIMARY KEY, block BLOB)",
  public_memories_fts_idx: "CREATE TABLE 'public_memories_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID",
  public_memories_fts_docsize: "CREATE TABLE 'public_memories_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB)",
  public_memories_fts_config: "CREATE TABLE 'public_memories_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID",
}));
export const PUBLIC_COLUMNS = 'seq id category project_id session_id title body tags status shared private source source_ref hash created_at updated_at expires_at accessed_at access_count version'.split(' ');
export const PUBLIC_MAX_ROWS = 10000;
// Measured scoped medium-body 10k corpus: ~9.3 MB encoded / ~7.9 MB view. Still finite, independent limits.
export const PUBLIC_MAX_BYTES = 16 * 1024 * 1024;
export const VIEW_MAX_BYTES = 64 * 1024 * 1024;
// Presence alone revokes audience delivery. Readers never read owner restore metadata.
export const RESTORE_PENDING_SUFFIX = '.restore';
export const RESTORE_RECEIPT_SUFFIX = '.restore-receipt';
export const normalize = (sql: unknown) => typeof sql === 'string' ? sql.replace(/\s+/g, ' ').trim() : '';
