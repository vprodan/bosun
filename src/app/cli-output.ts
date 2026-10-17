import type { RpcError } from '../contracts/rpc.ts';

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
// Terminal output must not execute controls from stored notes, model names or native metadata.
const line = (value: unknown): string => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'))
  : typeof value === 'number' && Number.isFinite(value) ? String(value) : 'unknown';
const block = (value: string): string => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
  character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
const routingHints: Record<string, string> = {
  model_unloaded: 'The selected model is installed but not in memory. An explicit bosun route request may load it (up to two minutes).',
  endpoint_unavailable: 'Start your selected Ollama endpoint. Optional local tool setup is available through bosun onboard.',
  model_missing: 'The selected model is not installed. Use bosun onboard for the separately approved optional model pull.',
  version_unverified: 'The endpoint version is not admitted. Inspect bosun router status --json; do not bypass compatibility checks.',
  unsupported_version: 'The selected endpoint version is unsupported; inspect the reported required version.',
  unsupported_model: 'The selected model format, runner or capability is not supported. Inspect bosun router status --json.',
  loaded_identity_mismatch: 'Loaded model identity differs from the selected weights/runner. No model substitution or routing was authorized.',
  digest_mismatch: 'The selected model digest differs from its configured pin. Review that selection before inference.',
  digest_changed: 'Model identity changed during the request. The decision was discarded, not retried.',
  timeout: 'No advice was delivered before the deadline. Inspect bosun router status and ollama ps; a dropped request does not prove native inference stopped.',
};
function jobSummary(value: Record<string, unknown>): string | null {
  const job = object(value.job) ?? value;
  if (typeof job.id !== 'string' || typeof job.state !== 'string') return null;
  const rows = [`Job ${line(job.id)}: ${line(job.state)}`, `Runner: ${line(job.runnerId)} · receipt version: ${line(job.version)}`];
  if (job.reason) rows.push(`Reason: ${line(job.reason)}`);
  if (job.requestId) rows.push(`Original request: ${line(job.requestId)}`);
  if (job.state === 'unknown') rows.push('Outcome unconfirmed. Inspect this original job; do not resubmit it or replay its effects.');
  else if (['queued', 'held', 'running'].includes(job.state)) rows.push(`Observe: bosun job wait ${line(job.id)} --result`);
  else rows.push(`Result: bosun job result ${line(job.id)}`);
  if (value.watch) rows.push('An owned job observer was requested. Use --json to inspect its acknowledgement and recovery state.');
  return rows.join('\n') + '\n';
}

