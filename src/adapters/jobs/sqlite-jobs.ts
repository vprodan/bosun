import type { SqliteDatabase } from '../../platform/sqlite.ts'
import { BosunError } from '../../core/errors.ts';
import { requirePublicInput } from '../../core/policy.ts';
import { screenPublicText } from '../../core/secret-screen.ts';
import { acceptedJob, admissionMetadata, changedJob, jobId, jobScope, jobTime, utf8Bytes, JOB_LIMITS, JOB_RETENTION,
  type JobChange, type JobEvent, type JobInput, type JobScope, type JobSnapshot } from '../../core/domain/job.ts';
import type { JobStorage } from '../../core/use-cases/jobs.ts';
import { mergeQuota, storedQuotaState, QUOTA_LIMITS, type QuotaIdentity, type QuotaObservation, type QuotaState } from '../../core/domain/quota.ts';
import type { QuotaSelection, QuotaStorage } from '../../core/use-cases/quota.ts';
import { managedOwnership, type HandoffStorage, type ManagedOwnership } from '../../core/use-cases/handoff.ts';
import type { ManagedSession, HandoffPointer } from '../../core/domain/session.ts';
import { billingQualification, nativeUsage, type BillingQualification, type JobUsage, type UsageSelection, type DailyUsage } from '../../core/domain/usage.ts';
import { openOwnedSqlite } from '../../platform/sqlite-owned.ts';
import { NOTIFICATION_LIMITS, notificationJob, notificationState, notificationPayload, notificationDelivery, type NotificationEvent, type NotificationReceipt, type NotificationDelivery } from '../../core/domain/notifications.ts';
import { WORKSPACE_LIMITS, workspaceRecord, workspaceText, type WorkspaceRecord, type WorkspaceStorage } from '../../core/domain/workspace.ts';
import { REVIEW_LIMITS,reviewRecord,type ReviewRecord,type ReviewStorage } from '../../core/domain/review.ts';
import { CHECK_RUNNER,CHECK_LIMITS,checkRecord,checkOutcome,type CheckRecord,type CheckStorage,type CheckReceipt } from '../../core/domain/check.ts';
import { assertCheckHash } from '../../platform/check-command.ts';
import { CARD_LIMITS,cardOwner,cardRecord,type CardRecord,type CardStorage } from '../../core/domain/card.ts';
import { assertCardHash } from '../../platform/card-hash.ts';
import { MANAGED_START_RUNNER, MANAGED_HANDOFF_RUNNER } from '../../core/domain/managed.ts';
import { observationId, routeObservation, ROUTE_OBSERVATION_LIMITS, type RouteObservation, type RouteLabel } from '../../core/domain/route-observation.ts';
import { isLane, type Lane } from '../../core/domain/route.ts';
import { WATCH_LIMITS, watchRecord, type WatchRecord, type WatchStorage } from '../../core/domain/watch.ts';

const SCHEMA = [
  `CREATE TABLE jobs (id TEXT PRIMARY KEY, project_key TEXT NOT NULL, request_id TEXT NOT NULL, task_id TEXT NOT NULL, runner_id TEXT NOT NULL,
    privacy TEXT NOT NULL CHECK(privacy='public'), payload TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','held','running','succeeded','failed','cancelled','unknown')),
    version INTEGER NOT NULL CHECK(version>=1), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, cancel_requested INTEGER NOT NULL CHECK(cancel_requested IN (0,1)),
    reason TEXT, owner_only INTEGER NOT NULL DEFAULT 0 CHECK(owner_only IN (0,1)), allow_unknown_quota INTEGER NOT NULL DEFAULT 0 CHECK(allow_unknown_quota IN (0,1)), UNIQUE(project_key,request_id))`,
  `CREATE TABLE job_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id), state TEXT NOT NULL, version INTEGER NOT NULL,
    at INTEGER NOT NULL, kind TEXT NOT NULL, reason TEXT)`,
  `CREATE INDEX job_events_job ON job_events(job_id,seq)`,
  `CREATE TABLE job_results (job_id TEXT PRIMARY KEY REFERENCES jobs(id), result TEXT NOT NULL)`,
  `CREATE TABLE quota_state (key TEXT PRIMARY KEY, pool_key TEXT NOT NULL, model TEXT, version INTEGER NOT NULL CHECK(version>=1), payload TEXT NOT NULL)`,
  `CREATE INDEX quota_state_pool ON quota_state(pool_key,model)`,
  `CREATE TABLE quota_bindings (runner_id TEXT PRIMARY KEY, pool_key TEXT NOT NULL)`,
  `CREATE TABLE managed_ownership (id TEXT PRIMARY KEY, project_key TEXT NOT NULL, owner_id TEXT NOT NULL UNIQUE, version INTEGER NOT NULL CHECK(version>=1), payload TEXT NOT NULL)`,
  `CREATE TABLE managed_retirements (owner_id TEXT NOT NULL, generation INTEGER NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(owner_id,generation))`,
  `CREATE TABLE managed_jobs (job_id TEXT PRIMARY KEY, managed_id TEXT NOT NULL, project_key TEXT NOT NULL, cwd TEXT NOT NULL)`,
  `CREATE TABLE handoff_artifacts (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, project_key TEXT NOT NULL, created_at INTEGER NOT NULL, manifest_hash TEXT NOT NULL, markdown_hash TEXT NOT NULL, UNIQUE(project_key,request_id))`,
  `CREATE TABLE job_usage (job_id TEXT NOT NULL REFERENCES jobs(id), generation INTEGER NOT NULL CHECK(generation>=1), runner_id TEXT NOT NULL,
    model TEXT NOT NULL, effort TEXT, billing_kind TEXT NOT NULL CHECK(billing_kind IN ('subscription','api','local','unknown')), vendor TEXT, billing_pool TEXT,
    billing_qualification TEXT NOT NULL CHECK(billing_qualification IN ('verified','unverified')), started_at INTEGER NOT NULL, finished_at INTEGER,
    state TEXT NOT NULL, tokens_in INTEGER, tokens_out INTEGER, cached_tokens INTEGER, reasoning_tokens INTEGER,
    usage_events INTEGER NOT NULL DEFAULT 0, usage_qualification TEXT NOT NULL DEFAULT 'unavailable', PRIMARY KEY(job_id,generation))`,
  `CREATE TABLE job_receipts (id TEXT PRIMARY KEY, project_key TEXT NOT NULL, request_id TEXT NOT NULL, task_id TEXT NOT NULL, runner_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('succeeded','failed','cancelled')), version INTEGER NOT NULL CHECK(version>=1), created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, cancel_requested INTEGER NOT NULL CHECK(cancel_requested IN (0,1)), reason TEXT,
    owner_only INTEGER NOT NULL CHECK(owner_only IN (0,1)), allow_unknown_quota INTEGER NOT NULL CHECK(allow_unknown_quota IN (0,1)),
    retained_at INTEGER NOT NULL, UNIQUE(project_key,request_id))`,
  `CREATE TABLE usage_daily (key TEXT PRIMARY KEY, project_key TEXT NOT NULL, day INTEGER NOT NULL, runner_id TEXT NOT NULL, model TEXT NOT NULL, effort TEXT,
    billing_kind TEXT NOT NULL, vendor TEXT, billing_qualification TEXT NOT NULL, pool TEXT NOT NULL, attempts INTEGER NOT NULL,
    reported INTEGER NOT NULL, partial INTEGER NOT NULL, ambiguous INTEGER NOT NULL, unavailable INTEGER NOT NULL,
    known_input INTEGER NOT NULL, known_output INTEGER NOT NULL, missing_input INTEGER NOT NULL, missing_output INTEGER NOT NULL)`,
  `CREATE TABLE notification_events (id TEXT PRIMARY KEY, project_key TEXT NOT NULL, job_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1),
    job_ref TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('held','failed','ready','done')), phase TEXT NOT NULL CHECK(phase IN ('pending','submitting','submitted','held','unknown')),
    reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(job_id,version))`,
  `CREATE TABLE workspaces (id TEXT PRIMARY KEY, project_key TEXT NOT NULL, request_id TEXT NOT NULL, repository TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE, version INTEGER NOT NULL CHECK(version>=1), payload TEXT NOT NULL, UNIQUE(project_key,request_id))`,
  `CREATE TABLE workspace_jobs (job_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), project_key TEXT NOT NULL)`,
  `CREATE TABLE review_artifacts (id TEXT PRIMARY KEY, project_key TEXT NOT NULL, request_id TEXT NOT NULL, job_id TEXT UNIQUE,
    version INTEGER NOT NULL CHECK(version>=1), payload TEXT NOT NULL, UNIQUE(project_key,request_id))`,
  `CREATE TABLE check_artifacts (id TEXT PRIMARY KEY, project_key TEXT NOT NULL, request_id TEXT NOT NULL, review_id TEXT NOT NULL REFERENCES review_artifacts(id),
    job_id TEXT UNIQUE, version INTEGER NOT NULL CHECK(version>=1), payload TEXT NOT NULL, UNIQUE(project_key,request_id))`,
  `CREATE TABLE card_receipts (id TEXT PRIMARY KEY, project_key TEXT NOT NULL, request_id TEXT NOT NULL, target TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version>=1), payload TEXT NOT NULL, UNIQUE(project_key,request_id))`,
  `CREATE TABLE route_observations (id TEXT PRIMARY KEY, project_key TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL)`,
  `CREATE TABLE route_labels (source TEXT NOT NULL CHECK(source IN ('recorded','legacy')), project_key TEXT NOT NULL, id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version>=1), label TEXT NOT NULL CHECK(label IN ('scout','local','worker','main')), at INTEGER NOT NULL, PRIMARY KEY(source,project_key,id))`,
  `CREATE TABLE route_label_events (source TEXT NOT NULL, project_key TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL,
    label TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(source,project_key,id,version))`,
  `CREATE TABLE watch_receipts (job_id TEXT PRIMARY KEY, project_key TEXT NOT NULL, request_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1), payload TEXT NOT NULL, UNIQUE(project_key,request_id))`,
];
const normalize = (sql: unknown) => typeof sql === 'string' ? sql.replace(/\s+/g, ' ').trim() : '';
const COLUMNS = 'id,project_key,request_id,task_id,runner_id,state,version,created_at,updated_at,cancel_requested,reason,owner_only,allow_unknown_quota';
type Row = Record<string, any>;
const snapshot = (r: Row): JobSnapshot => ({ id: r.id, projectId: r.project_key || null, requestId: r.request_id, taskId: r.task_id, runnerId: r.runner_id,
  state: r.state, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at, cancelRequested: r.cancel_requested === 1, reason: r.reason, ownerOnly: r.owner_only === 1,
  allowUnknownQuota: r.allow_unknown_quota === 1 });
const unavailable = (unknown = false) => new BosunError('unavailable', 'Job storage unavailable', unknown ? { details: { outcome: 'unknown' } } : undefined);

