import { z } from 'zod';
import { AppError } from '../errors.js';
import type { LLMProvider, CompletionRequest, CompletionResult } from '../provider-types.js';
import type { Stage } from '../telemetry.js';
import type { FlowDetails } from './events.js';
import { RunObserver } from './run-observer.js';
import type { RunInspection } from '../inspection/run-inspection.js';

/** Instrumenta una oportunidad de una etapa; conserva la semántica del puerto LLMProvider. */
export class AttemptObserver {
  constructor(
    private readonly observer: RunObserver,
    private readonly stage: Stage,
    private readonly attempt: number,
    private readonly inspector?: RunInspection,
  ) {}

  async complete(
    provider: LLMProvider,
    request: CompletionRequest,
    estimate: string,
  ): Promise<CompletionResult> {
    const scope = { stage: this.stage, attempt: this.attempt };
    await this.observer.emit(
      'budget.reserved',
      { estimatedCostUsd: estimate, maxOutputTokens: request.maxOutputTokens },
      scope,
    );
    await this.observer.emit(
      'llm.request.started',
      { maxOutputTokens: request.maxOutputTokens },
      scope,
    );
    await this.inspector?.record(
      'llm.request',
      {
        systemPrompt: request.systemPrompt,
        userContent: request.userContent,
        responseSchema: request.responseSchema,
        schemaName: request.schemaName,
        maxOutputTokens: request.maxOutputTokens,
      },
      scope,
    );
    const started = this.observer.now();
    let result: CompletionResult | undefined;
    try {
      request.signal.throwIfAborted();
      result = await provider.complete(request);
      const durationMs = this.observer.now() - started;
      await this.inspector?.record(
        'llm.response',
        { status: result.status, text: result.text, usage: result.usage },
        scope,
      );
      await this.observer.emit(
        'llm.request.completed',
        { status: result.status },
        { ...scope, durationMs },
      );
      return result;
    } catch (error) {
      const usage = result?.usage ?? (error instanceof AppError ? error.usage : null);
      const safe = request.signal.aborted
        ? new AppError(request.signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled')
        : error instanceof AppError
          ? error
          : new AppError('provider_error');
      try {
        await this.observer.emit(
          'llm.request.failed',
          { code: safe.code },
          { ...scope, durationMs: this.observer.now() - started },
        );
      } catch {
        // El fallo al observar no debe ocultar un error previo del proveedor ni perder su consumo.
      }
      throw new AppError(safe.code, {
        usage,
        retryable: safe.retryable,
      });
    }
  }

  async parse<T>(text: string, schema: z.ZodType<T>): Promise<T> {
    const scope = { stage: this.stage, attempt: this.attempt };
    await this.observer.emit('schema.validation.started', {}, scope);
    const started = this.observer.now();
    let outcome: T;
    try {
      const value: unknown = JSON.parse(text);
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new AppError('invalid_output');
      outcome = parsed.data;
    } catch {
      const durationMs = this.observer.now() - started;
      await this.inspector?.record(
        'schema.validation',
        { valid: false, schema: z.toJSONSchema(schema), error: 'invalid_output' },
        scope,
      );
      await this.observer.emit(
        'schema.validation.failed',
        { code: 'invalid_output' },
        { ...scope, durationMs },
      );
      throw new AppError('invalid_output');
    }
    const durationMs = this.observer.now() - started;
    await this.inspector?.record(
      'schema.validation',
      { valid: true, schema: z.toJSONSchema(schema), value: outcome },
      scope,
    );
    // Los esquemas ya validaron estos campos. Seleccionarlos evita copiar answer/actions al evento.
    const metadata = outcome as Record<string, unknown>;
    const details: FlowDetails =
      this.stage === 'generation'
        ? {
            category: metadata.category as FlowDetails['category'],
            confidence: metadata.confidence as number,
          }
        : { decision: metadata.decision as 'allow' | 'review' | 'block' };
    await this.observer.emit('schema.validation.completed', details, {
      ...scope,
      durationMs,
    });
    return outcome;
  }

  async retry(code: string): Promise<void> {
    await this.observer.emit(
      'retry.scheduled',
      { code },
      { stage: this.stage, attempt: this.attempt },
    );
  }
}
