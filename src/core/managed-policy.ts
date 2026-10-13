import type { HostAdapter, ManagedCapability, ManagedSessionControl } from './ports/host.ts';
import { BosunError } from './errors.ts';
import { requireCapability } from './policy.ts';

const METHODS: Record<Exclude<ManagedCapability, 'seedWithoutInference' | 'isolatedBootstrapTurn'>, keyof ManagedSessionControl> = {
  contextTelemetry: 'observeContext', promptAdmission: 'fenceAdmission', toolQuiescence: 'quiesce',
  freshSession: 'startFresh', freshReadiness: 'ready',
};
export function bootstrapUsesInference(control: ManagedSessionControl): boolean {
  return control.caps.seedWithoutInference !== 'verified'
    && control.caps.isolatedBootstrapTurn !== undefined;
}
// Omitted/unverified capabilities never imply automatic support. This is selection policy, not qualification.
export function requireManagedControl(host: Pick<HostAdapter, 'control'>): ManagedSessionControl {
  const control = host.control;
  if (!control) throw new BosunError('unsupported', 'Managed session controls unavailable');
  for (const [capability, method] of Object.entries(METHODS)) {
    requireCapability(control.caps?.[capability as ManagedCapability], capability);
    if (typeof control[method] !== 'function') throw new BosunError('unsupported', `Managed session control unavailable: ${method}`);
  }
  // The accepted handoff design permits either inference-free insertion or a
  // qualified isolated readiness turn. Neither relaxes any other native gate.
  if (control.caps?.seedWithoutInference !== 'verified')
    requireCapability(control.caps?.isolatedBootstrapTurn ?? control.caps?.seedWithoutInference, 'isolated bootstrap');
  if (typeof control.seed !== 'function')
    throw new BosunError('unsupported', 'Managed session control unavailable: seed');
  return control;
}