export class SqliteJobStore implements JobStorage, QuotaStorage, HandoffStorage {
  recordRoute(scope: JobScope, input: unknown): RouteObservation {
    this.#workspaceOwner(scope);
    const record = routeObservation(input);
    if (record.projectId !== this.#scope(scope)) throw new BosunError('invalid', 'Route scope mismatch');
    return this.#transaction((db) => {
      if (db.prepare('SELECT 1 FROM route_observations WHERE id=?').get(record.id)) throw new BosunError('conflict', 'Observation exists');
      if (Number(db.prepare('SELECT count(*) AS n FROM route_observations').get()!.n) >= ROUTE_OBSERVATION_LIMITS.records) throw unavailable();
      db.prepare('INSERT INTO route_observations(id,project_key,created_at,payload) VALUES(?,?,?,?)').run(record.id, record.projectId, record.at, JSON.stringify(record));
      return record;
    });
  }
  listRoutes(scope: JobScope, limit = 50): RouteObservation[] {
    this.#workspaceOwner(scope);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > ROUTE_OBSERVATION_LIMITS.records) throw new BosunError('invalid', 'Invalid observation limit');
    return this.#read((db) => db.prepare('SELECT * FROM route_observations WHERE project_key=? ORDER BY created_at DESC,rowid DESC LIMIT ?')
      .all(this.#scope(scope), limit).map((row) => {
        if (typeof row.payload !== 'string' || utf8Bytes(row.payload) > ROUTE_OBSERVATION_LIMITS.recordBytes) throw unavailable();
        const record = routeObservation(JSON.parse(row.payload));
        if (record.id !== row.id || record.projectId !== row.project_key || record.at !== row.created_at) throw unavailable();
        return record;
      }));
  }
  routeLabels(scope: JobScope, source: 'recorded' | 'legacy'): RouteLabel[] {
    this.#workspaceOwner(scope);
    if (!['recorded', 'legacy'].includes(source)) throw new BosunError('invalid', 'Invalid observation source');
    return this.#read((db) => {
      const rows = db.prepare('SELECT * FROM route_labels WHERE source=? AND project_key=? LIMIT ?')
        .all(source, source === 'legacy' ? '' : this.#scope(scope), ROUTE_OBSERVATION_LIMITS.labels + 1);
      if (rows.length > ROUTE_OBSERVATION_LIMITS.labels) throw unavailable();
      return rows.map((row) => this.#routeLabel(row));
    });
  }
  #routeLabel(row: Row): RouteLabel {
    const id = observationId(row.id, row.source === 'legacy');
    if (!['recorded', 'legacy'].includes(row.source) || !isLane(row.label) || !Number.isSafeInteger(row.version) || row.version < 1) throw unavailable();
    return { id, source: row.source, label: row.label, version: row.version, at: jobTime(row.at) };
  }
  labelRoute(scope: JobScope, id: string, label: Lane, version: number, source: 'recorded' | 'legacy', at: number, valid: () => boolean = () => true): RouteLabel {
    this.#workspaceOwner(scope); observationId(id, source === 'legacy'); jobTime(at);
    if (!isLane(label) || !['recorded', 'legacy'].includes(source) || !Number.isSafeInteger(version) || version < 0) throw new BosunError('invalid', 'Invalid route label');
    const projectKey = source === 'legacy' ? '' : this.#scope(scope);
    return this.#transaction((db) => {
      if (source === 'recorded' && !db.prepare('SELECT 1 FROM route_observations WHERE id=? AND project_key=?').get(id, projectKey)) throw new BosunError('not_found', 'Observation not found');
      if (!valid()) throw new BosunError('conflict', 'Observation source changed');
      const prior = db.prepare('SELECT * FROM route_labels WHERE source=? AND project_key=? AND id=?').get(source, projectKey, id);
      if ((prior ? this.#routeLabel(prior).version : 0) !== version) throw new BosunError('conflict', 'Label version changed');
      if (!prior && Number(db.prepare('SELECT count(*) AS n FROM route_labels').get()!.n) >= ROUTE_OBSERVATION_LIMITS.labels
        || Number(db.prepare('SELECT count(*) AS n FROM route_label_events').get()!.n) >= ROUTE_OBSERVATION_LIMITS.labelEvents) throw unavailable();
      const result: RouteLabel = { id, source, label, version: version + 1, at };
      db.prepare('INSERT INTO route_labels(source,project_key,id,version,label,at) VALUES(?,?,?,?,?,?) ON CONFLICT(source,project_key,id) DO UPDATE SET version=excluded.version,label=excluded.label,at=excluded.at')
        .run(source, projectKey, id, result.version, label, at);
      db.prepare('INSERT INTO route_label_events(source,project_key,id,version,label,at) VALUES(?,?,?,?,?,?)').run(source, projectKey, id, result.version, label, at);
      if (!valid()) throw new BosunError('conflict', 'Observation source changed');
      return result;
    });
  }
  readonly watches: WatchStorage = {
    find: (scope, id) => this.#read(db => { cardOwner(scope); return this.#findWatch(db, scope, id); }),
    reserve: (scope, input) => {
      cardOwner(scope); const record = watchRecord(input);
      if (record.projectId !== this.#scope(scope) || record.state !== 'pending' || record.version !== 1 || record.handle !== null)
        throw new BosunError('invalid', 'Invalid watch reservation');
      return this.#transaction(db => {
        const existing = this.#findWatch(db, scope, record.jobId);
        if (existing) return { record: existing, duplicate: true };
        const job = this.#get(db, scope, record.jobId);
        const metadata = this.metadata(scope, record.jobId);
        if (job.requestId !== record.requestId || metadata.cwd !== record.cwd)
          throw new BosunError('conflict', 'Watch job binding changed');
        if (Number(db.prepare('SELECT count(*) AS n FROM watch_receipts').get()!.n) >= WATCH_LIMITS.records) throw unavailable();
        db.prepare('INSERT INTO watch_receipts(job_id,project_key,request_id,version,payload) VALUES(?,?,?,?,?)')
          .run(record.jobId, record.projectId, record.requestId, record.version, JSON.stringify(record));
        return { record, duplicate: false };
      });
    },
    finish: (scope, id, version, state, handle, at) => {
      cardOwner(scope); jobTime(at);
      return this.#transaction(db => {
        const record = this.#findWatch(db, scope, id);
        if (!record || record.version !== version || record.state !== 'pending') throw new BosunError('conflict', 'Watch receipt changed');
        return this.#putWatch(db, watchRecord({ ...record, state, handle, version: version + 1, updatedAt: at }));
      });
    },
  };
  #watch(row: Row): WatchRecord {
    if (typeof row.payload !== 'string' || utf8Bytes(row.payload) > WATCH_LIMITS.recordBytes) throw unavailable();
    const record = watchRecord(JSON.parse(row.payload));
    if (record.jobId !== row.job_id || record.projectId !== row.project_key || record.requestId !== row.request_id || record.version !== row.version) throw unavailable();
    return record;
  }
  #findWatch(db: SqliteDatabase, scope: JobScope, id: string): WatchRecord | null {
    const row = db.prepare('SELECT * FROM watch_receipts WHERE job_id=? AND project_key=?').get(jobId(id), this.#scope(scope));
    return row ? this.#watch(row) : null;
  }
  #putWatch(db: SqliteDatabase, record: WatchRecord): WatchRecord {
    db.prepare('UPDATE watch_receipts SET version=?,payload=? WHERE job_id=?').run(record.version, JSON.stringify(record), record.jobId);
    return record;
  }
  readonly cards:CardStorage={
    findRequest:(scope,requestId)=>this.#read(db=>{cardOwner(scope);const row=db.prepare('SELECT * FROM card_receipts WHERE project_key=? AND request_id=?').get(this.#scope(scope),jobId(requestId));return row?this.#card(row):null;}),
    get:(scope,id)=>this.#read(db=>this.#getCard(db,scope,id)),
    reserve:(scope,input)=>{
      cardOwner(scope);const record=cardRecord(input);assertCardHash(record);
      if(record.projectId!==this.#scope(scope)||record.state!=='pending'||record.version!==1||record.acknowledged)throw new BosunError('invalid','Invalid card reservation');
      return this.#transaction(db=>{
        const duplicate=db.prepare('SELECT * FROM card_receipts WHERE project_key=? AND request_id=?').get(record.projectId,record.requestId);if(duplicate)return {record:this.#card(duplicate),duplicate:true};
        if(Number(db.prepare('SELECT count(*) AS n FROM card_receipts').get()!.n)>=CARD_LIMITS.records)throw unavailable();
        for(const row of db.prepare('SELECT * FROM card_receipts WHERE project_key=? AND target=?').all(record.projectId,record.binding.id)){
          const previous=this.#card(row);if(previous.binding.common!==record.binding.common||previous.binding.root!==record.binding.root)throw new BosunError('conflict','Card identity changed');
          if(previous.state==='pending'||previous.state==='unknown'&&!previous.acknowledged)throw new BosunError('conflict','Card delivery requires explicit reconciliation');
        }
        db.prepare('INSERT INTO card_receipts(id,project_key,request_id,target,version,payload) VALUES(?,?,?,?,1,?)').run(record.id,record.projectId,record.requestId,record.binding.id,JSON.stringify(record));return {record,duplicate:false};
      });
    },
    finish:(scope,id,version,state,at)=>this.#transaction(db=>{
      const current=this.#getCard(db,scope,id);jobTime(at);
      if(current.version!==version||current.state!=='pending'||!['applied','unknown','not_started'].includes(state))throw new BosunError('conflict','Card receipt changed');
      return this.#putCard(db,cardRecord({...current,state,version:version+1,updatedAt:at}));
    }),
    acknowledge:(scope,id,version,at)=>this.#transaction(db=>{
      const current=this.#getCard(db,scope,id);jobTime(at);
      if(current.version!==version||current.state!=='unknown'||current.acknowledged)throw new BosunError('conflict','Card receipt changed');
      return this.#putCard(db,cardRecord({...current,acknowledged:true,version:version+1,updatedAt:at}));
    }),
  };
  #card(row:Row):CardRecord{
    if(typeof row.payload!=='string'||utf8Bytes(row.payload)>CARD_LIMITS.recordBytes)throw unavailable();
    const record=cardRecord(JSON.parse(row.payload));assertCardHash(record);
    if(record.id!==row.id||record.projectId!==row.project_key||record.requestId!==row.request_id||record.binding.id!==row.target||record.version!==row.version)throw unavailable();return record;
  }
  #getCard(db:SqliteDatabase,scope:JobScope,id:string):CardRecord{
    cardOwner(scope);const row=db.prepare('SELECT * FROM card_receipts WHERE id=? AND project_key=?').get(jobId(id),this.#scope(scope));if(!row)throw new BosunError('not_found','Card receipt not found');return this.#card(row);
  }
  #putCard(db:SqliteDatabase,record:CardRecord):CardRecord{
    db.prepare('UPDATE card_receipts SET version=?,payload=? WHERE id=?').run(record.version,JSON.stringify(record),record.id);return record;
  }
  readonly checks:CheckStorage={
    findRequest:(scope,requestId)=>this.#read(db=>{this.#workspaceOwner(scope);const row=db.prepare('SELECT * FROM check_artifacts WHERE project_key=? AND request_id=?').get(this.#scope(scope),jobId(requestId));return row?this.#check(row):null;}),
    get:(scope,id)=>this.#read(db=>this.#getCheck(db,scope,id)),
    list:(scope,reviewId)=>this.#read(db=>{this.#getReview(db,scope,reviewId);return db.prepare('SELECT * FROM check_artifacts WHERE project_key=? AND review_id=? ORDER BY rowid LIMIT ?').all(this.#scope(scope),reviewId,CHECK_LIMITS.perReview).map(row=>this.#check(row));}),
    reserve:(scope,input)=>{this.#workspaceOwner(scope);const record=checkRecord(input);assertCheckHash(record);if(record.projectId!==this.#scope(scope)||record.jobId!==null||record.version!==1||record.outcome!==null)throw new BosunError('invalid','Invalid check reservation');return this.#transaction(db=>{
      const row=db.prepare('SELECT * FROM check_artifacts WHERE project_key=? AND request_id=?').get(record.projectId,record.requestId);if(row)return {record:this.#check(row),duplicate:true};const review=this.#getReview(db,scope,record.reviewId);if(review.snapshot.revision!==record.revision||review.snapshot.root!==record.root)throw new BosunError('conflict','Check review source changed');
      if(Number(db.prepare('SELECT count(*) AS n FROM check_artifacts').get()!.n)>=CHECK_LIMITS.records||Number(db.prepare('SELECT count(*) AS n FROM check_artifacts WHERE review_id=?').get(record.reviewId)!.n)>=CHECK_LIMITS.perReview)throw unavailable();
      db.prepare('INSERT INTO check_artifacts(id,project_key,request_id,review_id,job_id,version,payload) VALUES(?,?,?,?,NULL,1,?)').run(record.id,record.projectId,record.requestId,record.reviewId,JSON.stringify(record));return {record,duplicate:false};
    });},
  };
  #check(row:Row):CheckRecord{const record=checkRecord(JSON.parse(row.payload));if(record.id!==row.id||record.projectId!==row.project_key||record.requestId!==row.request_id||record.reviewId!==row.review_id||record.jobId!==row.job_id||record.version!==row.version)throw unavailable();return record;}
  #getCheck(db:SqliteDatabase,scope:JobScope,id:string):CheckRecord{this.#workspaceOwner(scope);const row=db.prepare('SELECT * FROM check_artifacts WHERE id=? AND project_key=?').get(jobId(id),this.#scope(scope));if(!row)throw new BosunError('not_found','Check not found');return this.#check(row);}
  readonly reviews:ReviewStorage={
    findRequest:(scope,requestId)=>this.#read(db=>{this.#workspaceOwner(scope);const row=db.prepare('SELECT * FROM review_artifacts WHERE project_key=? AND request_id=?').get(this.#scope(scope),jobId(requestId));return row?this.#review(row):null;}),
    get:(scope,id)=>this.#read(db=>this.#getReview(db,scope,id)),
    reserve:(scope,input)=>{
      this.#workspaceOwner(scope);const record=reviewRecord(input);if(record.projectId!==this.#scope(scope)||record.version!==1||record.jobId!==null)throw new BosunError('invalid','Invalid review reservation');
      return this.#transaction(db=>{
        const row=db.prepare('SELECT * FROM review_artifacts WHERE project_key=? AND request_id=?').get(record.projectId,record.requestId);if(row)return {record:this.#review(row),duplicate:true};
        if(Number(db.prepare('SELECT count(*) AS n FROM review_artifacts').get()!.n)>=REVIEW_LIMITS.records)throw unavailable();
        db.prepare('INSERT INTO review_artifacts(id,project_key,request_id,job_id,version,payload) VALUES(?,?,?,NULL,1,?)').run(record.id,record.projectId,record.requestId,JSON.stringify(record));return {record,duplicate:false};
      });
    },
  };
  #review(row:Row):ReviewRecord {
    const record=reviewRecord(JSON.parse(row.payload));if(record.id!==row.id||record.projectId!==row.project_key||record.requestId!==row.request_id||record.jobId!==row.job_id||record.version!==row.version)throw unavailable();return record;
  }
  #getReview(db:SqliteDatabase,scope:JobScope,id:string):ReviewRecord {
    this.#workspaceOwner(scope);const row=db.prepare('SELECT * FROM review_artifacts WHERE id=? AND project_key=?').get(jobId(id),this.#scope(scope));if(!row)throw new BosunError('not_found','Review not found');return this.#review(row);
  }
  readonly workspaces: WorkspaceStorage = {
    byPath: (scope,path) => this.#read(db => {
      this.#workspaceOwner(scope); workspaceText(path); const row = db.prepare('SELECT * FROM workspaces WHERE project_key=? AND path=?').get(this.#scope(scope),path);
      return row ? this.#workspace(row) : null;
    }),
    jobWorkspace: (scope, id) => this.#read(db => {
      this.#workspaceOwner(scope); const row = db.prepare('SELECT workspace_id FROM workspace_jobs WHERE project_key=? AND job_id=?').get(this.#scope(scope), jobId(id));
      return row ? String(row.workspace_id) : null;
    }),
    findRequest: (scope, requestId) => this.#read(db => {
      this.#workspaceOwner(scope); const row = db.prepare('SELECT * FROM workspaces WHERE project_key=? AND request_id=?').get(this.#scope(scope), jobId(requestId));
      return row ? this.#workspace(row) : null;
    }),
    get: (scope, id) => this.#read(db => this.#getWorkspace(db, scope, id)),
    list: scope => this.#read(db => {
      this.#workspaceOwner(scope);
      return db.prepare('SELECT * FROM workspaces WHERE project_key=? ORDER BY id LIMIT ?').all(this.#scope(scope), WORKSPACE_LIMITS.records).map(row => this.#workspace(row));
    }),
    reserve: (scope, input) => {
      this.#workspaceOwner(scope); const record = workspaceRecord(input);
      if (record.projectId !== this.#scope(scope) || record.version !== 1 || record.state !== 'creating') throw new BosunError('invalid', 'Invalid workspace reservation');
      return this.#transaction(db => {
        const duplicate = db.prepare('SELECT * FROM workspaces WHERE project_key=? AND request_id=?').get(record.projectId, record.requestId);
        if (duplicate) return { record: this.#workspace(duplicate), duplicate: true };
        if (Number(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get()!.n) >= WORKSPACE_LIMITS.records) throw unavailable();
        db.prepare('INSERT INTO workspaces(id,project_key,request_id,repository,path,version,payload) VALUES(?,?,?,?,?,?,?)')
          .run(record.id, record.projectId, record.requestId, record.repository, record.path, record.version, JSON.stringify(record));
        return { record, duplicate: false };
      });
    },
    finish: (scope, id, version, state, at) => {
      if (state !== 'ready' && state !== 'unknown') throw new BosunError('invalid', 'Invalid workspace outcome'); jobTime(at);
      return this.#transaction(db => {
        const prior = this.#getWorkspace(db, scope, id);
        if (prior.version !== version || prior.state !== 'creating') throw new BosunError('conflict', 'Workspace changed');
        const record = workspaceRecord({ ...prior, state, version: version + 1, updatedAt: at });
        db.prepare('UPDATE workspaces SET version=?,payload=? WHERE id=? AND project_key=? AND version=?').run(record.version, JSON.stringify(record), id, this.#scope(scope), version);
        return record;
      });
    },
    jobs: (scope, path) => this.#read(db => {
      this.#workspaceOwner(scope); workspaceText(path);
      return db.prepare(`SELECT ${COLUMNS} FROM jobs WHERE project_key=? AND (json_extract(payload,'$.cwd')=? OR id IN
        (SELECT job_id FROM workspace_jobs WHERE project_key=? AND workspace_id IN (SELECT id FROM workspaces WHERE project_key=? AND path=?))) ORDER BY id LIMIT 1024`)
        .all(this.#scope(scope), path, this.#scope(scope), this.#scope(scope), path).map(snapshot);
    }),
  };
  #workspaceOwner(scope: JobScope): void { if (jobScope(scope).audience !== 'owner') throw new BosunError('unsupported', 'Owner workspace operation required'); }
  #workspace(row: Row): WorkspaceRecord {
    const record = workspaceRecord(JSON.parse(row.payload));
    if (record.id !== row.id || record.projectId !== row.project_key || record.requestId !== row.request_id || record.repository !== row.repository || record.path !== row.path || record.version !== row.version) throw unavailable();
    return record;
  }
  #getWorkspace(db: SqliteDatabase, scope: JobScope, id: string): WorkspaceRecord {
    this.#workspaceOwner(scope); const row = db.prepare('SELECT * FROM workspaces WHERE id=? AND project_key=?').get(jobId(id), this.#scope(scope));
    if (!row) throw new BosunError('not_found', 'Workspace not found'); return this.#workspace(row);
  }
  #db: SqliteDatabase | null = null;
  #assertOwner: () => void;
  #maxQueue: number; #maxJobs: number; #maxEvents: number; #maxReceipts: number; #maxDailyGroups: number; #retentionDays: number;
  #maxNotifications: number; #maxPendingNotifications: number;
  #fenced = false;
  constructor({ file, assertOwner, maxQueue = 64, maxJobs = 1024, maxEvents = 32768, maxReceipts = JOB_RETENTION.receipts, maxDailyGroups = JOB_RETENTION.dailyGroups, retentionDays = JOB_RETENTION.days,
    maxNotifications = NOTIFICATION_LIMITS.receipts, maxPendingNotifications = NOTIFICATION_LIMITS.pending }: {
    file: string; assertOwner(): void; maxQueue?: number; maxJobs?: number; maxEvents?: number; maxReceipts?: number; maxDailyGroups?: number; retentionDays?: number;
    maxNotifications?: number; maxPendingNotifications?: number;
  }) {
    this.#assertOwner = assertOwner; this.#maxQueue = maxQueue; this.#maxJobs = maxJobs; this.#maxEvents = maxEvents;
    this.#maxReceipts = maxReceipts; this.#maxDailyGroups = maxDailyGroups; this.#retentionDays = retentionDays;
    this.#maxNotifications = maxNotifications; this.#maxPendingNotifications = maxPendingNotifications;
    try {
      if (typeof assertOwner !== 'function' || !Number.isSafeInteger(maxQueue) || maxQueue < 1 || maxQueue > 256
        || !Number.isSafeInteger(maxJobs) || maxJobs < maxQueue || maxJobs > 1024
        || !Number.isSafeInteger(maxEvents) || maxEvents < maxJobs * 3 || maxEvents > 32768
        || !Number.isSafeInteger(maxReceipts) || maxReceipts < 1 || maxReceipts > JOB_RETENTION.receipts
        || !Number.isSafeInteger(maxDailyGroups) || maxDailyGroups < 1 || maxDailyGroups > JOB_RETENTION.dailyGroups
        || !Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650
        || !Number.isSafeInteger(maxNotifications) || maxNotifications < 1 || maxNotifications > NOTIFICATION_LIMITS.maxReceipts
        || !Number.isSafeInteger(maxPendingNotifications) || maxPendingNotifications < 1 || maxPendingNotifications > NOTIFICATION_LIMITS.pending || maxPendingNotifications > maxNotifications) throw new BosunError('invalid', 'Invalid job storage limits');
      assertOwner(); this.#db = openOwnedSqlite(file, { readOnly: true });
      this.#db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0; PRAGMA temp_store=MEMORY;');
      const version = Number(this.#db.prepare('PRAGMA user_version').get()!.user_version);
      const rows = this.#db.prepare(`SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY rowid LIMIT ${SCHEMA.length + 1}`).all();
      if (version === 0 ? rows.length !== 0 : version !== 1 || rows.length !== SCHEMA.length || rows.some((r, i) => normalize(r.sql) !== normalize(SCHEMA[i]))) throw unavailable();
      this.#db.close(); this.#db = null;
      assertOwner(); this.#db = openOwnedSqlite(file);
      this.#db.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      if (version === 0) {
        this.#transaction((db) => { for (const sql of SCHEMA) db.exec(sql); db.exec('PRAGMA user_version=1'); });
      }
    } catch (e) { try { this.close(); } catch {} throw this.#error(e); }
  }
  #available(): SqliteDatabase {
    if (!this.#db || this.#fenced) throw unavailable(this.#fenced);
    try { this.#assertOwner(); } catch { throw unavailable(); }
    return this.#db;
  }
  #error(error: unknown): BosunError {
    try {
      if (error instanceof BosunError) {
        if (error.details?.outcome === 'unknown') return unavailable(true);
        if (error.code === 'not_found') return new BosunError('not_found', 'Job not found');
        if (error.code === 'conflict') return new BosunError('conflict', 'Job version or state conflict');
        if (error.code === 'invalid') return new BosunError('invalid', 'Invalid job request');
      }
    } catch {}
    return unavailable();
  }
  #fence(): void {
    this.#fenced = true;
    const db = this.#db; this.#db = null;
    try { if (db?.isTransaction) db.exec('ROLLBACK'); } catch {}
    try { db?.close(); } catch {}
  }
  #transaction<T>(fn: (db: SqliteDatabase) => T): T {
    const db = this.#available();
    try { db.exec('BEGIN IMMEDIATE'); }
    catch (e) {
      try { if (db.isTransaction) db.exec('ROLLBACK'); }
      catch { this.#fence(); throw unavailable(true); }
      throw this.#error(e);
    }
    let result: T;
    try { result = fn(db); this.#assertOwner(); }
    catch (e) {
      try { db.exec('ROLLBACK'); } catch { this.#fence(); throw unavailable(true); }
      throw this.#error(e);
    }
    // Crossing COMMIT is an uncertain-receipt boundary even if SQLite subsequently reports no transaction.
    try { db.exec('COMMIT'); } catch { this.#fence(); throw unavailable(true); }
    return result;
  }
  #read<T>(fn: (db: SqliteDatabase) => T): T { try { return fn(this.#available()); } catch (e) { throw this.#error(e); } }
  #scope(scope: JobScope): string { return jobScope(scope).projectId ?? ''; }
  #owner(scope: JobScope): number { return Number(jobScope(scope).audience !== 'model'); }
  #get(db: SqliteDatabase, scope: JobScope, id: string): JobSnapshot {
    const row = db.prepare(`SELECT ${COLUMNS} FROM jobs WHERE id=? AND project_key=? AND (?=1 OR owner_only=0)`).get(jobId(id), this.#scope(scope), this.#owner(scope));
    if (row) return snapshot(row);
    const receipt = db.prepare(`SELECT ${COLUMNS} FROM job_receipts WHERE id=? AND project_key=? AND (?=1 OR owner_only=0)`).get(id, this.#scope(scope), this.#owner(scope));
    if (!receipt) throw new BosunError('not_found', 'Job not found'); return { ...snapshot(receipt), retained: 'receipt' };
  }
  #event(db: SqliteDatabase, job: JobSnapshot, kind: JobEvent['kind']): void {
    const count = Number(db.prepare('SELECT COUNT(*) AS n FROM job_events').get()!.n);
    const pending = Number(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','held','running')").get()!.n);
    // Reserve one terminal/recovery event for each unfinished job; pressure never spends that reserve on progress.
    if (count >= this.#maxEvents - pending) throw unavailable();
    db.prepare('INSERT INTO job_events(job_id,state,version,at,kind,reason) VALUES(?,?,?,?,?,?)').run(job.id, job.state, job.version, job.updatedAt, kind, job.reason);
  }
  findRequest(scope: JobScope, requestId: string): JobSnapshot | null {
    return this.#read((db) => this.#findRequest(db, scope, requestId));
  }
  #findRequest(db: SqliteDatabase, scope: JobScope, requestId: string): JobSnapshot | null {
    const row = db.prepare(`SELECT ${COLUMNS} FROM jobs WHERE project_key=? AND request_id=? AND (?=1 OR owner_only=0)`).get(this.#scope(scope), jobId(requestId), this.#owner(scope));
    if (row) return snapshot(row);
    const receipt = db.prepare(`SELECT ${COLUMNS} FROM job_receipts WHERE project_key=? AND request_id=? AND (?=1 OR owner_only=0)`).get(this.#scope(scope), requestId, this.#owner(scope));
    return receipt ? { ...snapshot(receipt), retained: 'receipt' } : null;
  }
  create(scope: JobScope, id: string, input: JobInput, at: number): { job: JobSnapshot; duplicate: boolean } {
    requirePublicInput(input); const projectKey = this.#scope(scope);
    if (!this.#owner(scope) && (Object.getOwnPropertyDescriptor(input, 'ownerOnly')?.value === true
      || Object.getOwnPropertyDescriptor(input, 'allowUnknownQuota') !== undefined)) throw new BosunError('unsupported', 'Owner job permission required');
    if (jobScope(scope).audience !== 'owner' && ['workspaceId','workspaceVersion'].some(key => Object.getOwnPropertyDescriptor(input,key) !== undefined)) throw new BosunError('unsupported','Owner workspace operation required');
    if(jobScope(scope).audience!=='owner'&&Object.getOwnPropertyDescriptor(input,'reviewId')!==undefined)throw new BosunError('unsupported','Owner review operation required');
    if(jobScope(scope).audience!=='owner'&&Object.getOwnPropertyDescriptor(input,'checkId')!==undefined)throw new BosunError('unsupported','Owner verification operation required');
    if(jobScope(scope).audience!=='owner'&&['managedId','managedVersion'].some(key=>Object.getOwnPropertyDescriptor(input,key)!==undefined))throw new BosunError('unsupported','Owner managed operation required');
    if(jobScope(scope).audience==='model'&&Object.getOwnPropertyDescriptor(input,'submittedBy')!==undefined&&Object.getOwnPropertyDescriptor(input,'submittedBy')?.value!=='model')throw new BosunError('unsupported','Job origin is assigned by the authority');
    const accepted = {...acceptedJob(input),submittedBy:jobScope(scope).audience==='model'?'model' as const:'owner' as const}; jobId(id); jobTime(at);
    return this.#transaction((db) => {
      const duplicate = this.#findRequest(db, scope, accepted.requestId);
      if (duplicate) return { job: duplicate, duplicate: true };
      if (accepted.managedId) {
        if (accepted.ownerOnly !== true) throw new BosunError('unsupported','Owner managed operation required');
        if (accepted.managedVersion === 0) {
          if (accepted.runnerId !== MANAGED_START_RUNNER) throw new BosunError('invalid','Invalid managed bootstrap');
        } else {
          const source = this.#ownership(db, projectKey, accepted.managedId);
          const selectionChanged = accepted.runnerId === MANAGED_HANDOFF_RUNNER
            ? accepted.access !== 'read' || accepted.effort !== undefined
            : source.session.hostId !== accepted.runnerId || source.session.model !== accepted.model || source.session.access !== accepted.access || (source.bootstrap?.effort ?? null) !== (accepted.effort ?? null);
          if (source.phase !== 'active' || source.version !== accepted.managedVersion || source.cwd !== accepted.cwd || selectionChanged) throw new BosunError('conflict','Managed job binding changed');
        }
      }
      let review:ReviewRecord|undefined;
      let check:CheckRecord|undefined;
      if(accepted.checkId!==undefined){check=this.#getCheck(db,scope,accepted.checkId);assertCheckHash(check);if(check.jobId!==null||check.requestId!==accepted.requestId||accepted.runnerId!==CHECK_RUNNER||accepted.ownerOnly!==true||accepted.model!=='verification'||accepted.cwd!==check.root||accepted.reviewId!==undefined)throw new BosunError('conflict','Check selection or linkage changed');}
      if(accepted.reviewId!==undefined){
        review=this.#getReview(db,scope,accepted.reviewId);
        if(review.jobId!==null||review.requestId!==accepted.requestId||accepted.access!=='read'||accepted.ownerOnly!==true||review.snapshot.root!==accepted.cwd||review.runnerId!==accepted.runnerId||review.model!==accepted.model||review.effort!==(accepted.effort??null))throw new BosunError('conflict','Review selection or linkage changed');
      }
      if (accepted.workspaceId !== undefined) {
        const workspace = this.#getWorkspace(db, scope, accepted.workspaceId);
        if (workspace.version !== accepted.workspaceVersion || workspace.state !== 'ready' || workspace.path !== accepted.cwd) throw new BosunError('conflict', 'Workspace job binding changed');
        if (Number(db.prepare('SELECT COUNT(*) AS n FROM workspace_jobs').get()!.n) >= JOB_RETENTION.receipts) throw unavailable();
      }
      this.#prune(db, at, undefined, JOB_RETENTION.batch);
      if (db.prepare('SELECT 1 FROM job_receipts WHERE id=? OR (project_key=? AND request_id=?)').get(id, projectKey, accepted.requestId)) throw new BosunError('conflict', 'Retained job exists');
      if (Number(db.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n) >= this.#maxJobs
        || Number(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','held')").get()!.n) >= this.#maxQueue) throw unavailable();
      db.prepare('INSERT INTO jobs(id,project_key,request_id,task_id,runner_id,privacy,payload,state,version,created_at,updated_at,cancel_requested,owner_only,allow_unknown_quota) VALUES(?,?,?,?,?,?,?,\'queued\',1,?,?,0,?,?)')
        .run(id, projectKey, accepted.requestId, accepted.taskId, accepted.runnerId, 'public', JSON.stringify(accepted), at, at, Number(accepted.ownerOnly === true), Number(accepted.allowUnknownQuota === true));
      if (accepted.workspaceId !== undefined) db.prepare('INSERT INTO workspace_jobs(job_id,workspace_id,project_key) VALUES(?,?,?)').run(id,accepted.workspaceId,projectKey);
      if (accepted.managedId !== undefined) {
        if(Number(db.prepare('SELECT COUNT(*) AS n FROM managed_jobs').get()!.n)>=JOB_RETENTION.receipts)throw unavailable();
        db.prepare('INSERT INTO managed_jobs(job_id,managed_id,project_key,cwd) VALUES(?,?,?,?)').run(id,accepted.managedId,projectKey,accepted.cwd);
      }
      if(review){const linked=reviewRecord({...review,jobId:id,version:review.version+1});db.prepare('UPDATE review_artifacts SET job_id=?,version=?,payload=? WHERE id=? AND project_key=? AND version=?').run(id,linked.version,JSON.stringify(linked),review.id,projectKey,review.version);}
      if(check){const linked=checkRecord({...check,jobId:id,version:check.version+1});db.prepare('UPDATE check_artifacts SET job_id=?,version=?,payload=? WHERE id=? AND project_key=? AND version=?').run(id,linked.version,JSON.stringify(linked),check.id,projectKey,check.version);}
      const job = this.#get(db, scope, id); this.#event(db, job, 'created'); return { job, duplicate: false };
    });
  }
  get(scope: JobScope, id: string): JobSnapshot { return this.#read((db) => this.#get(db, scope, id)); }
  input(scope: JobScope, id: string): JobInput {
    return this.#read((db) => {
      this.#get(db, scope, id);
      if (!db.prepare('SELECT 1 FROM jobs WHERE id=?').get(id)) throw unavailable();
      // Stored classification is checked before selecting accepted owner task payload.
      if (db.prepare('SELECT privacy FROM jobs WHERE id=?').get(id)!.privacy !== 'public') throw new BosunError('private_input', 'Inference requires explicitly public input');
      return acceptedJob(JSON.parse(String(db.prepare('SELECT payload FROM jobs WHERE id=?').get(id)!.payload)) as JobInput);
    });
  }
  metadata(scope: JobScope, id: string) {
    return this.#read(db => {
      const job = this.#get(db, scope, id);
      if (job.retained) throw unavailable();
      const row = db.prepare('SELECT privacy,payload FROM jobs WHERE id=?').get(id)!;
      if (row.privacy !== 'public') throw new BosunError('private_input', 'Inference requires explicitly public input');
      const metadata = admissionMetadata(JSON.parse(String(row.payload)));
      const binding = db.prepare('SELECT workspace_id FROM workspace_jobs WHERE job_id=? AND project_key=?').get(id,this.#scope(scope));
      if ((metadata.workspaceId ?? null) !== (binding?.workspace_id ?? null)) throw unavailable();
      const managed = db.prepare('SELECT managed_id,cwd FROM managed_jobs WHERE job_id=? AND project_key=?').get(id,this.#scope(scope));
      if((metadata.managedId??null)!==(managed?.managed_id??null)||managed&&managed.cwd!==metadata.cwd)throw unavailable();
      if(metadata.reviewId!==undefined){const row=db.prepare('SELECT * FROM review_artifacts WHERE id=? AND project_key=?').get(metadata.reviewId,this.#scope(scope));if(!row)throw unavailable();const review=this.#review(row);if(review.jobId!==id||review.snapshot.root!==metadata.cwd||review.runnerId!==job.runnerId||review.model!==metadata.model||review.effort!==(metadata.effort??null)||metadata.access!=='read'||!job.ownerOnly)throw unavailable();}
      if(metadata.checkId!==undefined){const row=db.prepare('SELECT * FROM check_artifacts WHERE id=? AND project_key=?').get(metadata.checkId,this.#scope(scope));if(!row)throw unavailable();const check=this.#check(row);assertCheckHash(check);if(check.jobId!==id||job.runnerId!==CHECK_RUNNER||!job.ownerOnly||metadata.model!=='verification'||metadata.cwd!==check.root)throw unavailable();}
      if (metadata.allowUnknownQuota !== job.allowUnknownQuota) throw unavailable(); return metadata;
    });
  }
  result(scope: JobScope, id: string): string | null {
    return this.#read((db) => {
      this.#get(db, scope, id); const row = db.prepare('SELECT result FROM job_results WHERE job_id=?').get(id);
      if (!row) return null; const value = String(row.result);
      if (!this.#owner(scope)) { try { screenPublicText(value); } catch { return null; } }
      return value;
    });
  }
  list(scope: JobScope, limit = 50): JobSnapshot[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > JOB_LIMITS.eventBatch) throw new BosunError('invalid', 'Invalid job limit');
    return this.#read((db) => db.prepare(`SELECT ${COLUMNS},0 AS retained FROM jobs WHERE project_key=? AND (?=1 OR owner_only=0)
      UNION ALL SELECT ${COLUMNS},1 AS retained FROM job_receipts WHERE project_key=? AND (?=1 OR owner_only=0) ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(this.#scope(scope), this.#owner(scope), this.#scope(scope), this.#owner(scope), limit).map(row => ({ ...snapshot(row), ...(row.retained ? { retained: 'receipt' as const } : {}) })));
  }
  events(scope: JobScope, after: number, limit = 50): { events: JobEvent[]; cursor: number } {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > JOB_LIMITS.eventBatch) throw new BosunError('invalid', 'Invalid job cursor or limit');
    return this.#read((db) => {
      const events = db.prepare(`SELECT e.seq,e.job_id,e.state,e.version,e.at,e.kind,e.reason FROM job_events e JOIN jobs j ON j.id=e.job_id
        WHERE j.project_key=? AND (?=1 OR j.owner_only=0) AND e.seq>? ORDER BY e.seq LIMIT ?`).all(this.#scope(scope), this.#owner(scope), after, limit)
        .map((r) => ({ seq: Number(r.seq), jobId: String(r.job_id), state: r.state, version: Number(r.version), at: Number(r.at), kind: r.kind, reason: r.reason }) as JobEvent);
      return { events, cursor: events.at(-1)?.seq ?? after };
    });
  }
  nextQueued(backgroundRunnerIds: readonly string[] = []): JobSnapshot | null {
    if (backgroundRunnerIds.length > 16) throw new BosunError('invalid', 'Too many background runners');
    const ids = backgroundRunnerIds.map(jobId);
    return this.#read((db) => {
      const priority = ids.length ? `CASE WHEN owner_only=1 AND runner_id IN (${ids.map(() => '?').join(',')}) THEN 1 ELSE 0 END,` : '';
      const row = db.prepare(`SELECT ${COLUMNS} FROM jobs WHERE state='queued' ORDER BY ${priority} rowid LIMIT 1`).get(...ids);
      return row ? snapshot(row) : null;
    });
  }
  #change(db: SqliteDatabase, scope: JobScope, id: string, version: number, change: JobChange, at: number): JobSnapshot {
    const prior = this.#get(db, scope, id);
    if (prior.version !== version) throw new BosunError('conflict', 'Job version or state conflict');
    const job = changedJob(prior, change, at);
    const result = db.prepare('UPDATE jobs SET state=?,version=?,updated_at=?,cancel_requested=?,reason=? WHERE id=? AND version=?')
      .run(job.state, job.version, job.updatedAt, Number(job.cancelRequested), job.reason, id, version);
    if (Number(result.changes) !== 1) throw new BosunError('conflict', 'Job version or state conflict');
    if (change.result !== undefined) db.prepare('INSERT INTO job_results(job_id,result) VALUES(?,?)').run(id, change.result);
    if(['succeeded','failed','cancelled','unknown'].includes(job.state)){
      const row=db.prepare('SELECT * FROM check_artifacts WHERE job_id=? AND project_key=?').get(id,this.#scope(scope));if(row){const record=this.#check(row);assertCheckHash(record);let outcome:CheckReceipt;
        if(change.result!==undefined){const result=JSON.parse(change.result);if(result.checkId!==record.id||result.commandHash!==record.commandHash||result.revision!==record.revision)throw new BosunError('invalid','Invalid verification result linkage');outcome=checkOutcome(result.outcome);if(outcome.phase!=='closed'||(job.state==='succeeded'&&outcome.exitCode!==0)||(job.state==='failed'&&outcome.exitCode===0)||(outcome.checkout==='matches'&&outcome.postRevision!==record.revision))throw new BosunError('invalid','Invalid verification exit receipt');}
        else outcome={phase:job.state==='cancelled'?'not_started':'unknown'};const saved=checkRecord({...record,outcome,version:record.version+1});db.prepare('UPDATE check_artifacts SET version=?,payload=? WHERE id=? AND version=?').run(saved.version,JSON.stringify(saved),record.id,record.version);
      }
    }
    if (prior.state === 'running') {
      const usage = db.prepare('SELECT generation,usage_events,tokens_in,tokens_out FROM job_usage WHERE job_id=? ORDER BY generation DESC LIMIT 1').get(id);
      if (usage) {
        if (change.kind === 'usage') {
          const counts = nativeUsage(change.usage); const events = Number(usage.usage_events) + 1;
          const ambiguous = events > 1; const qualification = ambiguous ? 'ambiguous' : counts.tokensIn === null && counts.tokensOut === null ? 'unavailable'
            : counts.tokensIn === null || counts.tokensOut === null ? 'partial' : 'reported';
          db.prepare('UPDATE job_usage SET tokens_in=?,tokens_out=?,usage_events=?,usage_qualification=? WHERE job_id=? AND generation=?')
            .run(ambiguous ? null : counts.tokensIn, ambiguous ? null : counts.tokensOut, events, qualification, id, usage.generation);
        }
        if (job.state !== 'running') db.prepare(`UPDATE job_usage SET state=?,finished_at=?,usage_qualification=CASE
          WHEN ?='unknown' AND usage_qualification='reported' THEN 'partial' ELSE usage_qualification END WHERE job_id=? AND generation=?`)
          .run(job.state, at, job.state, id, usage.generation);
      }
    }
    this.#event(db, job, change.kind); return job;
  }
  change(scope: JobScope, id: string, version: number, change: JobChange, at: number): JobSnapshot {
    jobTime(at); if (!Number.isSafeInteger(version) || version < 1) throw new BosunError('invalid', 'Invalid job version');
    return this.#transaction((db) => this.#change(db, scope, id, version, change, at));
  }
  startAttempt(scope: JobScope, id: string, version: number, selection: UsageSelection, billing: BillingQualification, at: number): { job: JobSnapshot; usage: JobUsage } {
    jobTime(at); jobId(selection.runnerId);
    if (typeof selection.model !== 'string' || !selection.model || utf8Bytes(selection.model) > 200 || selection.model.includes('\0')
      || selection.effort !== null && (typeof selection.effort !== 'string' || !selection.effort || utf8Bytes(selection.effort) > 80 || selection.effort.includes('\0'))) throw new BosunError('invalid', 'Invalid usage selection');
    const classified = billingQualification(billing);
    return this.#transaction(db => {
      const prior = this.#get(db, scope, id);
      if (db.prepare('SELECT privacy FROM jobs WHERE id=?').get(id)!.privacy !== 'public') throw new BosunError('private_input', 'Inference requires explicitly public input');
      const metadata = admissionMetadata(JSON.parse(String(db.prepare('SELECT payload FROM jobs WHERE id=?').get(id)!.payload)));
      if (prior.state !== 'queued' || prior.runnerId !== selection.runnerId || metadata.model !== selection.model || (metadata.effort ?? null) !== selection.effort) throw new BosunError('conflict', 'Usage selection changed');
      if (Number(db.prepare('SELECT count(*) AS n FROM job_usage').get()!.n) >= 4096) throw unavailable();
      const generation = Number(db.prepare('SELECT coalesce(max(generation),0)+1 AS n FROM job_usage WHERE job_id=?').get(id)!.n);
      if (generation > 8) throw unavailable();
      const job = this.#change(db, scope, id, version, { state: 'running', kind: 'state' }, at);
      db.prepare(`INSERT INTO job_usage(job_id,generation,runner_id,model,effort,billing_kind,vendor,billing_qualification,billing_pool,started_at,state)
        VALUES(?,?,?,?,?,?,?,?,?,?,'running')`).run(id, generation, selection.runnerId, selection.model, selection.effort, classified.kind, classified.vendor, classified.qualification, classified.poolKey ?? null, at);
      return { job, usage: this.#usage(db.prepare('SELECT * FROM job_usage WHERE job_id=? AND generation=?').get(id, generation)!) };
    });
  }
  #usage(row: Row): JobUsage {
    jobId(row.job_id); jobId(row.runner_id); jobTime(row.started_at); if (row.finished_at !== null) jobTime(row.finished_at);
    const classified = billingQualification({ kind: row.billing_kind, vendor: row.vendor, qualification: row.billing_qualification, ...(row.billing_pool === null ? {} : { poolKey: row.billing_pool }) });
    const counts = nativeUsage({ tokensIn: row.tokens_in, tokensOut: row.tokens_out });
    if (!Number.isSafeInteger(row.generation) || row.generation < 1 || row.generation > 8 || typeof row.model !== 'string' || !row.model
      || utf8Bytes(row.model) > 200 || row.model.includes('\0') || row.effort !== null && (typeof row.effort !== 'string' || !row.effort || utf8Bytes(row.effort) > 80)
      || classified.kind !== row.billing_kind || classified.vendor !== row.vendor || classified.qualification !== row.billing_qualification || (classified.poolKey ?? null) !== row.billing_pool
      || !['running', 'succeeded', 'failed', 'unknown'].includes(row.state) || row.cached_tokens !== null || row.reasoning_tokens !== null
      || !Number.isSafeInteger(row.usage_events) || row.usage_events < 0 || row.usage_events > JOB_LIMITS.runnerEvents
      || !['unavailable', 'reported', 'partial', 'ambiguous'].includes(row.usage_qualification)
      || (row.state === 'running') !== (row.finished_at === null)) throw unavailable();
    return { jobId: row.job_id, generation: row.generation, runnerId: row.runner_id, model: row.model, effort: row.effort,
      ...classified,
      state: row.state, startedAt: row.started_at, finishedAt: row.finished_at, ...counts,
      cachedTokens: null, reasoningTokens: null, usageEvents: row.usage_events, usageQualification: row.usage_qualification };
  }
  usageList(scope: JobScope, limit = 50): JobUsage[] {
    if (!this.#owner(scope)) throw new BosunError('unsupported', 'Owner operation required');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new BosunError('invalid', 'Invalid usage limit');
    return this.#read(db => db.prepare(`SELECT u.* FROM job_usage u JOIN jobs j ON j.id=u.job_id
      WHERE j.project_key=? ORDER BY u.started_at DESC,u.job_id,u.generation DESC LIMIT ?`).all(this.#scope(scope), limit).map(row => this.#usage(row)));
  }
  #daily(row: Row): DailyUsage {
    const classified = billingQualification({ kind: row.billing_kind, vendor: row.vendor, qualification: row.billing_qualification,
      ...(/^[a-f0-9]{64}$/.test(row.pool) ? { poolKey: row.pool } : {}) });
    const counters = ['attempts', 'reported', 'partial', 'ambiguous', 'unavailable', 'known_input', 'known_output', 'missing_input', 'missing_output'];
    if (counters.some(key => !Number.isSafeInteger(row[key]) || row[key] < 0) || row.attempts < 1
      || row.reported + row.partial + row.ambiguous + row.unavailable !== row.attempts || row.missing_input > row.attempts || row.missing_output > row.attempts
      || !Number.isSafeInteger(row.day) || row.day < 0 || row.day % 86400000 || typeof row.pool !== 'string'
      || !/^(?:[a-f0-9]{64}|local|attempt:[a-zA-Z0-9_-]{1,80}:[1-8])$/.test(row.pool)
      || classified.kind !== row.billing_kind || classified.vendor !== row.vendor || classified.qualification !== row.billing_qualification) throw unavailable();
    jobId(row.runner_id);
    if (typeof row.model !== 'string' || !row.model || utf8Bytes(row.model) > 200 || row.model.includes('\0')
      || row.effort !== null && (typeof row.effort !== 'string' || !row.effort || utf8Bytes(row.effort) > 80 || row.effort.includes('\0'))) throw unavailable();
    return { day: row.day, runnerId: row.runner_id, model: row.model, effort: row.effort, ...classified, pool: row.pool,
      attempts: row.attempts, reportedAttempts: row.reported, partialAttempts: row.partial, ambiguousAttempts: row.ambiguous, unavailableAttempts: row.unavailable,
      knownTokensIn: row.known_input, knownTokensOut: row.known_output, missingInputAttempts: row.missing_input, missingOutputAttempts: row.missing_output,
      tokensIn: row.missing_input ? null : row.known_input, tokensOut: row.missing_output ? null : row.known_output, cachedTokens: null, reasoningTokens: null };
  }
  usageDaily(scope: JobScope, limit = 50): DailyUsage[] {
    if (!this.#owner(scope)) throw new BosunError('unsupported', 'Owner operation required');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new BosunError('invalid', 'Invalid daily usage limit');
    return this.#read(db => db.prepare('SELECT * FROM usage_daily WHERE project_key=? ORDER BY day DESC,key LIMIT ?').all(this.#scope(scope), limit).map(row => this.#daily(row)));
  }
  #prune(db: SqliteDatabase, at: number, projectKey: string | undefined, limit: number) {
    const cutoff = at - this.#retentionDays * 86400000;
    const eligible = db.prepare(`SELECT ${COLUMNS} FROM jobs WHERE state IN ('succeeded','failed','cancelled') AND updated_at<=?
      AND (? IS NULL OR project_key=?) ORDER BY updated_at,id LIMIT ?`).all(cutoff, projectKey ?? null, projectKey ?? null, limit);
    let jobs = 0; let attempts = 0; let capacityHeld = false;
    const count = (table: 'job_receipts' | 'usage_daily') => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
    for (const source of eligible) {
      if (count('job_receipts') >= this.#maxReceipts) { capacityHeld = true; break; }
      const rows = db.prepare('SELECT * FROM job_usage WHERE job_id=? ORDER BY generation LIMIT 9').all(source.id);
      if (rows.length > 8) throw unavailable();
      const planned = new Map<string, Row>();
      for (const row of rows) {
        const usage = this.#usage(row);
        if (usage.state === 'running' || usage.state === 'unknown' || usage.finishedAt === null || usage.finishedAt > cutoff) throw unavailable();
        const day = Math.floor(usage.startedAt / 86400000) * 86400000;
        const pool = usage.poolKey ?? (usage.kind === 'local' && usage.qualification === 'verified' ? 'local' : `attempt:${usage.jobId}:${usage.generation}`);
        const key = JSON.stringify([source.project_key, day, usage.runnerId, usage.model, usage.effort, usage.kind, usage.vendor, usage.qualification, pool]);
        let prior = planned.get(key) ?? db.prepare('SELECT * FROM usage_daily WHERE key=?').get(key);
        if (prior) this.#daily(prior);
        else prior = { key, project_key: source.project_key, day, runner_id: usage.runnerId, model: usage.model, effort: usage.effort,
          billing_kind: usage.kind, vendor: usage.vendor, billing_qualification: usage.qualification, pool, attempts: 0, reported: 0, partial: 0, ambiguous: 0, unavailable: 0,
          known_input: 0, known_output: 0, missing_input: 0, missing_output: 0 };
        const counts = usage.usageQualification === 'ambiguous' || usage.usageQualification === 'unavailable' ? { tokensIn: null, tokensOut: null } : usage;
        const next = { ...prior, attempts: prior.attempts + 1, [usage.usageQualification]: prior[usage.usageQualification] + 1,
          known_input: prior.known_input + (counts.tokensIn ?? 0), known_output: prior.known_output + (counts.tokensOut ?? 0),
          missing_input: prior.missing_input + Number(counts.tokensIn === null), missing_output: prior.missing_output + Number(counts.tokensOut === null) };
        this.#daily(next); planned.set(key, next);
      }
      const newGroups = [...planned.keys()].filter(key => !db.prepare('SELECT 1 FROM usage_daily WHERE key=?').get(key)).length;
      if (count('usage_daily') + newGroups > this.#maxDailyGroups) { capacityHeld = true; break; }
      for (const row of planned.values()) db.prepare(`INSERT INTO usage_daily(key,project_key,day,runner_id,model,effort,billing_kind,vendor,billing_qualification,pool,
        attempts,reported,partial,ambiguous,unavailable,known_input,known_output,missing_input,missing_output) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET attempts=excluded.attempts,reported=excluded.reported,partial=excluded.partial,ambiguous=excluded.ambiguous,
        unavailable=excluded.unavailable,known_input=excluded.known_input,known_output=excluded.known_output,missing_input=excluded.missing_input,missing_output=excluded.missing_output`)
        .run(row.key, row.project_key, row.day, row.runner_id, row.model, row.effort, row.billing_kind, row.vendor, row.billing_qualification, row.pool,
          row.attempts, row.reported, row.partial, row.ambiguous, row.unavailable, row.known_input, row.known_output, row.missing_input, row.missing_output);
      db.prepare(`INSERT INTO job_receipts(${COLUMNS},retained_at) SELECT ${COLUMNS},? FROM jobs WHERE id=?`).run(at, source.id);
      for (const table of ['job_usage', 'job_results', 'job_events']) db.prepare(`DELETE FROM ${table} WHERE job_id=?`).run(source.id);
      db.prepare('DELETE FROM jobs WHERE id=?').run(source.id); jobs++; attempts += rows.length;
    }
    return { jobs, attempts, capacityHeld };
  }
  prune(scope: JobScope, at: number, limit = JOB_RETENTION.batch) {
    if (!this.#owner(scope)) throw new BosunError('unsupported', 'Owner operation required');
    jobTime(at); if (!Number.isSafeInteger(limit) || limit < 1 || limit > JOB_RETENTION.batch) throw new BosunError('invalid', 'Invalid prune limit');
    const projectKey = this.#scope(scope); return this.#transaction(db => this.#prune(db, at, projectKey, limit));
  }
  retentionStatus(scope: JobScope, at: number) {
    if (!this.#owner(scope)) throw new BosunError('unsupported', 'Owner operation required'); jobTime(at);
    return this.#read(db => {
      const projectKey = this.#scope(scope); const count = (table: string, where = '', args: (string | number)[] = []) => Number(db.prepare(`SELECT count(*) AS n FROM ${table} ${where}`).get(...args)!.n);
      const capacity = { jobs: Math.max(0, this.#maxJobs - count('jobs')), queued: Math.max(0, this.#maxQueue - count('jobs', "WHERE state IN ('queued','held')")),
        receipts: Math.max(0, this.#maxReceipts - count('job_receipts')), dailyGroups: Math.max(0, this.#maxDailyGroups - count('usage_daily')),
        events: Math.max(0, this.#maxEvents - count('job_events') - count('jobs', "WHERE state IN ('queued','held','running')")), attempts: Math.max(0, 4096 - count('job_usage')) };
      return { days: this.#retentionDays, scopedJobs: count('jobs', 'WHERE project_key=?', [projectKey]), scopedReceipts: count('job_receipts', 'WHERE project_key=?', [projectKey]),
        scopedAttempts: count('job_usage u JOIN jobs j ON j.id=u.job_id', 'WHERE j.project_key=?', [projectKey]), scopedDailyGroups: count('usage_daily', 'WHERE project_key=?', [projectKey]),
        eligibleJobs: count('jobs', "WHERE project_key=? AND state IN ('succeeded','failed','cancelled') AND updated_at<=?", [projectKey, at - this.#retentionDays * 86400000]),
        uncertainJobs: count('jobs', "WHERE project_key=? AND state='unknown'", [projectKey]), capacity, pressure: Object.values(capacity).some(value => value === 0) };
    });
  }
  #notification(row: Row): NotificationReceipt {
    const payload = notificationPayload({ jobRef: row.job_ref, state: row.state }); jobId(row.job_id);
    if (row.id !== `n_${row.job_ref}_${row.version}` || !Number.isSafeInteger(row.version) || row.version < 1
      || !['pending', 'submitting', 'submitted', 'held', 'unknown'].includes(row.phase)
      || row.reason !== null && !['sink_missing', 'platform_unsupported', 'command_missing', 'delivery_unknown', 'cancelled', 'interrupted', 'capacity', 'storage_held'].includes(row.reason)) throw unavailable();
    return { ...payload, id: row.id, projectId: row.project_key || null, jobId: row.job_id, version: row.version, phase: row.phase, reason: row.reason, ui: 'unverified' };
  }
  notificationReserve(input: NotificationEvent, jobRef: string, at: number) {
    const event = notificationJob(input); const state = notificationState(event.state); jobTime(at);
    if (!state) return { receipt: null, duplicate: true, capacityHeld: false };
    notificationPayload({ jobRef, state });
    return this.#transaction(db => {
      const existing = db.prepare('SELECT * FROM notification_events WHERE job_id=? AND version=?').get(event.id, event.version);
      if (existing) return { receipt: this.#notification(existing), duplicate: true, capacityHeld: false };
      const current = this.#get(db, { projectId: event.projectId, audience: 'owner' }, event.id);
      if (current.retained || current.version !== event.version || current.state !== event.state) return { receipt: null, duplicate: true, capacityHeld: false };
      if (Number(db.prepare('SELECT count(*) AS n FROM notification_events').get()!.n) >= this.#maxNotifications
        || Number(db.prepare("SELECT count(*) AS n FROM notification_events WHERE phase IN ('pending','submitting')").get()!.n) >= this.#maxPendingNotifications) return { receipt: null, duplicate: false, capacityHeld: true };
      const id = `n_${jobRef}_${event.version}`;
      db.prepare("INSERT INTO notification_events(id,project_key,job_id,version,job_ref,state,phase,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',NULL,?,?)")
        .run(id, event.projectId ?? '', event.id, event.version, jobRef, state, at, at);
      return { receipt: this.#notification(db.prepare('SELECT * FROM notification_events WHERE id=?').get(id)!), duplicate: false, capacityHeld: false };
    });
  }
  notificationNext() {
    return this.#read(db => { const row = db.prepare("SELECT * FROM notification_events WHERE phase='pending' ORDER BY rowid LIMIT 1").get(); return row ? this.#notification(row) : null; });
  }
  #notificationById(db: SqliteDatabase, id: string) {
    if (typeof id !== 'string' || !/^n_job_[a-f0-9]{24}_[0-9]{1,16}$/.test(id)) throw new BosunError('invalid', 'Invalid notification identifier');
    const row = db.prepare('SELECT * FROM notification_events WHERE id=?').get(id); if (!row) throw new BosunError('not_found', 'Notification not found'); return this.#notification(row);
  }
  notificationStart(id: string, at: number) {
    jobTime(at); return this.#transaction(db => {
      const prior = this.#notificationById(db, id); if (prior.phase !== 'pending') throw new BosunError('conflict', 'Notification already dispatched');
      db.prepare("UPDATE notification_events SET phase='submitting',updated_at=? WHERE id=? AND phase='pending'").run(at, id);
      return this.#notificationById(db, id);
    });
  }
  notificationFinish(id: string, input: NotificationDelivery, at: number) {
    jobTime(at); const delivery = notificationDelivery(input); return this.#transaction(db => {
      const prior = this.#notificationById(db, id);
      if (prior.phase !== 'submitting' && !(prior.phase === 'pending' && delivery.phase === 'held')) throw new BosunError('conflict', 'Notification already settled');
      db.prepare('UPDATE notification_events SET phase=?,reason=?,updated_at=? WHERE id=? AND phase=?').run(delivery.phase, delivery.reason, at, id, prior.phase);
      return this.#notificationById(db, id);
    });
  }
  notificationRecover(at: number) {
    jobTime(at); return this.#transaction(db => {
      // A process crash after dispatch cannot establish an OS submission receipt.
      // Persist uncertainty; never dispatch this generation again.
      const changed = db.prepare("UPDATE notification_events SET phase='unknown',reason='interrupted',updated_at=? WHERE phase='submitting'").run(at);
      return Number(changed.changes);
    });
  }
  notificationStatus(scope: JobScope) {
    if (!this.#owner(scope)) throw new BosunError('unsupported', 'Owner operation required');
    return this.#read(db => {
      const count = (phase: string) => Number(db.prepare('SELECT count(*) AS n FROM notification_events WHERE project_key=? AND phase=?').get(this.#scope(scope), phase)!.n);
      const total = Number(db.prepare('SELECT count(*) AS n FROM notification_events').get()!.n);
      const pending = Number(db.prepare("SELECT count(*) AS n FROM notification_events WHERE phase IN ('pending','submitting')").get()!.n);
      const latest = db.prepare("SELECT * FROM notification_events WHERE project_key=? AND phase IN ('held','unknown') ORDER BY updated_at DESC,rowid DESC LIMIT 1").get(this.#scope(scope));
      return { pending: count('pending'), submitting: count('submitting'), submitted: count('submitted'), held: count('held'), unknown: count('unknown'),
        remaining: Math.max(0, this.#maxNotifications - total), pendingRemaining: Math.max(0, this.#maxPendingNotifications - pending), lastReason: latest ? this.#notification(latest).reason : null };
    });
  }
  recover(at: number): number {
    jobTime(at);
    return this.#transaction((db) => {
      for (const row of db.prepare('SELECT * FROM watch_receipts').all()) {
        const record = this.#watch(row);
        if (record.state === 'pending') this.#putWatch(db, watchRecord({ ...record, state: 'unknown', version: record.version + 1, updatedAt: at }));
      }
      for(const row of db.prepare('SELECT * FROM card_receipts').all()){
        const record=this.#card(row);if(record.state==='pending')this.#putCard(db,cardRecord({...record,state:'unknown',version:record.version+1,updatedAt:at}));
      }
      const running = db.prepare(`SELECT ${COLUMNS} FROM jobs WHERE state='running' ORDER BY rowid`).all().map(snapshot);
      for (const job of running) this.#change(db, { projectId: job.projectId }, job.id, job.version, { state: 'unknown', kind: 'state', reason: 'interrupted' }, at);
      this.#prune(db, at, undefined, JOB_RETENTION.batch);
      return running.length;
    });
  }
  #quotaRows(db: SqliteDatabase, poolKey?: string, model?: string): QuotaState[] {
    if (poolKey !== undefined && !/^[a-f0-9]{64}$/.test(poolKey) || model !== undefined && (typeof model !== 'string' || !model.length || model.length > 200)) throw new BosunError('invalid', 'Invalid quota selection');
    const rows = db.prepare(`SELECT key,pool_key,model,version,payload FROM quota_state WHERE (? IS NULL OR pool_key=?)
      AND (? IS NULL OR model IS NULL OR model=?) ORDER BY rowid LIMIT 129`).all(poolKey ?? null, poolKey ?? null, model ?? null, model ?? null);
    if (rows.length > QUOTA_LIMITS.states) throw unavailable();
    return rows.map(row => {
      if (typeof row.payload !== 'string' || utf8Bytes(row.payload) > QUOTA_LIMITS.recordBytes) throw unavailable();
      const state = storedQuotaState(JSON.parse(row.payload));
      if (state.key !== row.key || state.poolKey !== row.pool_key || state.model !== row.model || state.version !== row.version
        || !Number.isSafeInteger(state.version) || state.version < 1 || !Array.isArray(state.windows) || state.windows.length > QUOTA_LIMITS.windows) throw unavailable();
      return state;
    });
  }
  quotaStates(poolKey?: string, model?: string): QuotaState[] { return this.#read(db => this.#quotaRows(db, poolKey, model)); }
  quotaStatesFor(selection: QuotaSelection): QuotaState[] {
    return this.#read(db => { const binding = db.prepare('SELECT pool_key FROM quota_bindings WHERE runner_id=?').get(jobId(selection.runnerId));
      return binding ? this.#quotaRows(db, String(binding.pool_key), selection.model) : []; });
  }
  observeQuotas(entries: readonly { identity: QuotaIdentity; observation: QuotaObservation }[], now: number, selection: QuotaSelection): QuotaState[] {
    jobTime(now); jobId(selection.runnerId);
    if (!Array.isArray(entries) || !entries.length || entries.length > QUOTA_LIMITS.batch || new Set(entries.map(e => e.identity.key)).size !== entries.length
      || entries.some(e => e.identity.poolKey !== entries[0].identity.poolKey || e.observation.model !== selection.model)) throw new BosunError('invalid', 'Invalid quota batch');
    const duplicate = this.#read(db => {
      const states = this.#quotaRows(db); const priors = entries.map(entry => states.find(s => s.key === entry.identity.key));
      const binding = db.prepare('SELECT pool_key FROM quota_bindings WHERE runner_id=?').get(selection.runnerId);
      return priors.every((prior, i) => prior && entries[i].observation.observedAt <= prior.observedAt) && binding?.pool_key === entries[0].identity.poolKey ? priors as QuotaState[] : null;
    });
    if (duplicate) return duplicate;
    return this.#transaction(db => {
      const states = this.#quotaRows(db);
      if (states.length + entries.filter(entry => !states.some(s => s.key === entry.identity.key)).length > QUOTA_LIMITS.states) throw unavailable();
      const results = entries.map(({ identity, observation }) => {
        const prior = states.find(s => s.key === identity.key) ?? null;
        const next = storedQuotaState(mergeQuota(prior, identity, observation, now)); const payload = JSON.stringify(next);
        if (utf8Bytes(payload) > QUOTA_LIMITS.recordBytes) throw unavailable();
        if (!prior || next.version !== prior.version) db.prepare(`INSERT INTO quota_state(key,pool_key,model,version,payload) VALUES(?,?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET pool_key=excluded.pool_key,model=excluded.model,version=excluded.version,payload=excluded.payload`)
          .run(next.key, next.poolKey, next.model, next.version, payload);
        return next;
      });
      const bindings = Number(db.prepare('SELECT COUNT(*) AS n FROM quota_bindings').get()!.n);
      if (bindings >= QUOTA_LIMITS.states && !db.prepare('SELECT 1 FROM quota_bindings WHERE runner_id=?').get(selection.runnerId)) throw unavailable();
      db.prepare('INSERT INTO quota_bindings(runner_id,pool_key) VALUES(?,?) ON CONFLICT(runner_id) DO UPDATE SET pool_key=excluded.pool_key').run(selection.runnerId, entries[0].identity.poolKey);
      return results;
    });
  }
  #ownership(db: SqliteDatabase, projectId: string, id: string): ManagedOwnership {
    if (typeof projectId !== 'string' || !projectId || projectId.length > 200 || projectId.includes('\0')
      || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new BosunError('invalid', 'Invalid managed ownership');
    const row = db.prepare('SELECT id,project_key,owner_id,version,payload FROM managed_ownership WHERE project_key=? AND id=?').get(projectId, id);
    if (!row) throw new BosunError('not_found', 'Managed ownership not found');
    if (typeof row.payload !== 'string' || utf8Bytes(row.payload) > 16384) throw unavailable();
    const value = managedOwnership(JSON.parse(row.payload));
    if (value.id !== row.id || value.projectId !== row.project_key || value.version !== row.version || value.session.ownerId !== row.owner_id) throw unavailable();
    return value;
  }
  ownership(projectId: string, id: string): ManagedOwnership { return this.#read(db => this.#ownership(db, projectId, id)); }
  managedJob(scope: JobScope, id: string): { id: string; cwd: string } | null {
    if(!this.#owner(scope))throw new BosunError('unsupported','Owner managed operation required');
    return this.#read(db=>{this.#get(db,scope,id);const row=db.prepare('SELECT managed_id,cwd FROM managed_jobs WHERE job_id=? AND project_key=?').get(id,this.#scope(scope));
      if(!row)return null;if(typeof row.managed_id!=='string'||!/^ms_[a-f0-9]{32}$/.test(row.managed_id)||typeof row.cwd!=='string'||!row.cwd.startsWith('/')||row.cwd.length>4096)throw unavailable();
      return {id:row.managed_id,cwd:row.cwd};});
  }
  managedUnsettled(scope: JobScope, id: string): string[] {
    if(!this.#owner(scope))throw new BosunError('unsupported','Owner managed operation required');
    return this.#read(db=>{
      const rows=db.prepare("SELECT j.id FROM jobs j JOIN managed_jobs m ON m.job_id=j.id WHERE m.project_key=? AND m.managed_id=? AND j.state IN ('queued','held','running','unknown') LIMIT 1025").all(this.#scope(scope),id);
      if(rows.length>1024)throw unavailable();return rows.map(row=>String(row.id));
    });
  }
  ownerships(projectId: string): ManagedOwnership[] {
    return this.#read(db => {
      if (typeof projectId !== 'string' || !projectId || projectId.length > 200 || projectId.includes('\0')) throw new BosunError('invalid','Invalid managed scope');
      const rows = db.prepare('SELECT id FROM managed_ownership WHERE project_key=? LIMIT 65').all(projectId);
      if (rows.length > 64) throw unavailable();
      return rows.map(row => this.#ownership(db, projectId, String(row.id)));
    });
  }
  reserveOwnership(claim: Parameters<HandoffStorage['registerOwnership']>[0]): ManagedOwnership {
    const value = managedOwnership({ ...claim, version: 1, phase: 'starting', stage: null, retired: null, seedHash: null });
    return this.#transaction(db => {
      if (Number(db.prepare('SELECT COUNT(*) AS n FROM managed_ownership').get()!.n) >= 64
        || db.prepare('SELECT 1 FROM managed_ownership WHERE id=? OR owner_id=?').get(value.id,value.session.ownerId)) throw new BosunError('conflict','Managed source already reserved');
      db.prepare('INSERT INTO managed_ownership(id,project_key,owner_id,version,payload) VALUES(?,?,?,?,?)').run(value.id,value.projectId,value.session.ownerId,value.version,JSON.stringify(value));
      return value;
    });
  }
  bindOwnership(expected: ManagedOwnership, session: ManagedSession): ManagedOwnership {
    return this.#ownershipChange(expected, prior => {
      if (prior.phase !== 'starting' || !prior.bootstrap || session.sessionId === prior.session.sessionId
        || ['hostId','ownerId','generation','model','access'].some(key => session[key as keyof ManagedSession] !== prior.session[key as keyof ManagedSession])) throw new BosunError('conflict','Managed creation binding changed');
      return { ...prior, phase:'seeding', session };
    });
  }
  activateOwnership(expected: ManagedOwnership, seedHash: string): ManagedOwnership {
    return this.#ownershipChange(expected, prior => {
      if (prior.phase !== 'seeding' || !prior.bootstrap || prior.bootstrap.seedHash !== seedHash) throw new BosunError('conflict','Managed seed binding changed');
      return { ...prior, phase:'active', seedHash };
    });
  }
  retireOwnership(expected: ManagedOwnership): ManagedOwnership {
    // Explicit retirement never deletes source history.
    return this.#ownershipChange(expected, prior => {
      if (prior.phase !== 'fenced' || prior.stage) throw new BosunError('conflict','Managed retirement requires a fenced source');
      return { ...prior, phase:'retired' };
    });
  }
  authorityOwnership(expected: ManagedOwnership, artifactId: string): ManagedOwnership {
    return this.#ownershipChange(expected, prior => {
      if(prior.phase !== 'active' || prior.stage) throw new BosunError('conflict','Managed authority requires an active source');
      return { ...prior, authorityArtifactId: artifactId };
    });
  }
  registerOwnership(claim: Parameters<HandoffStorage['registerOwnership']>[0]): ManagedOwnership {
    const value = managedOwnership({ ...claim, version: 1, phase: 'active', stage: null, retired: null });
    return this.#transaction(db => {
      if (Number(db.prepare('SELECT COUNT(*) AS n FROM managed_ownership').get()!.n) >= 64
        || db.prepare('SELECT 1 FROM managed_ownership WHERE id=? OR owner_id=?').get(value.id, value.session.ownerId)
        || db.prepare('SELECT 1 FROM managed_retirements WHERE owner_id=? AND generation=?').get(value.session.ownerId, value.session.generation)) throw new BosunError('conflict', 'Managed ownership exists or held');
      db.prepare('INSERT INTO managed_ownership(id,project_key,owner_id,version,payload) VALUES(?,?,?,?,?)').run(value.id, value.projectId, value.session.ownerId, value.version, JSON.stringify(value));
      return value;
    });
  }
  #ownershipChange(expected: ManagedOwnership, change: (prior: ManagedOwnership, db: SqliteDatabase) => ManagedOwnership): ManagedOwnership {
    const value = managedOwnership(expected);
    return this.#transaction(db => {
      const prior = this.#ownership(db, value.projectId, value.id);
      if (JSON.stringify(prior) !== JSON.stringify(value)) throw new BosunError('conflict', 'Managed ownership changed');
      const next = managedOwnership({ ...change(prior, db), version: prior.version + 1 });
      if (next.id !== prior.id || next.projectId !== prior.projectId || next.cwd !== prior.cwd || next.session.ownerId !== prior.session.ownerId) throw new BosunError('conflict', 'Managed ownership changed');
      const update = db.prepare('UPDATE managed_ownership SET version=?,payload=? WHERE id=? AND project_key=? AND version=?')
        .run(next.version, JSON.stringify(next), prior.id, prior.projectId, prior.version);
      if (Number(update.changes) !== 1) throw new BosunError('conflict', 'Managed ownership changed');
      return next;
    });
  }
  fenceOwnership(expected: ManagedOwnership): ManagedOwnership {
    return this.#ownershipChange(expected, prior => { if (prior.phase !== 'active') throw new BosunError('conflict', 'Managed ownership held'); return { ...prior, phase: 'fenced' }; });
  }
  stageOwnership(expected: ManagedOwnership, attemptId: string, artifactHash: string): ManagedOwnership {
    return this.#ownershipChange(expected, prior => {
      if (prior.phase !== 'fenced' || prior.stage) throw new BosunError('conflict', 'Managed ownership held');
      return { ...prior, phase: 'staged', stage: { generation: prior.session.generation + 1, attemptId, artifactHash, destination: null } };
    });
  }
  destinationOwnership(expected: ManagedOwnership, destination: ManagedSession): ManagedOwnership {
    return this.#ownershipChange(expected, prior => {
      if (prior.phase !== 'staged' || !prior.stage || prior.stage.destination) throw new BosunError('conflict', 'Managed ownership held');
      return { ...prior, stage: { ...prior.stage, destination } };
    });
  }
  transferOwnership(expected: ManagedOwnership): ManagedOwnership {
    return this.#ownershipChange(expected, (prior, db) => {
      if (prior.phase !== 'staged' || !prior.stage?.destination || Number(db.prepare('SELECT COUNT(*) AS n FROM managed_retirements').get()!.n) >= 4096) throw new BosunError('conflict', 'Managed ownership held');
      db.prepare('INSERT INTO managed_retirements(owner_id,generation,session_id) VALUES(?,?,?)').run(prior.session.ownerId, prior.session.generation, prior.session.sessionId);
      return { ...prior, phase: 'active', session: prior.stage.destination, seedHash: prior.stage.artifactHash, activationJobId:prior.stage.attemptId, stage: null, retired: { sessionId: prior.session.sessionId, generation: prior.session.generation } };
    });
  }
  holdOwnership(expected: ManagedOwnership): ManagedOwnership {
    return this.#ownershipChange(expected, prior => ({ ...prior, phase: 'held' }));
  }
  recoverOwnership(): number {
    return this.#transaction(db => {
      // A daemon restart cannot reconstruct a native admission fence or prove an
      // effect stopped from stored metadata. Preserve every claim, never replay.
      const rows = db.prepare('SELECT project_key,id FROM managed_ownership LIMIT 65').all(); if (rows.length > 64) throw unavailable();
      let count = 0;
      for (const row of rows) {
        const prior = this.#ownership(db, String(row.project_key), String(row.id)); if (prior.phase === 'held' || prior.phase === 'retired') continue;
        const next = { ...prior, phase: 'held' as const, version: prior.version + 1 };
        db.prepare('UPDATE managed_ownership SET version=?,payload=? WHERE id=?').run(next.version, JSON.stringify(next), prior.id); count++;
      }
      return count;
    });
  }
  #handoffPointer(row: Row): HandoffPointer {
    const value: HandoffPointer = { id: row.id, requestId: row.request_id, projectId: row.project_key, createdAt: row.created_at, manifestHash: row.manifest_hash, markdownHash: row.markdown_hash };
    jobId(value.id); jobId(value.requestId); jobTime(value.createdAt);
    if (typeof value.projectId !== 'string' || !/^p_[a-f0-9]{16}$/.test(value.projectId)
      || !/^[a-f0-9]{64}$/.test(value.manifestHash) || !/^[a-f0-9]{64}$/.test(value.markdownHash)) throw unavailable();
    return value;
  }
  handoffPointer(scope: JobScope, id: string): HandoffPointer {
    return this.#read(db => {
      if (!this.#owner(scope)) throw new BosunError('unsupported', 'Owner operation required');
      const row = db.prepare('SELECT * FROM handoff_artifacts WHERE id=? AND project_key=?').get(jobId(id), this.#scope(scope));
      if (!row) throw new BosunError('not_found', 'Handoff artifact not found'); return this.#handoffPointer(row);
    });
  }
  findHandoffRequest(scope: JobScope, requestId: string): HandoffPointer | null {
    return this.#read(db => {
      if (!this.#owner(scope)) throw new BosunError('unsupported', 'Owner operation required');
      const row = db.prepare('SELECT * FROM handoff_artifacts WHERE request_id=? AND project_key=?').get(jobId(requestId), this.#scope(scope));
      return row ? this.#handoffPointer(row) : null;
    });
  }
  listHandoffPointers(scope: JobScope, limit = 20): HandoffPointer[] {
    return this.#read(db => {
      if (!this.#owner(scope)) throw new BosunError('unsupported', 'Owner operation required');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new BosunError('invalid', 'Invalid handoff limit');
      return db.prepare('SELECT * FROM handoff_artifacts WHERE project_key=? ORDER BY created_at DESC,id DESC LIMIT ?')
        .all(this.#scope(scope), limit).map(row => this.#handoffPointer(row));
    });
  }
  putHandoffPointer(scope: JobScope, value: HandoffPointer): HandoffPointer {
    if (!this.#owner(scope) || this.#scope(scope) !== value.projectId) throw new BosunError('unsupported', 'Owner operation required');
    const accepted = this.#handoffPointer({ id: value.id, request_id: value.requestId, project_key: value.projectId, created_at: value.createdAt, manifest_hash: value.manifestHash, markdown_hash: value.markdownHash });
    return this.#transaction(db => {
      const duplicate = db.prepare('SELECT * FROM handoff_artifacts WHERE request_id=? AND project_key=?').get(accepted.requestId, accepted.projectId);
      if (duplicate) {
        const prior = this.#handoffPointer(duplicate);
        if (JSON.stringify(prior) !== JSON.stringify(accepted)) throw new BosunError('conflict', 'Handoff request exists'); return prior;
      }
      if (Number(db.prepare('SELECT COUNT(*) AS n FROM handoff_artifacts').get()!.n) >= 256) throw unavailable();
      db.prepare('INSERT INTO handoff_artifacts(id,request_id,project_key,created_at,manifest_hash,markdown_hash) VALUES(?,?,?,?,?,?)')
        .run(accepted.id, accepted.requestId, accepted.projectId, accepted.createdAt, accepted.manifestHash, accepted.markdownHash);
      return accepted;
    });
  }
  close(): void {
    const db = this.#db; this.#db = null;
    if (!db) return;
    try { db.close(); } catch { throw unavailable(); }
  }
}
