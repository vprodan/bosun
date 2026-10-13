import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Env } from '../../core/domain/inference.ts';
import { BosunError } from '../../core/errors.ts';
import { requirePublicInput } from '../../core/policy.ts';
import { screenPublicText } from '../../core/secret-screen.ts';
import {
  REVIEW_LIMITS,
  reviewPath,
  reviewPaths,
  reviewSnapshot,
  type ReviewFile,
  type ReviewSnapshot,
} from '../../core/domain/review.ts';
import { createOfflineGit, gitDirectory } from '../../platform/git.ts';
import { project } from '../../platform/project.ts';

const hash = (bytes: string | Uint8Array) =>
  crypto.createHash('sha256').update(bytes).digest('hex');
const unavailable = () => new BosunError('unavailable', 'Review checkout unavailable');
const oid = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
export function createGitReviewSource(options: { env: Env; command?: string }) {
  const git = createOfflineGit(options);
  async function success(root: string, args: string[], signal: AbortSignal) {
    const result = await git.run(root, args, signal);
    if (result.code !== 0) throw unavailable();
    return result;
  }
  async function identity(from: string, signal: AbortSignal) {
    gitDirectory(from);
    const result = await success(
      from,
      ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
      signal,
    );
    const dirs = result.text.trimEnd().split('\n');
    if (dirs.length !== 2) throw unavailable();
    const root = gitDirectory(dirs[0]),
      repository = gitDirectory(dirs[1]);
    return { root, repository, projectId: project(root).id };
  }
  async function metadata(from: string, base: string, signal: AbortSignal) {
    gitDirectory(from);
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/.test(base) ||
      base.includes('..') ||
      base.includes('//')
    )
      throw new BosunError('invalid', 'Invalid review base');
    const identity = await success(
      from,
      ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
      signal,
    );
    const dirs = identity.text.trimEnd().split('\n');
    if (dirs.length !== 2) throw unavailable();
    const root = gitDirectory(dirs[0]),
      repository = gitDirectory(dirs[1]);
    const head = (
      await success(root, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], signal)
    ).text.trim();
    const baseCommit = (
      await success(root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], signal)
    ).text.trim();
    if (!oid(head) || !oid(baseCommit)) throw unavailable();
    const branch = (await success(root, ['rev-parse', '--abbrev-ref', 'HEAD'], signal)).text.trim();
    screenPublicText(branch);
    await git.plainCheckout(root, signal);
    const index = await success(root, ['ls-files', '--stage', '-z'], signal);
    const untracked = await success(
      root,
      ['ls-files', '--others', '--exclude-standard', '-z'],
      signal,
    );
    const status = await success(
      root,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'],
      signal,
    );
    return {
      root,
      repository,
      branch,
      head,
      base: baseCommit,
      projectId: project(root).id,
      index,
      untracked,
      status,
    };
  }
  function inventory(meta: Awaited<ReturnType<typeof metadata>>) {
    const records = new Map<
      string,
      { tracked: boolean; index: string | null; indexMode: string | null }
    >();
    if (
      (meta.index.text && !meta.index.text.endsWith('\0')) ||
      (meta.untracked.text && !meta.untracked.text.endsWith('\0'))
    )
      throw unavailable();
    for (const row of meta.index.text.split('\0').filter(Boolean)) {
      const match = row.match(/^(100644|100755|120000) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t(.+)$/);
      if (!match)
        throw new BosunError(
          'unsupported',
          'Unmerged or submodule review requires explicit manual handling',
        );
      const name = reviewPath(match[3]);
      if (records.has(name)) throw unavailable();
      records.set(name, { tracked: true, index: match[2], indexMode: match[1] });
    }
    for (const name of meta.untracked.text.split('\0').filter(Boolean)) {
      reviewPath(name);
      if (records.has(name)) throw unavailable();
      records.set(name, { tracked: false, index: null, indexMode: null });
    }
    if (records.size > REVIEW_LIMITS.files) throw unavailable();
    return [...records.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }
  function files(
    meta: Awaited<ReturnType<typeof metadata>>,
    signal: AbortSignal,
    selected: readonly string[] | null = null,
    keepBodies = false,
  ) {
    let total = 0;
    const bodies = new Map<string, string>();
    const values = inventory(meta).map(([name, index]): ReviewFile => {
      if (signal.aborted) throw new BosunError('cancelled', 'Review capture cancelled');
      const target = path.join(meta.root, name);
      if (!target.startsWith(meta.root + path.sep)) throw unavailable();
      let parent = path.dirname(target);
      while (!fs.existsSync(parent) && parent !== meta.root) parent = path.dirname(parent);
      if (fs.realpathSync(parent) !== parent) throw unavailable();
      let stat: fs.BigIntStats;
      try {
        stat = fs.lstatSync(target, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && index.tracked)
          return { path: name, ...index, kind: 'missing', sha256: null, bytes: 0, mode: 0 };
        throw unavailable();
      }
      const mode = Number(stat.mode & 0o7777n);
      if (stat.isSymbolicLink()) {
        const link = fs.readlinkSync(target);
        screenPublicText(link);
        const after = fs.lstatSync(target, { bigint: true });
        if (
          stat.dev !== after.dev ||
          stat.ino !== after.ino ||
          stat.ctimeNs !== after.ctimeNs ||
          stat.mtimeNs !== after.mtimeNs
        )
          throw unavailable();
        if (
          path.isAbsolute(link) ||
          !path.resolve(path.dirname(target), link).startsWith(meta.root + path.sep)
        )
          throw new BosunError('private_input', 'External review symlink withheld');
        return {
          path: name,
          ...index,
          kind: 'symlink',
          sha256: hash(link),
          bytes: Buffer.byteLength(link),
          mode,
        };
      }
      if (
        !stat.isFile() ||
        stat.size > BigInt(REVIEW_LIMITS.fileBytes) ||
        total + Number(stat.size) > REVIEW_LIMITS.sourceBytes
      )
        throw unavailable();
      const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const before = fs.fstatSync(fd, { bigint: true });
        if (
          before.dev !== stat.dev ||
          before.ino !== stat.ino ||
          before.size !== stat.size ||
          before.mode !== stat.mode ||
          before.ctimeNs !== stat.ctimeNs ||
          before.mtimeNs !== stat.mtimeNs
        )
          throw unavailable();
        const buffer = Buffer.alloc(Number(stat.size) + 1);
        let bytes = 0;
        while (bytes < buffer.length) {
          const n = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
          if (!n) break;
          bytes += n;
        }
        const after = fs.fstatSync(fd, { bigint: true });
        if (
          bytes !== Number(stat.size) ||
          before.size !== after.size ||
          before.mode !== after.mode ||
          before.ctimeNs !== after.ctimeNs ||
          before.mtimeNs !== after.mtimeNs ||
          before.dev !== after.dev ||
          before.ino !== after.ino
        )
          throw unavailable();
        total += bytes;
        const raw = buffer.subarray(0, bytes);
        const text = raw.toString('utf8');
        screenPublicText(text);
        if (!index.tracked && keepBodies && (selected === null || selected.includes(name)))
          bodies.set(name, text);
        return { path: name, ...index, kind: 'file', sha256: hash(raw), bytes, mode };
      } finally {
        fs.closeSync(fd);
      }
    });
    return { values, bodies };
  }
  function snapshot(
    meta: Awaited<ReturnType<typeof metadata>>,
    values: readonly ReviewFile[],
  ): ReviewSnapshot {
    const selected = {
      schema: 1 as const,
      projectId: meta.projectId,
      root: meta.root,
      repository: meta.repository,
      branch: meta.branch,
      base: meta.base,
      head: meta.head,
      indexHash: hash(meta.index.bytes),
      statusHash: hash(meta.status.bytes),
      contentHash: hash(JSON.stringify(values)),
      files: values,
    };
    return reviewSnapshot({ ...selected, revision: hash(JSON.stringify(selected)) });
  }
  return {
    identity,
    async capture(
      input: { privacy: 'public'; base?: string; paths?: readonly string[] | null },
      from: string,
      signal: AbortSignal,
      includeDiff = true,
    ) {
      requirePublicInput(input);
      const descriptor = Object.getOwnPropertyDescriptor(input, 'base');
      if (descriptor && !Object.hasOwn(descriptor, 'value'))
        throw new BosunError('invalid', 'Invalid review base');
      const base = descriptor?.value ?? 'main';
      if (typeof base !== 'string') throw new BosunError('invalid', 'Invalid review base');
      const pathDescriptor = Object.getOwnPropertyDescriptor(input, 'paths');
      if (pathDescriptor && !Object.hasOwn(pathDescriptor, 'value'))
        throw new BosunError('invalid', 'Invalid review batch');
      const selected = reviewPaths(pathDescriptor?.value);
      const before = await metadata(from, base, signal);
      const captured = files(before, signal, selected, includeDiff);
      let diff = '';
      if (includeDiff) {
        const flags = [
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          '--no-color',
          '--full-index',
        ];
        for (const [label, args] of [
          ['COMMITTED', ['diff', ...flags, `${before.base}..${before.head}`, '--']],
          ['STAGED', ['diff', ...flags, '--cached', before.head, '--']],
          ['WORKING', ['diff', ...flags, '--']],
        ] as const) {
          await git.plainCheckout(before.root, signal);
          const text = (
            await success(
              before.root,
              [...args, ...(selected?.map((name) => `:(literal)${name}`) ?? [])],
              signal,
            )
          ).text;
          screenPublicText(text);
          if (text) diff += `\n${label}:\n${text}`;
        }
        for (const [name, body] of captured.bodies)
          diff += `\nUNTRACKED ${JSON.stringify(name)}:\n${body}\n`;
        if (Buffer.byteLength(diff) > REVIEW_LIMITS.promptBytes)
          throw new BosunError(
            'unavailable',
            'Review change exceeds the input budget; batch related changes',
          );
      }
      const after = await metadata(from, base, signal);
      const final = files(after, signal);
      const original = snapshot(before, captured.values),
        current = snapshot(after, final.values);
      if (original.revision !== current.revision)
        throw new BosunError('conflict', 'Review checkout changed during capture');
      return { snapshot: original, diff };
    },
  };
}
