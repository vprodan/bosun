import './bootstrap.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runtimePaths } from '../src/platform/paths.ts';
import { defaultConfig } from '../src/core/domain/config.ts';
import { publishHookConfig } from '../src/app/config.ts';
import type { Sandbox } from './helpers.ts';
import type { CutoverPaths } from '../src/adapters/memory/sqlite-cutover.ts';

// Explicit fixture projection for an already initialized registered floor.
// It installs no host, starts no daemon and adopts no arbitrary owner layout.
export function publishFixtureHook(sb: Sandbox, storage: CutoverPaths, sourceId: string | null) {
  const paths = runtimePaths(sb.env());
  assert.equal(paths.memory, storage.primary);
  assert.equal(paths.view, storage.view);
  assert.equal(paths.backups, storage.backups);
  fs.mkdirSync(paths.run, { recursive: true, mode: 0o700 });
  return publishHookConfig(defaultConfig(), paths, { sourceId, now: Date.now() });
}