/** Only everyday reports gain summaries; artifact/protocol/diagnostic payloads stay unchanged. */
export function renderCliResult(kind: string, value: unknown): string | null {
  if (kind === 'roles' && Array.isArray(value)) {
    return value.map(item => {
      const role = object(item); if (!role) return '';
      const bindings = object(role.bindings) ?? {};
      const choices = Object.entries(bindings).map(([host, binding]) => {
        const selected = object(binding);
        return `  ${line(host)}: ${line(selected?.model)}${selected?.effort ? ` · effort ${line(selected.effort)}` : ''}`;
      });
      return `${line(role.id)} (${line(role.access)}) — ${line(role.description)}\n${choices.length ? choices.join('\n') : '  No configured model binding; use onboarding or select --model explicitly.'}`;
    }).join('\n\n') + '\n';
  }
  const result = object(value); if (!result) return null;
  if (kind === 'daemon.status') {
    const remote = object(result.remote);
    return `Bosun ${line(result.version)}: ${line(result.state)}\nPrimary host: ${line(result.primaryHost)} · PID: ${line(result.pid)}\n${remote ? `Authority: ${line(remote.mode)} · ${line(remote.outcome)}\n` : ''}Memory: bosun memory search "your topic"\nJobs: bosun job list\n`;
  }
  if (kind === 'doctor' && Array.isArray(result.checks)) {
    const checks = result.checks.map(item => {
      const check = object(item); return check ? `  ${line(check.state)}  ${line(check.id)} — ${line(check.detail)}` : '';
    });
    return `${result.prepared === true ? 'Runtime is prepared.' : 'Runtime preparation needs review.'}\n${checks.join('\n')}\nFilesystem metadata only; no database was opened and no native service was probed.\n${result.prepared === true ? 'Check the running daemon with bosun status.' : 'Next: bosun onboard (existing data is never reset to bypass a hold).'}\n`;
  }
  if (kind === 'route.status') {
    const loaded = object(result.loaded); const qualification = object(result.qualification);
    const reason = typeof result.reason === 'string' ? result.reason : null;
    return `Router: ${line(result.state)}${reason ? ` (${line(reason)})` : ''}\nModel: ${line(result.model)} · provider: ${line(result.provider)}\nLoaded: ${line(loaded?.state)} · runner: ${line(result.runner)} · endpoint version: ${line(result.version)}\n${reason && routingHints[reason] ? routingHints[reason] + '\n' : ''}Calibration: ${line(qualification?.calibration)}; automatic dispatch is disabled.\nDetails: bosun router status --json\n`;
  }
  if (kind === 'route.classify') {
    const route = object(result.route); const decision = object(route?.decision);
    const reason = typeof result.reason === 'string' ? result.reason : null;
    const rows = route ? [`Routing advice: ${line(route.final)} — ${line(route.why)}`, `Model: ${line(decision?.router)} · risk: ${line(decision?.risk)}`]
      : [`No routing advice${reason ? ` (${line(reason)})` : ''}.`];
    if (reason && routingHints[reason]) rows.push(routingHints[reason]);
    if (reason === 'timeout') rows.push('Returned status may be the pre-decision snapshot, not current model residency.');
    rows.push('Advice only: no task was executed or worker dispatched. Calibration remains unverified.');
    const observation = object(result.observation);
    if (observation) rows.push(`Observation: ${line(observation.id)} · ${line(observation.state)}`);
    return rows.join('\n') + '\n';
  }
  if (kind === 'memory.search' && Array.isArray(result.hits)) {
    if (!result.hits.length) return 'No matching memory in this scope. Add a note with bosun memory add --help.\n';
    return result.hits.map(item => {
      const hit = object(item); return hit ? `${line(hit.id)}  ${line(hit.category)}  ${line(hit.title)}${hit.private === true ? ' (private)' : ''} · ${line(hit.status)}` : '';
    }).join('\n') + '\nRead a note: bosun memory get ID\n';
  }
  if (['memory.store', 'memory.get'].includes(kind)) {
    const memory = object(result.memory); if (!memory) return null;
    const privacy = memory.private === true ? 'private' : memory.private === false ? 'public' : 'privacy unknown';
    const rows = [`Memory ${line(memory.id)} · ${line(memory.category)} · ${privacy} · ${memory.shared === false ? 'unshared' : memory.shared === true ? 'shared' : 'sharing unknown'} · version ${line(memory.version)}`,
      `${line(memory.title)} · ${line(memory.status)}${memory.status === 'proposed' ? ' (proposal; not accepted)' : ''}`];
    if (result.duplicate === true) rows.push('Existing original record; no duplicate was created.');
    if (kind === 'memory.get' && typeof memory.body === 'string') rows.push('', block(memory.body));
    else rows.push(`Read: bosun memory get ${line(memory.id)}`);
    if (memory.events) return null;
    return rows.join('\n') + '\n';
  }
  if (kind === 'context.retrieve' && typeof result.text === 'string') {
    if (result.candidates !== undefined) return null;
    return result.text ? block(result.text) + '\n' : 'No eligible context in this scope. Use bosun memory search to inspect available notes.\n';
  }
  if (kind === 'job.list' && Array.isArray(result.jobs)) {
    if (!result.jobs.length) return 'No jobs in this project. Queue a public task with bosun run --help.\n';
    return result.jobs.map(item => {
      const job = object(item); return job ? `${line(job.id)}  ${line(job.state)}  ${line(job.runnerId)}${job.reason ? `  ${line(job.reason)}` : ''}` : '';
    }).join('\n') + '\nInspect: bosun job get ID\n';
  }
  if (kind === 'job.get' || kind === 'job.submit' || kind === 'spin.submit' ||
      ['workspace.', 'review.', 'check.'].some(prefix => kind.startsWith(prefix)) && object(result.job))
    return jobSummary(result);
  return null;
}

export function renderCliError(error: RpcError, context: { command: string; requestId?: string; hint?: string }): string {
  const rows = [`${error.message} (${error.code}).`];
  if (error.details?.outcome === 'unknown') {
    rows.push('Outcome unconfirmed. Do not repeat the operation or submit it with a fresh request ID. Inspect its original job/installation receipt.');
    if (context.requestId && /^[A-Za-z0-9_-]{1,100}$/.test(context.requestId)) rows.push(`Original request: ${context.requestId}`);
  } else if (context.hint) rows.push(context.hint);
  else if (error.code === 'unavailable') rows.push('The daemon or requested capability is unavailable. Inspect bosun status and bosun doctor; bosun onboard guides preparation. Start only a reviewed owned service with bosun start, or keep bosun daemon run open in another terminal.');
  else if (error.code === 'private_input') rows.push('Only explicitly public content may be sent to inference. Keep private text out of these commands; route --private omits it.');
  else if (error.code === 'conflict') rows.push('State changed or the reviewed version/hash is stale. Inspect the original receipt and review its current version; do not replay an uncertain effect.');
  else if (error.code === 'unverified' || error.code === 'unsupported') rows.push('This capability or native identity is not qualified for the requested operation. Inspect bosun onboard and the relevant status before changing anything.');
  else if (error.code === 'invalid') rows.push(`Check operands and options with bosun ${line(context.command)} --help.`);
  if (error.details?.currentVersion !== undefined) rows.push(`Current receipt version: ${line(error.details.currentVersion)}`);
  return rows.join('\n') + '\n';
}
