import type { HostAdapter, ManagedCapability, ManagedSessionControl } from './ports/host.ts';
import { BosunError } from './errors.ts';
import { requireCapability } from './policy.ts';

const METHODS: Record<ManagedCapability, keyof ManagedSessionControl> = {
  contextTelemetry: 'observeContext', promptAdmission: 'fenceAdmission', toolQuiescence: 'quiesce',
  freshSession: 'startFresh', seedWithoutInference: 'seed', freshReadiness: 'ready',
};
// Omitted/unverified capabilities never imply automatic support. This is selection policy, not qualification.
export function requireManagedControl(host: Pick<HostAdapter, 'control'>): ManagedSessionControl {
  const control = host.control;
  if (!control) throw new BosunError('unsupported', 'Managed session controls unavailable');
  for (const [capability, method] of Object.entries(METHODS)) {
    requireCapability(control.caps?.[capability as ManagedCapability], capability);
    if (typeof control[method] !== 'function') throw new BosunError('unsupported', `Managed session control unavailable: ${method}`);
  }
  return control;
}
