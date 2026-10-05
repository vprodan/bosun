import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkBoundaries } from '../scripts/check-boundaries.mjs';
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

const cases: { name: string; files: Record<string, string>; expected: RegExp }[] = [
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
  { name: 'ambient random alias', files: { 'src/core/a.ts': 'const random=Math.random;export const value=random();' }, expected: /Core IO\/global.*Math/ },
  { name: 'Math object alias', files: { 'src/core/a.ts': 'const math=Math;export const value=math.random();' }, expected: /Core IO\/global.*Math/ },
  { name: 'computed Math operation', files: { 'src/core/a.ts': "const op='random';export const value=Math[op]();" }, expected: /Core IO\/global.*Math/ },
  { name: 'new source cannot import old lib helper', files: { 'src/app/a.ts': "import '../../lib/util.ts';", 'lib/util.ts': 'export const value=1;' }, expected: /Forbidden app -> legacy/ },
  { name: 'unregistered legacy file', files: { 'lib/new.ts': 'export const value=1;' }, expected: /Unregistered legacy/ },
  { name: 'unrecorded forwarding edge', files: { 'lib/route.ts': "import '../src/core/a.ts';", 'src/core/a.ts': 'export const value=1;' }, expected: /Unregistered compatibility edge/ },
  { name: 'unknown new production zone', files: { 'src/misc/a.ts': 'export const value=1;' }, expected: /Unknown production zone/ },
];
for (const entry of cases) test(`boundary negative fixture: ${entry.name}`, () => {
  const sb = fixture(entry.files);
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
