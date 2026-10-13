// Dev-only AST/TypeChecker gate using the existing local TS6 API, never a regex TS parser.
// When TS7 replaces this dependency, retain TS6 as a checker tool or migrate to a supported pinned parser.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const REPO = path.resolve(import.meta.dirname, '..');
// TS6 marks ambient descendants with this internal flag (typescript.js parser).
const AMBIENT_NODE_FLAG = 33554432;
const ZONES = new Set(['core', 'app', 'adapters', 'platform', 'contracts', 'cli']);
const ALLOWED: Record<string, Set<string>> = {
  core: new Set(['core']),
  platform: new Set(['core', 'platform']),
  contracts: new Set(['core', 'contracts']),
  cli: new Set(['core', 'contracts', 'platform', 'cli']),
  adapters: new Set(['core', 'contracts', 'platform', 'adapters']),
  app: new Set(ZONES),
};
const IO_GLOBALS = new Set([
  'process',
  'fetch',
  'console',
  'global',
  'globalThis',
  'Buffer',
  'Bun',
  'Deno',
  'XMLHttpRequest',
  'WebSocket',
  'Worker',
  'localStorage',
  'sessionStorage',
  'navigator',
  'performance',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'clearTimeout',
  'clearInterval',
  'queueMicrotask',
  'Date',
]);
const CODE_LOADERS = new Set(['require', 'createRequire', 'eval', 'Function']);
// These extracted helpers receive storage/time/hash/measurement through explicit composition.
// Keep the exact set narrow: other native adapters legitimately own filesystem/runtime effects.
const ISOLATED_MEMORY = new Set([
  'src/contracts/schema.ts',
  'src/contracts/memory.ts',
  ...[
    'sqlite-store',
    'sqlite-query',
    'sqlite-maintenance',
    'sqlite-session',
    'sqlite-docs',
    'sqlite-docs-index',
  ].map((name) => `src/adapters/memory/${name}.ts`),
]);
const LEGACY_FILES = new Set(['bin/bosun']);
// Exact compatibility edges; no new src imports lib. Remove these with the corresponding legacy caller before ship.
const FORWARDING = new Map<string, string[]>();
// Exact SQLite implementation seams: constants have no IO; the local selector never imports writer code.
const ADAPTER_SEAMS = new Map([
  ['src/adapters/workspaces/orca-watch.ts', ['src/adapters/workspaces/orca-card.ts']],
  ['src/adapters/memory/remote-leases.ts', ['src/adapters/memory/remote-view-file.ts']],
  [
    'src/adapters/memory/remote-view-cache.ts',
    ['src/adapters/memory/remote-view-file.ts', 'src/adapters/memory/remote-view-protocol.ts'],
  ],
  [
    'src/adapters/memory/remote-view-readonly.ts',
    ['src/adapters/memory/remote-view-file.ts', 'src/adapters/memory/remote-view-protocol.ts'],
  ],
  ['src/adapters/routers/ollama-clef-status.ts', ['src/adapters/routers/ollama-clef.ts']],
  [
    'src/adapters/memory/sqlite-cutover.ts',
    ['src/adapters/memory/sqlite-public-protocol.ts', 'src/adapters/memory/sqlite-graph-schema.ts'],
  ],
  ['src/adapters/memory/sqlite-owner.ts', ['src/adapters/memory/sqlite-cutover.ts']],
  [
    'src/adapters/memory/sqlite-public-readonly.ts',
    ['src/adapters/memory/sqlite-public-protocol.ts'],
  ],
  ['src/adapters/memory/sqlite-readonly.ts', ['src/adapters/memory/sqlite-public-readonly.ts']],
  [
    'src/adapters/memory/sqlite-store.ts',
    [
      'src/adapters/memory/sqlite-query.ts',
      'src/adapters/memory/sqlite-maintenance.ts',
      'src/adapters/memory/sqlite-session.ts',
    ],
  ],
  ['src/adapters/memory/sqlite-maintenance.ts', ['src/adapters/memory/sqlite-session.ts']],
  ['src/adapters/memory/sqlite-initialize.ts', ['src/adapters/memory/sqlite-schema.ts']],
  ['src/adapters/memory/sqlite-schema.ts', ['src/adapters/memory/sqlite-graph-schema.ts']],
  ['src/adapters/memory/sqlite-graph.ts', ['src/adapters/memory/sqlite-session.ts']],
  ['src/adapters/memory/sqlite-embedding.ts', ['src/adapters/memory/sqlite-session.ts']],
  ['src/adapters/memory/sqlite-docs.ts', ['src/adapters/memory/sqlite-session.ts']],
  [
    'src/adapters/memory/sqlite-docs-index.ts',
    ['src/adapters/memory/sqlite-docs.ts', 'src/adapters/memory/sqlite-session.ts'],
  ],
  [
    'src/adapters/memory/docs-filesystem.ts',
    ['src/adapters/memory/sqlite-docs.ts', 'src/adapters/memory/sqlite-docs-index.ts'],
  ],
]);
const slash = (p: string): string => p.split(path.sep).join('/');
const inside = (root: string, file: string): boolean => file === root || file.startsWith(root + path.sep);

