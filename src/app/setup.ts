import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { RuntimeConfig } from '../core/domain/config.ts';
import { BosunError } from '../core/errors.ts';
import type { RuntimePaths } from '../platform/paths.ts';
import { renderRuntimeConfig, saveRuntimeConfig } from '../platform/config.ts';
import { privateDirectory } from '../platform/private-file.ts';
import { DaemonOwner } from '../platform/daemon-owner.ts';
import { writeRuntimeManifest, type RuntimeManifest } from '../platform/manifest.ts';
import { initializeMemory } from '../adapters/memory/sqlite-initialize.ts';
import { MEMORY_SCHEMA_VERSION } from '../adapters/memory/sqlite-schema.ts';
import { cutoverMemory, publishMemoryView } from '../adapters/memory/sqlite-cutover.ts';
import { publishHookConfig } from './config.ts';

// Explicit new installation only. The supported legacy upgrade is a separate
// administrative entry; normal daemon/client reads never initialize storage.
export async function setupRuntime(paths: RuntimePaths, config: RuntimeConfig): Promise<RuntimeManifest> {
  renderRuntimeConfig(config); // Validate before filesystem effects.
  let exists = true;
  try { fs.lstatSync(paths.home); } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw new BosunError('unavailable', 'Runtime home unavailable'); exists = false; }
  if (exists) { privateDirectory(paths.home); if (fs.readdirSync(paths.home).length) throw new BosunError('conflict', 'Runtime home already contains data; inspect setup or the supported upgrade'); }
  else { if (fs.realpathSync(path.dirname(paths.home)) !== path.dirname(paths.home)) throw new BosunError('unavailable', 'Runtime parent unavailable'); fs.mkdirSync(paths.home, { mode: 0o700 }); }
  privateDirectory(paths.home);
  for (const directory of [paths.run, path.dirname(paths.view), paths.backups, paths.artifacts]) fs.mkdirSync(directory, { mode: 0o700 });
  const owner = new DaemonOwner(paths.owner);
  let failed = false;
  try {
    const manifest: RuntimeManifest = { schemaVersion: 1, state: 'preparing', installationId: crypto.randomUUID(), sourceId: crypto.randomUUID(), createdAt: Date.now(), memorySchema: MEMORY_SCHEMA_VERSION };
    writeRuntimeManifest(paths, manifest); saveRuntimeConfig(paths, config);
    initializeMemory({ file: paths.memory, assertOwner: () => owner.assert(), now: Date.now });
    const memoryPaths = { primary: paths.memory, view: paths.view, backups: paths.backups };
    let generated = 0;
    await cutoverMemory({ paths: memoryPaths, now: Date.now, id: () => ++generated === 2 ? manifest.sourceId : crypto.randomUUID(),
      expectation: { operation: 'apply', sourceId: manifest.sourceId, validate: () => owner.assert() }, checkpoint() { owner.assert(); } });
    await publishMemoryView({ paths: memoryPaths, now() { owner.assert(); return Date.now(); }, id: crypto.randomUUID, checkpoint() { owner.assert(); } });
    publishHookConfig(config, paths, { sourceId: manifest.sourceId, now: Date.now() });
    const ready = { ...manifest, state: 'ready' as const }; writeRuntimeManifest(paths, ready); return ready;
  } catch (error) { failed = true; throw error; }
  finally { try { owner.close(); } catch { if (!failed) throw new BosunError('unavailable', 'Setup cleanup unavailable', { details: { outcome: 'unknown' } }); } }
}
