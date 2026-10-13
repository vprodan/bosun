import { z } from 'zod';
import { BosunError } from '../../core/errors.ts';
import { requirePublicInput } from '../../core/policy.ts';
import { screenPublicText } from '../../core/secret-screen.ts';
import type { GenRequest, GenResult, ModelProvider, Msg } from '../../core/ports/model.ts';
import { httpJson, protocolBase } from '../../platform/http-json.ts';

export type OllamaModelSettings = {
  url: string; model: string; contextTokens: number; maxOutputTokens: number; timeoutMs: number; loopbackOnly?: boolean;
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown, max: number): value is string => typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value) <= max;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const unavailable = () => new BosunError('unavailable', 'Model generation unavailable', { details: { outcome: 'unknown' } });
function limit(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new BosunError('invalid', 'Invalid model limits'); return value;
}
function modelName(value: unknown): string {
  if (!string(value, 256) || !value || /\s/.test(value)) throw new BosunError('invalid', 'Invalid model selection'); return value;
}
function schema(value: unknown): { definition: Record<string, unknown>; validator: z.ZodType } {
  try {
    const text = JSON.stringify(value); if (!text || Buffer.byteLength(text) > 16384) throw Error();
    const parsed: unknown = JSON.parse(text); if (!object(parsed)) throw Error();
    return { definition: parsed, validator: z.fromJSONSchema(parsed as z.core.JSONSchema.JSONSchema) };
  } catch { throw new BosunError('invalid', 'Invalid model output schema'); }
}

// One explicit API call, no tools, own loop, download, fallback, prompt logs or
// credential import. Public classification applies even to local inference.
// Loopback is not evidence of loaded-model residency or active context size.
export function createOllamaModelProvider(settings: OllamaModelSettings): ModelProvider {
  return { id: 'ollama', caps: { structured: 'verified', local: 'unverified', numCtx: 'verified', toolFree: 'verified' },
    async health(signal) {
      try {
        const base = protocolBase(settings.url, settings.loopbackOnly ?? false); const model = modelName(settings.model);
        const value = await httpJson(`${base}/api/tags`, { method: 'GET', signal }, 3000, 1048576);
        return object(value) && Array.isArray(value.models) && value.models.length <= 4096
          && value.models.some(row => object(row) && (row.name === model || row.model === model));
      } catch { return false; }
    },
    async generate(request: GenRequest): Promise<GenResult> {
      requirePublicInput(request); // before messages, schema, model/config getters or URL/HTTP
      let messages: Msg[]; let format: ReturnType<typeof schema> | undefined; let model: string; let base: string;
      let context: number; let output: number; let timeout: number;
      try {
        model = modelName(request.model ?? settings.model); base = protocolBase(settings.url, settings.loopbackOnly ?? false);
        context = limit(settings.contextTokens, 1048576); output = limit(settings.maxOutputTokens, 16384); timeout = limit(settings.timeoutMs, 300000);
        if (output >= context || !string(request.task, 200) || !request.task || !Array.isArray(request.messages)
          || !request.messages.length || request.messages.length > 32) throw new BosunError('invalid', 'Invalid generation request');
        let bytes = 0;
        messages = request.messages.map(row => {
          if (!object(row) || !['system', 'user', 'assistant'].includes(String(row.role)) || !string(row.content, 32768)) throw new BosunError('invalid', 'Invalid generation messages');
          bytes += Buffer.byteLength(row.content); if (bytes > 32768) throw new BosunError('invalid', 'Generation input too large');
          screenPublicText(row.content);
          return { role: row.role as Msg['role'], content: row.content };
        });
        if (request.schema !== undefined) format = schema(request.schema);
        // Byte-fallback tokenization is a conservative body bound. Reserve role/
        // template overhead; the configured wire limit is not effective-window proof.
        if (bytes + (format ? Buffer.byteLength(JSON.stringify(format.definition)) : 0) + output + 1024 > context) throw new BosunError('invalid', 'Generation exceeds configured context budget');
        if (request.signal.aborted) throw new BosunError('cancelled', 'Generation cancelled');
      } catch (error) {
        if (error instanceof BosunError) throw error; throw new BosunError('invalid', 'Invalid generation request');
      }
      try {
        const value = await httpJson(`${base}/api/chat`, { method: 'POST', signal: request.signal, headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, messages, stream: false, think: false, ...(format ? { format: format.definition } : {}),
            options: { num_ctx: context, num_predict: output, temperature: 0 } }) }, timeout, 1048576);
        if (!object(value) || value.model !== model || value.done !== true || value.done_reason !== 'stop' || !object(value.message)
          || value.message.role !== 'assistant' || !string(value.message.content, 65536)
          || value.message.tool_calls != null && (!Array.isArray(value.message.tool_calls) || value.message.tool_calls.length)
          || value.prompt_eval_count !== undefined && !integer(value.prompt_eval_count) || value.eval_count !== undefined && !integer(value.eval_count)) throw unavailable();
        let json: unknown;
        if (format) {
          try { json = JSON.parse(value.message.content); } catch { throw unavailable(); }
          const parsed = format.validator.safeParse(json); if (!parsed.success) throw unavailable(); json = parsed.data;
        }
        return { text: value.message.content, model, ...(format ? { json } : {}),
          ...(value.prompt_eval_count === undefined ? {} : { tokensIn: value.prompt_eval_count as number }),
          ...(value.eval_count === undefined ? {} : { tokensOut: value.eval_count as number }) };
      } catch (error) {
        if (error instanceof BosunError && (error.code === 'cancelled' || error.code === 'timeout')) {
          throw new BosunError(error.code, error.code === 'timeout' ? 'Model generation timed out' : 'Model generation cancelled', { details: { outcome: 'unknown' } });
        }
        throw unavailable();
      }
    },
  };
}
