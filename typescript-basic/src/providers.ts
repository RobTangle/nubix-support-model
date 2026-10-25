import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import {
  APIConnectionError as XAIConnectionError,
  APIError as XAIError,
  isMessage,
  SpaceXAI,
  TimeoutError as XAITimeoutError,
} from '@xai-official/sdk';
import type { ProviderSettings } from './config.js';
import { AppError } from './errors.js';
import type {
  CompletionRequest,
  CompletionResult,
  LLMProvider,
  TokenUsage,
} from './provider-types.js';

type ProviderOptions = { fetch?: typeof globalThis.fetch };
const googleBlockedCodes = new Set([
  'safety',
  'jailbreak',
  'prohibited_content',
  'blocklist',
  'recitation',
  'language',
  'spii',
  'image_safety',
  'image_prohibited_content',
  'image_recitation',
  'image_other',
  'content_blocked',
]);

/** Traduce fallos de transporte a nuestro contrato sin conservar texto ni cause del SDK. */
function providerError(error: unknown, signal: AbortSignal, usage: TokenUsage | null): AppError {
  if (error instanceof AppError) return error;
  if (signal.aborted)
    return new AppError(
      signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
        ? 'timeout'
        : 'cancelled',
      { usage },
    );
  if (error instanceof OpenAI.APIConnectionTimeoutError || error instanceof XAITimeoutError)
    return new AppError('timeout', { usage });
  if (error instanceof OpenAI.APIError || XAIError.is(error)) {
    if (error.status === 401) return new AppError('authentication', { usage });
    if (error.status === 403) return new AppError('permission', { usage });
    if (error.status === 429) return new AppError('rate_limit', { usage });
    if (error.status === 408) return new AppError('timeout', { usage });
    if (error.status !== undefined && error.status >= 500)
      return new AppError('provider_unavailable', { usage });
    if (error.status !== undefined && error.status >= 400)
      return new AppError('invalid_request', { usage });
  }
  if (error instanceof OpenAI.APIConnectionError || error instanceof XAIConnectionError)
    return new AppError('provider_unavailable', { usage });
  return new AppError('provider_error', { usage });
}

/** Interactions usa sus propios errores HTTP; no comparte las clases de generateContent. */
function googleProviderError(
  error: unknown,
  signal: AbortSignal,
  usage: TokenUsage | null,
): AppError {
  if (signal.aborted || error instanceof AppError) return providerError(error, signal, usage);
  if (!(error instanceof Error)) return new AppError('provider_error', { usage });
  const payload = 'error' in error ? error.error : undefined;
  const detail =
    typeof payload === 'object' && payload !== null && 'error' in payload ? payload.error : payload;
  if (
    typeof detail === 'object' &&
    detail !== null &&
    'code' in detail &&
    typeof detail.code === 'string' &&
    googleBlockedCodes.has(detail.code)
  )
    return new AppError('model_refusal', { usage });
  if (error.name === 'APIConnectionTimeoutError') return new AppError('timeout', { usage });
  if (error.name === 'APIConnectionError') return new AppError('provider_unavailable', { usage });
  const status = 'status' in error ? error.status : undefined;
  if (typeof status === 'number') {
    if (status === 401) return new AppError('authentication', { usage });
    if (status === 403) return new AppError('permission', { usage });
    if (status === 429) return new AppError('rate_limit', { usage });
    if (status === 408 || status === 504) return new AppError('timeout', { usage });
    if (status === 499) return new AppError('cancelled', { usage });
    if (status >= 500) return new AppError('provider_unavailable', { usage });
    if (status >= 400) return new AppError('invalid_request', { usage });
  }
  return new AppError('provider_error', { usage });
}

function validTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Conserva totales válidos; un subconjunto ausente o incoherente queda desconocido. */
function tokenUsage(raw: unknown, provider: 'openai' | 'xai' | 'google-ai'): TokenUsage | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const wire = raw as Record<string, unknown>;
  const google = provider === 'google-ai';
  const inputTokens = google ? wire.total_input_tokens : wire.input_tokens;
  let outputTokens = google ? wire.total_output_tokens : wire.output_tokens;
  if (!validTokenCount(inputTokens) || !validTokenCount(outputTokens)) return null;
  if (google) {
    // Google factura salida visible + razonamiento. Si falta el desglose, no subestimamos.
    const thoughtTokens =
      wire.total_thought_tokens === undefined
        ? wire.total_tokens === inputTokens + outputTokens
          ? 0
          : null
        : wire.total_thought_tokens;
    if (!validTokenCount(thoughtTokens)) return null;
    if (wire.total_tool_use_tokens !== undefined && wire.total_tool_use_tokens !== 0) return null;
    outputTokens += thoughtTokens;
  }
  const totalTokens = inputTokens + outputTokens;
  if (!Number.isSafeInteger(totalTokens)) return null;
  if (
    wire.total_tokens !== undefined &&
    (!validTokenCount(wire.total_tokens) || wire.total_tokens !== totalTokens)
  )
    return null;
  const detail =
    typeof wire.input_tokens_details === 'object' &&
    wire.input_tokens_details !== null &&
    !Array.isArray(wire.input_tokens_details)
      ? (wire.input_tokens_details as Record<string, unknown>)
      : {};
  const cachedTokens = google ? wire.total_cached_tokens : detail.cached_tokens;
  let cachedInputTokens =
    validTokenCount(cachedTokens) && cachedTokens <= inputTokens ? cachedTokens : null;
  // Esta llamada no crea caché explícita en Google; OpenAI informa cache_write_tokens.
  let cacheWriteInputTokens =
    provider === 'xai' || google
      ? 0
      : validTokenCount(detail.cache_write_tokens) && detail.cache_write_tokens <= inputTokens
        ? detail.cache_write_tokens
        : null;
  if (
    cachedInputTokens !== null &&
    cacheWriteInputTokens !== null &&
    cachedInputTokens + cacheWriteInputTokens > inputTokens
  ) {
    cachedInputTokens = null;
    cacheWriteInputTokens = null;
  }
  return { inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens };
}

/** El modelo puede rechazar o truncar aun usando JSON Schema: nunca publicamos esos casos. */
function completion(
  text: string,
  status: string,
  refused: boolean,
  usage: TokenUsage | null,
): CompletionResult {
  if (refused) return { text: '', status: 'refused', usage };
  if (status === 'failed') throw new AppError('provider_error', { usage });
  return { text, status: status === 'completed' ? 'completed' : 'incomplete', usage };
}

class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI;
  constructor(
    private readonly model: string,
    apiKey: string,
    options: ProviderOptions,
  ) {
    // Un cliente por instancia, sin tickets guardados en campos. Reutiliza conexiones entre consultas.
    // maxRetries:0 evita llamadas/costos ocultos; el ejecutor controla intentos y presupuesto.
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      timeout: 15_000,
      logLevel: 'off',
      ...options,
    });
  }
  /**
   * Traduce el contrato común a Responses de OpenAI y normaliza texto y estado.
   * Solicita JSON Schema nativo en un intento; la validación local queda en el asistente.
   * @see LLMProvider.complete para parámetros, resultado y errores del contrato compartido.
   */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    let usage: TokenUsage | null = null;
    try {
      const result = await this.client.responses.create(
        {
          model: this.model,
          input: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.userContent },
          ],
          text: {
            format: {
              type: 'json_schema',
              name: request.schemaName,
              schema: request.responseSchema,
              strict: true,
            },
          },
          reasoning: { effort: 'none' },
          max_output_tokens: request.maxOutputTokens,
          tools: [],
          store: false,
          stream: false,
        },
        { signal: request.signal },
      );
      usage = tokenUsage(result.usage, 'openai');
      const refused =
        result.incomplete_details?.reason === 'content_filter' ||
        result.output.some(
          (item) => item.type === 'message' && item.content.some((part) => part.type === 'refusal'),
        );
      return completion(result.output_text, result.status ?? 'incomplete', refused, usage);
    } catch (error) {
      throw providerError(error, request.signal, usage);
    }
  }
}

