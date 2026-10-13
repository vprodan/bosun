export const REMOTE_VIEW_SQL =
  "CREATE TABLE remote_view (singleton INTEGER PRIMARY KEY CHECK(singleton=1),state TEXT NOT NULL CHECK(state IN ('held','pending','ready','acquire-unknown','release-unknown')),intent TEXT NOT NULL,snapshot TEXT,cached_at INTEGER,expires_at INTEGER)";
export type RemoteViewBinding = {
  authorityId: string;
  clientId: string;
  clientSourceId: string;
  configRevision: string;
};
export type RemoteViewIntent = RemoteViewBinding & {
  id: string;
  projectId: string;
  sessionId: string | null;
};
