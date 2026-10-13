import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkBoundaries } from '../scripts/check-boundaries.mts';
import { sandbox, REPO } from './helpers.ts';

function fixture(files: Record<string, string>, config: object = {}) {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.root, 'package.json'), JSON.stringify({ type: 'module', imports: { '#io': './src/platform/io.ts' } }));
  fs.writeFileSync(path.join(sb.root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', baseUrl: '.', paths: { '@io': ['src/platform/io.ts'] }, ...config } }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(sb.root, name)), { recursive: true });
    fs.writeFileSync(path.join(sb.root, name), text);
  }
  return sb;
}

test('production boundary graph passes including the recorded legacy forwarding seams', () => {
  const result = checkBoundaries({ root: REPO });
  assert.deepEqual(result.violations, []);
  assert.ok(result.files >= 48);
  assert.ok(result.edges > 100);
});

const cases: { name: string; files: Record<string, string>; expected: RegExp; config?: object }[] = [
  { name: 'final memory composition cannot reach legacy config', files: { 'src/app/memory.ts': "import '../../lib/config.ts';", 'lib/config.ts': 'export const value=1;' }, expected: /Forbidden app -> legacy/ },
  { name: 'curated source policy cannot reach native writer', files: { 'src/core/memory-source.ts': "import '../adapters/memory/sqlite-store.ts';", 'src/adapters/memory/sqlite-store.ts': 'export const value=1;' }, expected: /Forbidden core -> adapters/ },
  { name: 'normal registered reader cannot import new initialization', files: { 'src/adapters/memory/sqlite-readonly.ts': "import './sqlite-initialize.ts';", 'src/adapters/memory/sqlite-initialize.ts': 'export const value=1;' }, expected: /Cross-adapter/ },
  { name: 'jobs core cannot use an ambient clock', files: { 'src/core/use-cases/jobs.ts': 'export const value=Date.now();' }, expected: /Core IO\/global.*Date/ },
  { name: 'jobs core cannot import durable IO', files: { 'src/core/use-cases/jobs.ts': "import '../../adapters/jobs/sqlite-jobs.ts';", 'src/adapters/jobs/sqlite-jobs.ts': 'export const value=1;' }, expected: /Forbidden core -> adapters/ },
  { name: 'jobs storage cannot reuse memory cutover machinery', files: { 'src/adapters/jobs/sqlite-jobs.ts': "import '../memory/sqlite-cutover.ts';", 'src/adapters/memory/sqlite-cutover.ts': 'export const value=1;' }, expected: /Cross-adapter/ },
  { name: 'final jobs composition cannot import legacy rendezvous', files: { 'src/app/jobs.ts': "import '../../lib/exec.ts';", 'lib/exec.ts': 'export const value=1;' }, expected: /Forbidden app -> legacy/ },
  { name: 'type-only static IO import', files: { 'src/core/a.ts': "import type { Stats } from 'node:fs';" }, expected: /Core external/ },
  { name: 'reexport relative bypass', files: { 'src/core/a.ts': "export { value } from '../platform/io.ts';", 'src/platform/io.ts': 'export const value=1;' }, expected: /Forbidden core -> platform/ },
  { name: 'literal dynamic import', files: { 'src/core/a.ts': "void import('../platform/io.ts');", 'src/platform/io.ts': 'export const value=1;' }, expected: /Forbidden core -> platform/ },
  { name: 'import type query', files: { 'src/core/a.ts': "export type A=import('../platform/io.ts').A;", 'src/platform/io.ts': 'export type A=string;' }, expected: /Forbidden core -> platform/ },
  { name: 'tsconfig alias bypass', files: { 'src/core/a.ts': "import {value} from '@io';", 'src/platform/io.ts': 'export const value=1;' }, expected: /Forbidden core -> platform/ },
  { name: 'package imports alias bypass', files: { 'src/core/a.ts': "import {value} from '#io';", 'src/platform/io.ts': 'export const value=1;' }, expected: /Forbidden core -> platform/ },
  { name: 'unresolved alias', files: { 'src/app/a.ts': "import '@unknown';" }, expected: /Unresolved dependency/ },
  { name: 'computed dynamic import', files: { 'src/app/a.ts': "const file='./a.ts';void import(file);" }, expected: /Computed module loading/ },
  { name: 'computed require', files: { 'lib/route.ts': "const file='./a.ts';require(file);" }, expected: /Computed module loading/ },
  { name: 'require alias', files: { 'src/app/a.ts': "const loader=require;loader('node:fs');" }, expected: /Indirect\/dynamic/ },
  { name: 'module loader escape', files: { 'src/app/a.ts': "import {createRequire as loader} from 'node:module';loader(import.meta.url);" }, expected: /module-loader escape/ },
  { name: 'property require escape', files: { 'src/app/a.ts': "module.require('node:fs');" }, expected: /Indirect runtime/ },
  { name: 'element require escape', files: { 'src/app/a.ts': "module['require']('node:fs');" }, expected: /Indirect runtime/ },
  { name: 'import equals escape', files: { 'src/core/a.ts': "import fs=require('node:fs');" }, expected: /Core external/ },
  { name: 'new graph cycle', files: { 'src/core/a.ts': "export * from './b.ts';", 'src/core/b.ts': "export * from './a.ts';" }, expected: /Import cycle/ },
  { name: 'old graph cycle', files: { 'lib/route.ts': "import './config.ts';", 'lib/config.ts': "import './route.ts';" }, expected: /Import cycle/ },
  { name: 'production test dependency', files: { 'src/app/a.ts': "import '../../test/fixture.ts';", 'test/fixture.ts': 'export const value=1;' }, expected: /Production imports test/ },
  { name: 'cross adapter flat files', files: { 'src/adapters/routers/a.ts': "import './b.ts';", 'src/adapters/routers/b.ts': 'export const value=1;' }, expected: /Cross-adapter/ },
  { name: 'cross adapter nested directories', files: { 'src/adapters/hosts/a/index.ts': "import '../b/index.ts';", 'src/adapters/hosts/b/index.ts': 'export const value=1;' }, expected: /Cross-adapter/ },
  { name: 'cross adapter kinds', files: { 'src/adapters/hosts/a.ts': "import '../runners/b.ts';", 'src/adapters/runners/b.ts': 'export const value=1;' }, expected: /Cross-adapter/ },
  { name: 'core process global', files: { 'src/core/a.ts': 'export const value=process.env.HOME;' }, expected: /Core IO\/global.*process/ },
  { name: 'core fetch global', files: { 'src/core/a.ts': "void fetch('http://example.invalid');" }, expected: /Core IO\/global.*fetch/ },
  { name: 'core global alias', files: { 'src/core/a.ts': 'const globals=globalThis;const loader=globals.fetch;' }, expected: /Core IO\/global.*globalThis/ },
  { name: 'ambient clock alias', files: { 'src/core/a.ts': 'const now=Date.now;export const value=now();' }, expected: /Core IO\/global.*Date/ },
  { name: 'actual context use case cannot reach native hashing', files: { 'src/core/use-cases/retrieve-context.ts': "import {contentHash} from '../../platform/content-hash.ts';", 'src/platform/content-hash.ts': "export const contentHash=()=> 'hash';" }, expected: /Forbidden core -> platform/ },
  { name: 'actual context use case cannot use ambient timing', files: { 'src/core/use-cases/retrieve-context.ts': 'export const elapsed=performance.now();' }, expected: /Core IO\/global.*performance/ },
  { name: 'context forwarding cannot restore its obsolete text helper edge', files: { 'lib/context.ts': "import {terms} from '../src/core/text.ts';", 'src/core/text.ts': "export const terms=()=>[];" }, expected: /Unregistered compatibility edge/ },
  { name: 'ambient random alias', files: { 'src/core/a.ts': 'const random=Math.random;export const value=random();' }, expected: /Core IO\/global.*Math/ },
  { name: 'Math object alias', files: { 'src/core/a.ts': 'const math=Math;export const value=math.random();' }, expected: /Core IO\/global.*Math/ },
  { name: 'computed Math operation', files: { 'src/core/a.ts': "const op='random';export const value=Math[op]();" }, expected: /Core IO\/global.*Math/ },
  { name: 'new source cannot import old lib helper', files: { 'src/app/a.ts': "import '../../lib/util.ts';", 'lib/util.ts': 'export const value=1;' }, expected: /Forbidden app -> legacy/ },
  { name: 'unregistered legacy file', files: { 'lib/new.ts': 'export const value=1;' }, expected: /Unregistered legacy/ },
  { name: 'unrecorded forwarding edge', files: { 'lib/route.ts': "import '../src/core/a.ts';", 'src/core/a.ts': 'export const value=1;' }, expected: /Unregistered compatibility edge/ },
  { name: 'memory adapter cannot reach legacy config', files: { 'src/adapters/memory/sqlite-store.ts': "import '../../../lib/config.ts';", 'lib/config.ts': 'export const value=1;' }, expected: /Forbidden adapters -> legacy/ },
  { name: 'memory adapter cannot read ambient config', files: { 'src/adapters/memory/sqlite-store.ts': 'export const value=process.env.HOME;' }, expected: /Isolated memory IO\/global.*process/ },
  { name: 'memory query cannot use an ambient clock', files: { 'src/adapters/memory/sqlite-query.ts': 'export const value=Date.now();' }, expected: /Isolated memory IO\/global.*Date/ },
  { name: 'memory adapter cannot use an ambient timing source', files: { 'src/adapters/memory/sqlite-store.ts': 'export const value=performance.now();' }, expected: /Isolated memory IO\/global.*performance/ },
  { name: 'memory adapter cannot create a runtime native connection', files: { 'src/adapters/memory/sqlite-store.ts': "import {DatabaseSync} from 'node:sqlite';" }, expected: /Isolated memory external dependency/ },
  { name: 'memory adapter cannot alias a runtime native connection', files: { 'src/adapters/memory/sqlite-store.ts': "import {DatabaseSync as Native} from 'node:sqlite';" }, expected: /Isolated memory external dependency/ },
  { name: 'memory adapter cannot reach a platform clock through a package alias', files: { 'src/adapters/memory/sqlite-store.ts': "import {now} from '#io';", 'src/platform/io.ts': 'export const now=()=>Date.now();' }, expected: /Isolated memory platform dependency/ },
  { name: 'memory adapter cannot reach a platform sink through a tsconfig alias', files: { 'src/adapters/memory/sqlite-store.ts': "import {record} from '@io';", 'src/platform/io.ts': 'export const record=console.log;' }, expected: /Isolated memory platform dependency/ },
  { name: 'memory adapter cannot use an ambient measurement sink', files: { 'src/adapters/memory/sqlite-store.ts': 'export const value=globalThis.console.log;' }, expected: /Isolated memory IO\/global.*globalThis/ },
  { name: 'validation cannot load runtime filesystem', files: { 'src/contracts/schema.ts': "import fs from 'node:fs';" }, expected: /Isolated memory external dependency/ },
  { name: 'memory isolation cannot reach ambient state through an unreviewed contract helper', files: { 'src/adapters/memory/sqlite-store.ts': "import {now} from '../../contracts/ambient.ts'; export const value=now();", 'src/contracts/ambient.ts': 'export const now=()=>Date.now();' }, expected: /Isolated memory unreviewed dependency/ },
  { name: 'validation isolation cannot reexport an ambient helper', files: { 'src/contracts/schema.ts': "export {value} from './ambient.ts';", 'src/contracts/ambient.ts': 'export const value=process.env.HOME;' }, expected: /Isolated memory unreviewed dependency/ },
  { name: 'memory isolation cannot alias an unreviewed contract sink', files: { 'src/adapters/memory/sqlite-store.ts': "import {record} from '@ambient';", 'src/contracts/ambient.ts': 'export const record=console.log;' }, config: { paths: { '@ambient': ['src/contracts/ambient.ts'] } }, expected: /Isolated memory unreviewed dependency/ },
  { name: 'pure validation cannot reach storage', files: { 'src/contracts/memory.ts': "import '../adapters/memory/sqlite-store.ts';", 'src/adapters/memory/sqlite-store.ts': 'export const value=1;' }, expected: /Forbidden contracts -> adapters/ },
  { name: 'memory query cannot import maintenance', files: { 'src/adapters/memory/sqlite-query.ts': "import './sqlite-maintenance.ts';", 'src/adapters/memory/sqlite-maintenance.ts': 'export const value=1;' }, expected: /Cross-adapter/ },
  { name: 'docs snapshot query cannot import its index use case', files: { 'src/adapters/memory/sqlite-docs.ts': "import './sqlite-docs-index.ts';", 'src/adapters/memory/sqlite-docs-index.ts': 'export const value=1;' }, expected: /Cross-adapter/ },
  { name: 'docs snapshot query cannot reach filesystem helper', files: { 'src/adapters/memory/sqlite-docs.ts': "import './docs-filesystem.ts';", 'src/adapters/memory/docs-filesystem.ts': 'export const value=1;' }, expected: /Isolated memory unreviewed dependency|Cross-adapter/ },
  { name: 'docs index cannot import effectful source helper', files: { 'src/adapters/memory/sqlite-docs-index.ts': "import './docs-filesystem.ts';", 'src/adapters/memory/docs-filesystem.ts': 'export const value=1;' }, expected: /Isolated memory unreviewed dependency|Cross-adapter/ },
  { name: 'docs query cannot use ambient config', files: { 'src/adapters/memory/sqlite-docs.ts': 'export const root=process.cwd();' }, expected: /Isolated memory IO\/global.*process/ },
  { name: 'docs index cannot use runtime filesystem', files: { 'src/adapters/memory/sqlite-docs-index.ts': "import fs from 'node:fs';" }, expected: /Isolated memory external dependency/ },
  { name: 'docs index cannot use ambient timing', files: { 'src/adapters/memory/sqlite-docs-index.ts': 'export const started=performance.now();' }, expected: /Isolated memory IO\/global.*performance/ },
  { name: 'docs query cannot alias a platform source', files: { 'src/adapters/memory/sqlite-docs.ts': "import {value} from '@io';", 'src/platform/io.ts': 'export const value=process.cwd();' }, expected: /Isolated memory platform dependency/ },
  { name: 'docs query cannot reach unreviewed contract metrics', files: { 'src/adapters/memory/sqlite-docs.ts': "export {value} from '../../contracts/metrics.ts';", 'src/contracts/metrics.ts': 'export const value=console.log;' }, expected: /Isolated memory unreviewed dependency/ },
  { name: 'docs filesystem helper cannot reach legacy state', files: { 'src/adapters/memory/docs-filesystem.ts': "import '../../../lib/config.ts';", 'lib/config.ts': 'export const value=1;' }, expected: /Forbidden adapters -> legacy/ },
  { name: 'docs compatibility forwarder cannot reach unrelated native writer', files: { 'lib/memory/docs.ts': "import '../../src/adapters/memory/sqlite-cutover.ts';", 'src/adapters/memory/sqlite-cutover.ts': 'export const value=1;' }, expected: /Unregistered compatibility edge/ },
  { name: 'local hook reader cannot import writable store', files: { 'src/adapters/memory/sqlite-readonly.ts': "import './sqlite-store.ts';", 'src/adapters/memory/sqlite-store.ts': 'export const value=1;' }, expected: /Cross-adapter/ },
  { name: 'service forwarding does not allow unrelated memory internals', files: { 'lib/memory/service.ts': "import '../../src/adapters/memory/sqlite-session.ts';", 'src/adapters/memory/sqlite-session.ts': 'export const value=1;' }, expected: /Unregistered compatibility edge/ },
  { name: 'unknown new production zone', files: { 'src/misc/a.ts': 'export const value=1;' }, expected: /Unknown production zone/ },
];
for (const entry of cases) test(`boundary negative fixture: ${entry.name}`, () => {
  const sb = fixture(entry.files, entry.config);
  try { assert.match(checkBoundaries({ root: sb.root }).violations.join('\n'), entry.expected); }
  finally { sb.cleanup(); }
});

