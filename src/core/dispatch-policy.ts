import { BosunError } from './errors.ts';
import { screenPublicText } from './secret-screen.ts';

export const OPERATIONS = [
  'inspect',
  'mechanical',
  'implementation',
  'planning',
  'auth',
  'payments',
  'delete',
  'migration',
  'production',
  'unknown',
] as const;
export type DispatchPolicy = Readonly<{
  operation: (typeof OPERATIONS)[number];
  files: readonly string[];
  noDelegation?: boolean;
  exactModel?: string;
}>;
function field(input: unknown, key: string, optional = false): unknown {
  const descriptor =
    input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, key) : undefined;
  if (!descriptor) {
    if (optional) return undefined;
    throw new BosunError('invalid', 'Invalid dispatch policy');
  }
  if (!Object.hasOwn(descriptor, 'value'))
    throw new BosunError('invalid', 'Invalid dispatch policy');
  return descriptor.value;
}
export function dispatchPolicy(input: unknown): DispatchPolicy {
  const operation = field(input, 'operation'),
    files = field(input, 'files'),
    noDelegation = field(input, 'noDelegation', true),
    exactModel = field(input, 'exactModel', true);
  if (
    typeof operation !== 'string' ||
    !OPERATIONS.includes(operation as DispatchPolicy['operation']) ||
    !Array.isArray(files) ||
    files.length > 64 ||
    (noDelegation !== undefined && typeof noDelegation !== 'boolean') ||
    (exactModel !== undefined &&
      (typeof exactModel !== 'string' || !exactModel || exactModel.length > 200))
  )
    throw new BosunError('invalid', 'Invalid dispatch policy');
  const selected: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = field(files, String(i));
    if (
      typeof file !== 'string' ||
      !file ||
      file.length > 512 ||
      /[\x00-\x1f\x7f\\]/.test(file) ||
      file.startsWith('/') ||
      file.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new BosunError('invalid', 'Invalid task file');
    screenPublicText(file);
    selected.push(file);
  }
  if (typeof exactModel === 'string') screenPublicText(exactModel);
  return Object.freeze({
    operation: operation as DispatchPolicy['operation'],
    files: Object.freeze([...new Set(selected)].sort()),
    ...(noDelegation === undefined ? {} : { noDelegation }),
    ...(exactModel === undefined ? {} : { exactModel: exactModel as string }),
  });
}
export function assessDispatch(input: {
  access: 'read' | 'edit';
  model: string;
  submittedBy: 'owner' | 'model';
  policy?: DispatchPolicy;
}): Readonly<{
  allowed: boolean;
  risk: 'low' | 'high' | 'unknown';
  reason: 'allowed' | 'main_planning_required' | 'no_delegation' | 'exact_model' | 'scope_unknown';
}> {
  const policy = input.policy ? dispatchPolicy(input.policy) : undefined;
  if (policy?.noDelegation) return { allowed: false, risk: 'unknown', reason: 'no_delegation' };
  if (policy?.exactModel !== undefined && policy.exactModel !== input.model)
    return { allowed: false, risk: 'unknown', reason: 'exact_model' };
  const protectedFile =
    policy?.files.some((file) =>
      /(^|\/)(?:auth(?:entication|orization)?|payments?|billing|secrets?|migrations?|prod(?:uction)?|terraform|k8s|kubernetes|deploy)(?:\/|\.|$)|\.tf$|(^|\/)\.env(?:\.|$)/i.test(
        file,
      ),
    ) ?? false;
  const high =
    (policy &&
      ['auth', 'payments', 'delete', 'migration', 'production'].includes(policy.operation)) ||
    protectedFile;
  if (high)
    return {
      allowed: input.access === 'read',
      risk: 'high',
      reason: input.access === 'read' ? 'allowed' : 'main_planning_required',
    };
  if (input.access === 'read')
    return {
      allowed: true,
      risk: !policy || policy.operation === 'unknown' ? 'unknown' : 'low',
      reason: 'allowed',
    };
  const known =
    policy &&
    ['mechanical', 'implementation'].includes(policy.operation) &&
    policy.files.length > 0;
  if (!known) {
    const allowed = input.submittedBy === 'owner' && policy === undefined;
    return { allowed, risk: 'unknown', reason: allowed ? 'allowed' : 'scope_unknown' };
  }
  return { allowed: true, risk: 'low', reason: 'allowed' };
}