function enumerate(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Source symlink is not allowed: ${file}`);
    return entry.isDirectory() ? enumerate(file) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : [];
  });
}
function runtimeReference(node: ts.Node): boolean {
  const parent = node.parent;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    ((ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent)) &&
      parent.name === node)
  )
    return false;
  for (let ancestor = node; ancestor; ancestor = ancestor.parent)
    if (ts.isTypeNode(ancestor)) return false;
  return true;
}
function typeOnlyExternal(node: ts.Node): boolean | undefined {
  if (ts.isImportTypeNode(node)) return true;
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    return (
      !!clause &&
      (clause.isTypeOnly ||
        (!clause.name &&
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((entry) => entry.isTypeOnly)))
    );
  }
  return (
    ts.isExportDeclaration(node) &&
    (node.isTypeOnly ||
      (node.exportClause &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every((entry) => entry.isTypeOnly)))
  );
}

export type BoundaryResult = { files: number; edges: number; violations: string[] };
export function checkBoundaries({ root = REPO }: { root?: string } = {}): BoundaryResult {
  root = fs.realpathSync(root);
  const violations: string[] = [];
  const relative = (file: string): string => slash(path.relative(root, file));
  const problem = (file: string, message: string, node?: ts.Node): void => {
    const line = node
      ? node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1
      : 1;
    violations.push(`${relative(file)}:${line}: ${message}`);
  };
  const files = ['lib', 'src', 'test', 'bin'].flatMap((dir) => enumerate(path.join(root, dir)));
  const binary = path.join(root, 'bin/bosun');
  if (fs.existsSync(binary)) files.push(binary);
  const configPath = path.join(root, 'tsconfig.json');
  const config = fs.existsSync(configPath)
    ? ts.readConfigFile(configPath, ts.sys.readFile)
    : { config: {} };
  if (config.error) throw new Error('Cannot parse boundary tsconfig');
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const options = { ...parsed.options, noEmit: true, allowJs: true, checkJs: false };
  const program = ts.createProgram(files, options);
  const checker = program.getTypeChecker();
  const known = new Set(files.map((file) => fs.realpathSync(file)));
  const edges = new Map<string, Set<string>>(files.map((file) => [file, new Set<string>()]));
  const zone = (file: string): string =>
    relative(file) === 'bin/bosun'
      ? 'app'
      : relative(file).startsWith('src/')
        ? relative(file).split('/')[1]
        : 'legacy';

  for (const file of files) {
    if (relative(file).startsWith('test/')) continue; // fixtures are checked as synthetic roots by the guarded tests
    const source =
      program.getSourceFile(file) ??
      ts.createSourceFile(
        file,
        fs.readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
    const fromZone = zone(file);
    const isolatedMemory = ISOLATED_MEMORY.has(relative(file));
    if (fromZone === 'legacy' && !LEGACY_FILES.has(relative(file)))
      problem(file, 'Unregistered legacy production file; put new code in src');
    if (fromZone !== 'legacy' && !ZONES.has(fromZone))
      problem(file, `Unknown production zone ${fromZone}`);
    // The pinned TS6 parser attaches this field; its public SourceFile type omits it.
    const parsedSource = source as ts.SourceFile & { parseDiagnostics: readonly ts.DiagnosticWithLocation[] };
    for (const diagnostic of parsedSource.parseDiagnostics)
      problem(
        file,
        `Invalid syntax: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
      );

    function admittedRequire(node: ts.Node): boolean {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'require'
        || node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) return false;
      const specifier = node.arguments[0].text;
      return relative(file) === 'src/platform/sqlite.ts'
        ? specifier === '../../node_modules/better-sqlite3/build/Release/bosun_sqlite.node'
        : relative(file) === 'src/platform/canonical-path.cjs' && ['node:fs', 'node:path'].includes(specifier);
    }
    function edge(specifier: string | undefined, node: ts.Node): void {
      if (typeof specifier !== 'string') {
        problem(file, 'Computed module loading is forbidden', node);
        return;
      }
      // Bun embeds a native addon only through its literal require boundary.
      // Binary identity is separately bound by the native build/distribution receipts.
      if (admittedRequire(node) && relative(file) === 'src/platform/sqlite.ts') return;
      const cacheOnly =
        relative(file) === 'bin/bosun' &&
        ts.isImportDeclaration(node) &&
        !node.importClause?.name &&
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings) &&
        node.importClause.namedBindings.elements.every(
          (entry) => (entry.propertyName ?? entry.name).text === 'enableCompileCache',
        );
      if ((specifier === 'node:module' || specifier === 'module') && !cacheOnly)
        problem(file, 'Runtime module-loader escape is forbidden', node);
      // ESM everywhere except the exact native asset and pre-guard metadata leaf.
      if (
        specifier.startsWith('node:') ||
        (ts.isExternalModuleNameRelative(specifier) === false && !specifier.startsWith('#'))
      ) {
        // Aliases must resolve before treating a bare name as an external dependency.
        const resolved = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule;
        if (
          resolved &&
          !resolved.isExternalLibraryImport &&
          !inside(root, fs.realpathSync(resolved.resolvedFileName))
        ) {
          problem(file, `Dependency escapes checked production graph: ${specifier}`, node);
          return;
        }
        if (!resolved || resolved.isExternalLibraryImport) {
          if (fromZone === 'core') problem(file, `Core external dependency ${specifier}`, node);
          else if (isolatedMemory)
            problem(file, `Isolated memory external dependency ${specifier}`, node);
          else if (!specifier.startsWith('node:') && !resolved)
            problem(file, `Unresolved dependency ${specifier}`, node);
          return;
        }
      }
      const resolved = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule;
      if (!resolved) {
        problem(file, `Unresolved dependency ${specifier}`, node);
        return;
      }
      const target = fs.realpathSync(resolved.resolvedFileName);
      if (!inside(root, target) || !known.has(target)) {
        problem(file, `Dependency escapes checked production graph: ${specifier}`, node);
        return;
      }
      if (relative(target).startsWith('test/')) problem(file, 'Production imports test code', node);
      const toZone = zone(target);
      const nativeType = relative(target) === 'src/platform/sqlite.ts' && typeOnlyExternal(node);
      if (isolatedMemory && toZone === 'platform' && !nativeType)
        problem(file, `Isolated memory platform dependency (${relative(target)})`, node);
      if (
        isolatedMemory &&
        toZone !== 'core' &&
        !ISOLATED_MEMORY.has(relative(target)) &&
        !typeOnlyExternal(node)
      ) {
        problem(file, `Isolated memory unreviewed dependency (${relative(target)})`, node);
      }
      if (
        fromZone === 'legacy' &&
        toZone !== 'legacy' &&
        !FORWARDING.get(relative(file))?.includes(relative(target))
      ) {
        problem(file, `Unregistered compatibility edge (${relative(target)})`, node);
      }
      if (fromZone !== 'legacy' && !ALLOWED[fromZone]?.has(toZone))
        problem(file, `Forbidden ${fromZone} -> ${toZone} dependency (${relative(target)})`, node);
      if (
        fromZone === 'adapters' &&
        toZone === 'adapters' &&
        relative(file).split('/').slice(2, 4).join('/') !==
          relative(target).split('/').slice(2, 4).join('/') &&
        !ADAPTER_SEAMS.get(relative(file))?.includes(relative(target))
      ) {
        problem(file, `Cross-adapter dependency (${relative(target)})`, node);
      }
      if (!nativeType) edges.get(file)?.add(target);
    }
    function visit(node: ts.Node): void {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        edge(
          ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined,
          node,
        );
      }
      if (ts.isImportTypeNode(node)) {
        const argument = node.argument;
        edge(
          ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)
            ? argument.literal.text
            : undefined,
          node,
        );
      }
      if (ts.isImportEqualsDeclaration(node)) {
        const reference = node.moduleReference;
        edge(
          ts.isExternalModuleReference(reference) &&
            reference.expression &&
            ts.isStringLiteral(reference.expression)
            ? reference.expression.text
            : undefined,
          node,
        );
        if (fromZone !== 'legacy') problem(file, 'New production code must use ESM imports', node);
      }
      if (
        (ts.isPropertyAccessExpression(node) && CODE_LOADERS.has(node.name.text)) ||
        (ts.isElementAccessExpression(node) &&
          node.argumentExpression &&
          ts.isStringLiteral(node.argumentExpression) &&
          CODE_LOADERS.has(node.argumentExpression.text))
      ) {
        problem(file, 'Indirect runtime module/code loading is forbidden', node);
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const argument = node.arguments[0];
        edge(
          argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
            ? argument.text
            : undefined,
          node,
        );
        if (fromZone !== 'legacy' && node.expression.kind !== ts.SyntaxKind.ImportKeyword && !admittedRequire(node))
          problem(file, 'New production code must use ESM imports, not require', node);
      }
      if (ts.isIdentifier(node) && runtimeReference(node)) {
        if (CODE_LOADERS.has(node.text)) {
          const directRequire =
            node.text === 'require' &&
            ts.isCallExpression(node.parent) &&
            node.parent.expression === node;
          if (!directRequire)
            problem(file, `Indirect/dynamic code loading is forbidden: ${node.text}`, node);
        }
        if (
          (fromZone === 'core' || isolatedMemory) &&
          (IO_GLOBALS.has(node.text) || node.text === 'Math')
        ) {
          const symbol = checker.getSymbolAtLocation(node);
          const local = symbol?.declarations?.some(
            (declaration) =>
              inside(
                fromZone === 'core' ? path.join(root, 'src/core') : path.dirname(file),
                declaration.getSourceFile().fileName,
              ) && !(declaration.flags & AMBIENT_NODE_FLAG),
          );
          const parent = node.parent;
          const deterministicMath =
            node.text === 'Math' &&
            ((ts.isPropertyAccessExpression(parent) &&
              parent.expression === node &&
              parent.name.text !== 'random') ||
              (ts.isElementAccessExpression(parent) &&
                parent.expression === node &&
                parent.argumentExpression &&
                ts.isStringLiteral(parent.argumentExpression) &&
                parent.argumentExpression.text !== 'random'));
          if (!local && !deterministicMath)
            problem(
              file,
              `${isolatedMemory ? 'Isolated memory' : 'Core'} IO/global access is forbidden: ${node.text}`,
              node,
            );
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  function dfs(file: string, stack: string[]): void {
    if (visiting.has(file)) {
      problem(file, `Import cycle: ${[...stack, file].map(relative).join(' -> ')}`);
      return;
    }
    if (done.has(file)) return;
    visiting.add(file);
    for (const target of edges.get(file) ?? []) dfs(target, [...stack, file]);
    visiting.delete(file);
    done.add(file);
  }
  for (const file of edges.keys()) dfs(file, []);
  return {
    files: files.filter((file) => !relative(file).startsWith('test/')).length,
    edges: [...edges.values()].reduce((sum, targets) => sum + targets.size, 0),
    violations,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = checkBoundaries();
  for (const violation of result.violations) console.error(violation);
  console.log(
    `Boundaries: ${result.files} production files, ${result.edges} resolved edges, ${result.violations.length} violations.`,
  );
  process.exitCode = result.violations.length ? 1 : 0;
}
