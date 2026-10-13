import { z } from 'zod';
import { BosunError } from '../../core/errors.ts';
import { requirePublicInput } from '../../core/policy.ts';
import { screenPublicText } from '../../core/secret-screen.ts';
import type { Env } from '../../core/domain/inference.ts';
import type { GenRequest, ModelProvider, Msg } from '../../core/ports/model.ts';
import { httpJson } from '../../platform/http-json.ts';

export type CompatibleModelSettings = { url: string; model: string; timeoutMs: number; maxOutputTokens: number; apiKeyEnv?: string; env: Env };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value) <= max;
const tokens = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const unavailable = () => new BosunError('unavailable', 'Model generation unavailable', { details: { outcome: 'unknown' } });
function selectedModel(value: unknown): string {
  if (!text(value, 256) || !value || /\s/.test(value)) throw new BosunError('invalid', 'Invalid model selection'); return value;
}
function endpoint(settings: CompatibleModelSettings) {
  try {
    const url = new URL(settings.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || !['/', '/v1', '/v1/'].includes(url.pathname)) throw Error();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (settings.apiKeyEnv !== undefined) {
      if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(settings.apiKeyEnv)) throw Error();
      const key = settings.env[settings.apiKeyEnv];
      if (!key || key.length > 8192 || /[\s\0]/.test(key)) throw new BosunError('unavailable', 'Configured model credential unavailable');
      if (url.protocol !== 'https:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw Error();
      headers.authorization = `Bearer ${key}`;
    }
    return { base: url.origin + '/v1', headers };
  } catch (error) {
    if (error instanceof BosunError) throw error;
    throw new BosunError('invalid', 'Invalid model endpoint configuration');
  }
}

// Explicit Chat Completions wire contract: no function/network tools, loop,
// stored completion, retries, credential discovery or model substitution.
export function createCompatibleModelProvider(settings: CompatibleModelSettings): ModelProvider {
  return { id: 'openai-compatible', caps: { structured: 'verified', local: 'unverified', numCtx: 'unsupported', toolFree: 'verified' },
    async health(signal) {
      try {
        const { base, headers } = endpoint(settings); const model = selectedModel(settings.model);
        const reply = await httpJson(`${base}/models`, { method: 'GET', headers, signal }, 3000, 1048576);
        return object(reply) && Array.isArray(reply.data) && reply.data.length <= 4096 && reply.data.some(row => object(row) && row.id === model);
      } catch { return false; }
    },
    async generate(request: GenRequest) {
      requirePublicInput(request); // before content, configuration and credential access
      let model: string; let messages: Msg[]; let connection: ReturnType<typeof endpoint>;
      let format: { schema: Record<string, unknown>; validator: z.ZodType } | undefined;
      try {
        model = selectedModel(request.model ?? settings.model);
        if (!text(request.task, 200) || !request.task || !Array.isArray(request.messages) || !request.messages.length || request.messages.length > 32
          || !Number.isSafeInteger(settings.timeoutMs) || settings.timeoutMs < 1 || settings.timeoutMs > 300000
          || !Number.isSafeInteger(settings.maxOutputTokens) || settings.maxOutputTokens < 1 || settings.maxOutputTokens > 16384) throw Error();
        let bytes = 0;
        messages = request.messages.map(row => {
          if (!object(row) || !['system', 'user', 'assistant'].includes(String(row.role)) || !text(row.content, 32768)) throw Error();
          bytes += Buffer.byteLength(row.content); if (bytes > 32768) throw Error(); screenPublicText(row.content);
          return { role: row.role as Msg['role'], content: row.content };
        });
        if (request.schema !== undefined) {
          const encoded = JSON.stringify(request.schema); if (!encoded || Buffer.byteLength(encoded) > 16384) throw Error();
          const schema: unknown = JSON.parse(encoded); if (!object(schema)) throw Error();
          format = { schema, validator: z.fromJSONSchema(schema as z.core.JSONSchema.JSONSchema) };
        }
        if (request.signal.aborted) throw new BosunError('cancelled', 'Generation cancelled');
        connection = endpoint(settings);
      } catch (error) { if (error instanceof BosunError) throw error; throw new BosunError('invalid', 'Invalid generation request'); }
      try {
        const reply = await httpJson(`${connection.base}/chat/completions`, { method: 'POST', signal: request.signal, headers: connection.headers,
          body: JSON.stringify({ model, messages, stream: false, store: false, n: 1, tool_choice: 'none', max_completion_tokens: settings.maxOutputTokens,
            ...(format ? { response_format: { type: 'json_schema', json_schema: { name: 'bosun_output', strict: true, schema: format.schema } } } : {}) }) }, settings.timeoutMs, 1048576);
        if (!object(reply) || reply.object !== 'chat.completion' || reply.model !== model || !Array.isArray(reply.choices) || reply.choices.length !== 1) throw unavailable();
        const choice = reply.choices[0]; if (!object(choice) || choice.index !== 0 || choice.finish_reason !== 'stop' || !object(choice.message)) throw unavailable();
        const message = choice.message;
        if (message.role !== 'assistant' || !text(message.content, 65536) || message.refusal != null || message.function_call != null
          || message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length !== 0)) throw unavailable();
        const usage = reply.usage;
        if (usage !== undefined && (!object(usage) || !tokens(usage.prompt_tokens) || !tokens(usage.completion_tokens))) throw unavailable();
        let json: unknown;
        if (format) { try { const parsed = format.validator.safeParse(JSON.parse(message.content)); if (!parsed.success) throw Error(); json = parsed.data; } catch { throw unavailable(); } }
        return { text: message.content, model, ...(format ? { json } : {}), ...(object(usage) ? { tokensIn: usage.prompt_tokens as number, tokensOut: usage.completion_tokens as number } : {}) };
      } catch (error) {
        if (error instanceof BosunError && ['timeout', 'cancelled'].includes(error.code)) throw new BosunError(error.code,
          error.code === 'timeout' ? 'Model generation timed out' : 'Model generation cancelled', { details: { outcome: 'unknown' } });
        throw unavailable();
      }
    },
  };
}
