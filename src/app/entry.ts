import fs from 'node:fs';

// Shared source/compiled entry. Select the lean hook before CLI/schema/SDK imports.
// Ink's optional debugger is a development-only peer. Its node:process import
// shares this environment; disable it before any compiled product module loads.
if (process.versions.bun) process.env.DEV = "false";
const argv = process.argv.slice(2);
let code: number | undefined;
let stdout: fs.WriteStream | undefined, stderr: fs.WriteStream | undefined;
let stopped = false;
const terminate = () => {
  if (stopped) return;
  stopped = true;
  // A failed or timed-out native write is not cancelled by graceful VM exit.
  // Stop this exact producer; if denied, leave it for its caller to join/kill.
  const keepAlive = setInterval(() => {}, 1000);
  keepAlive.ref();
  try { process.kill(process.pid, 'SIGKILL'); } catch {}
};
const output = (fd: number) => {
  const stream = fs.createWriteStream('', { fd, autoClose: false, fs: { write: fs.write } });
  stream.on('error', terminate);
  return stream;
};
if (argv[0] === "hook" || (argv[0] === "route" && argv.includes("--hook"))) {
  if (argv.includes("--private")) code = 0;
  else {
    const { main } = await import("./hook.ts");
    code = await main();
  }
} else {
  const { main } = await import("./cli.ts");
  stdout = output(process.stdout.fd);
  stderr = output(process.stderr.fd);
  code = await main(argv, {
    stdout(text) { stdout!.write(text); },
    stderr(text) { stderr!.write(text); },
  });
}
// The hook already awaits its leased fd delivery; never enqueue a second write.
// A stdio server stays alive until input closes. Ordinary CLI streams finish
// only on native fd callbacks, with a finite producer deadline and no retries.
if (argv[0] !== "mcp") {
  const flushed = (stream: fs.WriteStream | undefined) => {
    if (!stream) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(terminate, 1000);
      stream.once('finish', () => { clearTimeout(timer); resolve(); });
      stream.end();
    });
  };
  await Promise.all([flushed(stdout), flushed(stderr)]);
  process.exit(code ?? 0);
} else process.exitCode = code ?? 0;

export {};
