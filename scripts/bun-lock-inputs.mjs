// Read the authoritative text lock without an install, resolver or registry request.
export function parseBunLock(bytes) {
  const source = bytes.toString('utf8');
  // Bun's text lock is JSON with trailing commas. Preserve quoted bytes exactly.
  let json = '';
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      json += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; json += char; }
    else if (char !== ',' || !/^\s*[}\]]/.test(source.slice(i + 1))) json += char;
  }
  const lock = JSON.parse(json);
  if (lock.lockfileVersion !== 1 || lock.configVersion !== 1 || !lock.workspaces?.[''] || !lock.packages)
    throw new Error('Unsupported authoritative Bun lock');
  return lock;
}
export function productionPackages(lock, dependencies) {
  const selected = new Set();
  function visit(name, optional = false) {
    if (selected.has(name)) return;
    const tuple = lock.packages[name];
    if (!tuple) {
      if (optional) return;
      throw new Error(`Production dependency absent from authoritative Bun lock: ${name}`);
    }
    if (!Array.isArray(tuple) || tuple.length !== 4 || typeof tuple[0] !== 'string' || typeof tuple[1] !== 'string' || tuple[1] !== '' || !tuple[2] || typeof tuple[2] !== 'object' || !/^sha512-[a-zA-Z0-9+/]+=*$/.test(tuple[3]))
      throw new Error(`Invalid registry package in Bun lock: ${name}`);
    if (!tuple[0].startsWith(`${name}@`) || !tuple[0].slice(name.length + 1))
      throw new Error(`Unsupported nested/aliased Bun lock package: ${name}`);
    selected.add(name);
    const metadata = tuple[2];
    for (const child of Object.keys(metadata.dependencies ?? {})) visit(child);
    for (const child of Object.keys(metadata.optionalDependencies ?? {})) visit(child, true);
    for (const child of Object.keys(metadata.peerDependencies ?? {}))
      visit(child, metadata.optionalPeers?.includes(child) ?? false);
  }
  for (const name of Object.keys(dependencies ?? {})) visit(name);
  return [...selected].sort().map((name) => ({ name, version: lock.packages[name][0].slice(name.length + 1) }));
}