test('AST parsing ignores fake imports in comments/text and permits local symbols and same-adapter internals', () => {
  const sb = fixture({
    'src/core/a.ts': "// import 'node:fs'\nconst text=\"import('node:fs')\";const fetch=()=>1;export const value=Math.max(fetch(),Math['min'](1,2));",
    'src/adapters/hosts/a/index.ts': "import './render.ts';",
    'src/adapters/hosts/a/render.ts': 'export const value=1;',
  });
  try { assert.deepEqual(checkBoundaries({ root: sb.root }).violations, []); }
  finally { sb.cleanup(); }
});

test('isolated memory allows named type-only SQLite, injected clock/sink properties and pure builtins', () => {
  const sb = fixture({
    'src/adapters/memory/sqlite-query.ts': "import type {SqliteDatabase as Native} from '../../platform/sqlite.ts'; export function query(deps:{now():number;measure(n:number):void},db:Native) { const process=1; deps.measure(Math.max(process,deps.now())); return db.prepare('SELECT 1').get(); }",
    'src/platform/sqlite.ts': "export interface SqliteDatabase { prepare(sql:string): {get():unknown}; }",
    'src/contracts/schema.ts': "const performance=()=>1; export const value=Number.isFinite(performance());",
  });
  try { assert.deepEqual(checkBoundaries({ root: sb.root }).violations, []); }
  finally { sb.cleanup(); }
});

test('boundary resolution cannot escape the checked graph through a symlink', () => {
  const sb = fixture({ 'src/core/a.ts': "import './escape.ts';" });
  try {
    const target = path.join(sb.root, 'outside.ts'); fs.writeFileSync(target, 'export const value=1;');
    fs.symlinkSync(target, path.join(sb.root, 'src/core/escape.ts'));
    assert.throws(() => checkBoundaries({ root: sb.root }), /Source symlink/);
  } finally { sb.cleanup(); }
});

test('app path aliases cannot escape the checked graph as apparent external dependencies', () => {
  const sb = fixture({ 'src/app/a.ts': "import {value} from '@outside';" }, { paths: { '@outside': ['../outside.ts'] } });
  const outside = path.join(sb.root, '../outside.ts');
  try {
    fs.writeFileSync(outside, 'export const value=1;');
    assert.match(checkBoundaries({ root: sb.root }).violations.join('\n'), /escapes checked production graph/);
  } finally { fs.rmSync(outside, { force: true }); sb.cleanup(); }
});
