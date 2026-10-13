// The final graph is stored under the same admitted writer as its source memories.
export const GRAPH_TABLES = ['graph_artifacts', 'graph_supports', 'graph_parents', 'graph_aliases', 'graph_edges', 'graph_events',
  'graph_consolidation_cursors', 'graph_consolidation_seen', 'graph_consolidation_proposals', 'memory_embeddings'] as const;
export const GRAPH_SCHEMA_SQL = `
CREATE TABLE memory_embeddings (
  id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, memory_version INTEGER NOT NULL, memory_hash TEXT NOT NULL,
  chunk INTEGER NOT NULL CHECK(chunk BETWEEN 0 AND 7), start INTEGER NOT NULL, end INTEGER NOT NULL,
  model TEXT NOT NULL, model_digest TEXT NOT NULL, dimensions INTEGER NOT NULL CHECK(dimensions BETWEEN 1 AND 4096),
  transform TEXT NOT NULL, input_hash TEXT NOT NULL, vector BLOB NOT NULL, recorded_at INTEGER NOT NULL,
  private INTEGER NOT NULL CHECK(private=0),
  UNIQUE(memory_id,chunk,model_digest,dimensions,transform),
  CHECK(start>=0 AND end>start AND length(vector)=dimensions*4)
);
CREATE INDEX memory_embeddings_space ON memory_embeddings(model_digest,dimensions,transform,memory_id);
CREATE TRIGGER embeddings_memory_change AFTER UPDATE OF version,hash,title,body,tags,private,shared,status,expires_at,project_id,session_id,source,source_ref ON memories BEGIN
 DELETE FROM memory_embeddings WHERE memory_id=old.id;
END;
CREATE TRIGGER embeddings_memory_delete BEFORE DELETE ON memories BEGIN
 DELETE FROM memory_embeddings WHERE memory_id=old.id;
END;
CREATE TABLE graph_artifacts (
  seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, level INTEGER NOT NULL CHECK(level BETWEEN 0 AND 4),
  kind TEXT NOT NULL CHECK(kind IN ('source','fact','entity','relation','summary','profile')),
  title TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('proposed','active','dirty','archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), project_id TEXT, session_id TEXT,
  private INTEGER NOT NULL CHECK(private=0), shared INTEGER NOT NULL CHECK(shared IN (0,1)),
  recorded_at INTEGER NOT NULL, invalidated_at INTEGER, valid_from INTEGER, valid_to INTEGER, expires_at INTEGER,
  hash TEXT NOT NULL, producer_kind TEXT NOT NULL CHECK(producer_kind IN ('owner','deterministic','model')),
  producer_model TEXT, producer_version TEXT NOT NULL, entity_type TEXT, entity_key TEXT
);
CREATE INDEX graph_artifacts_scope ON graph_artifacts(project_id,status,level);
CREATE INDEX graph_artifacts_entity ON graph_artifacts(project_id,entity_type,entity_key) WHERE kind='entity' AND status='active';
CREATE TABLE graph_supports (
  artifact_id TEXT NOT NULL, memory_id TEXT NOT NULL, memory_version INTEGER NOT NULL, memory_hash TEXT NOT NULL,
  start INTEGER, end INTEGER, PRIMARY KEY(artifact_id,memory_id)
);
CREATE INDEX graph_supports_memory ON graph_supports(memory_id,artifact_id);
CREATE TABLE graph_parents (artifact_id TEXT NOT NULL,parent_id TEXT NOT NULL,parent_version INTEGER NOT NULL,PRIMARY KEY(artifact_id,parent_id));
CREATE INDEX graph_parents_parent ON graph_parents(parent_id,artifact_id);
CREATE TABLE graph_aliases (artifact_id TEXT NOT NULL,alias TEXT NOT NULL,PRIMARY KEY(artifact_id,alias));
CREATE INDEX graph_aliases_name ON graph_aliases(alias,artifact_id);
CREATE TABLE graph_edges (artifact_id TEXT PRIMARY KEY,from_id TEXT NOT NULL,to_id TEXT NOT NULL,predicate TEXT NOT NULL,weight REAL NOT NULL CHECK(weight>=0 AND weight<=1));
CREATE INDEX graph_edges_from ON graph_edges(from_id);
CREATE INDEX graph_edges_to ON graph_edges(to_id);
CREATE TABLE graph_events (id INTEGER PRIMARY KEY,artifact_id TEXT NOT NULL,op TEXT NOT NULL,at INTEGER NOT NULL,version INTEGER NOT NULL);
CREATE INDEX graph_events_artifact ON graph_events(artifact_id,id);
CREATE TABLE graph_consolidation_cursors (
  scope_key TEXT PRIMARY KEY,cursor INTEGER NOT NULL CHECK(cursor>=0),version INTEGER NOT NULL CHECK(version>=1),
  claim_id TEXT,claim_payload TEXT,updated_at INTEGER NOT NULL,CHECK((claim_id IS NULL)=(claim_payload IS NULL))
);
CREATE TABLE graph_consolidation_seen (
  scope_key TEXT NOT NULL,memory_id TEXT NOT NULL,source_version INTEGER NOT NULL,source_hash TEXT NOT NULL,
  PRIMARY KEY(scope_key,memory_id)
);
CREATE TABLE graph_consolidation_proposals (
  artifact_id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('fact','duplicate','merge','contradiction','entity','relation','summary','profile')),
  request_id TEXT NOT NULL,source_cursor INTEGER NOT NULL,citations TEXT NOT NULL
);
CREATE VIRTUAL TABLE graph_fts USING fts5(title,text,content='graph_artifacts',content_rowid='seq',tokenize='porter unicode61');
CREATE TRIGGER graph_ai AFTER INSERT ON graph_artifacts BEGIN
 INSERT INTO graph_fts(rowid,title,text) SELECT new.seq,new.title,new.text WHERE new.status IN ('active','proposed');
END;
CREATE TRIGGER graph_ad AFTER DELETE ON graph_artifacts BEGIN
 INSERT INTO graph_fts(graph_fts,rowid,title,text) SELECT 'delete',old.seq,old.title,old.text WHERE old.status IN ('active','proposed');
END;
CREATE TRIGGER graph_au AFTER UPDATE OF title,text,status ON graph_artifacts BEGIN
 INSERT INTO graph_fts(graph_fts,rowid,title,text) SELECT 'delete',old.seq,old.title,old.text WHERE old.status IN ('active','proposed');
 INSERT INTO graph_fts(rowid,title,text) SELECT new.seq,new.title,new.text WHERE new.status IN ('active','proposed');
END;
CREATE TRIGGER graph_memory_change AFTER UPDATE OF version,hash,title,body,tags,private,shared,status,expires_at,project_id,session_id,source,source_ref ON memories BEGIN
 INSERT INTO graph_events(artifact_id,op,at,version)
 SELECT id,'source_changed',new.updated_at,version+1 FROM graph_artifacts WHERE status IN ('active','proposed') AND id IN (SELECT artifact_id FROM graph_supports WHERE memory_id=old.id);
 UPDATE graph_artifacts SET status='dirty',invalidated_at=new.updated_at,version=version+1 WHERE status IN ('active','proposed') AND id IN (SELECT artifact_id FROM graph_supports WHERE memory_id=old.id);
END;
CREATE TRIGGER graph_memory_delete BEFORE DELETE ON memories BEGIN
 INSERT INTO graph_events(artifact_id,op,at,version)
 SELECT id,'source_purged',old.updated_at,version+1 FROM graph_artifacts WHERE status IN ('active','proposed') AND id IN (SELECT artifact_id FROM graph_supports WHERE memory_id=old.id);
 UPDATE graph_artifacts SET status='dirty',invalidated_at=old.updated_at,version=version+1 WHERE status IN ('active','proposed') AND id IN (SELECT artifact_id FROM graph_supports WHERE memory_id=old.id);
END;
`;