class XAIProvider implements LLMProvider {
  private readonly client: SpaceXAI;
  constructor(
    private readonly model: string,
    apiKey: string,
    options: ProviderOptions,
  ) {
    // El SDK lee esta variable al construir el cliente y podría registrar headers y contenido.
    if (process.env.XAI_DEBUG === '1') throw new AppError('configuration_error');
    this.client = new SpaceXAI({
      apiKey,
      baseURL: 'https://api.x.ai/v1',
      maxRetries: 0,
      retryBeforeOutput: false,
      timeout: 15_000,
      ...options,
    });
  }
  /**
   * Traduce el contrato común a Responses de xAI y normaliza texto y estado.
   * Usa stream:false para recibir el resultado completo y propaga la cancelación al SDK.
   * @see LLMProvider.complete para parámetros, resultado y errores del contrato compartido.
   */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    let usage: TokenUsage | null = null;
    try {
      const result = await this.client.responses.create(
        {
          model: this.model,
          input: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: request.userContent },
          ],
          text: {
            format: {
              type: 'json_schema',
              name: request.schemaName,
              schema: request.responseSchema,
              strict: true,
            },
          },
          max_output_tokens: request.maxOutputTokens,
          tools: [],
          store: false,
          // Si se omite stream, este SDK hace streaming interno; false pide un único body JSON.
          stream: false,
        },
        { signal: request.signal },
      );
      // ModelResponse.usage agrega ceros por defecto; raw preserva los campos realmente recibidos.
      usage = tokenUsage(result.raw.usage, 'xai');
      const refused = result.output
        .filter(isMessage)
        .some((item) => item.content.some((part) => part.type === 'refusal'));
      return completion(result.toText(), result.status, refused, usage);
    } catch (error) {
      throw providerError(error, request.signal, usage);
    }
  }
}

export class GoogleGenAIProvider implements LLMProvider {
  private readonly client: GoogleGenAI;
  private readonly model: string;
  constructor(model: string, apiKey: string, options: ProviderOptions = {}) {
    this.client = new GoogleGenAI({ apiKey, httpOptions: { timeout: 15_000, ...options } });
    this.model = model;
  }
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    let usage: TokenUsage | null = null;
    try {
      const response = await this.client.interactions.create(
        {
          model: this.model,
          system_instruction: request.systemPrompt,
          input: request.userContent,
          response_format: {
            type: 'text',
            mime_type: 'application/json',
            schema: request.responseSchema,
          },
          generation_config: {
            max_output_tokens: request.maxOutputTokens,
          },
          tools: [],
          store: false,
          stream: false,
        },
        { signal: request.signal, maxRetries: 0 },
      );
      usage = tokenUsage(response.usage, 'google-ai');
      const refused =
        response.errors?.some((error) => googleBlockedCodes.has(error.code ?? '')) ?? false;
      if (refused) return completion('', response.status, true, usage);
      if (response.status === 'cancelled') throw new AppError('cancelled', { usage });
      if (response.status === 'budget_exceeded' || response.errors?.length)
        throw new AppError('provider_error', { usage });
      return completion(response.output_text ?? '', response.status, false, usage);
    } catch (error) {
      const mapped = googleProviderError(error, request.signal, usage);
      if (mapped.code === 'model_refusal') return completion('', 'failed', true, mapped.usage);
      throw mapped;
    }
  }
}

/** Factory de composición: sólo construye el cliente elegido y permite inyectar fetch en tests. */
export function createProvider(
  settings: ProviderSettings,
  options: ProviderOptions = {},
): LLMProvider {
  try {
    if (settings.provider === 'google-ai') {
      return new GoogleGenAIProvider(settings.model, settings.apiKey, options);
    }
    if (settings.provider === 'openai') {
      return new OpenAIProvider(settings.model, settings.apiKey, options);
    }
    if (settings.provider === 'xai') {
      return new XAIProvider(settings.model, settings.apiKey, options);
    }
    throw new AppError('configuration_error');
  } catch {
    throw new AppError('configuration_error');
  }
}
