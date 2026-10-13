// Compatibility admission is separate from protocol/control qualification.
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function sameNativeMajor(actual: string | undefined, baseline: string): boolean {
  if (typeof actual !== 'string') return false;
  const candidate = RELEASE_VERSION.exec(actual);
  const supported = RELEASE_VERSION.exec(baseline);
  return candidate !== null && supported !== null && candidate[0] === actual && supported[0] === baseline && candidate[1] === supported[1];
}
