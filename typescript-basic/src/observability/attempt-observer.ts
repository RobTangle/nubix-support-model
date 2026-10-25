import type { z } from 'zod';
import { AppError } from '../errors.js';
import type { LLMProvider, CompletionRequest, CompletionResult } from '../provider-types.js';
import type { Stage } from '../telemetry.js';
import type { FlowDetails } from './events.js';
import { RunObserver } from './run-observer.js';

/** Instrumenta una oportunidad de una etapa; conserva la semántica del puerto LLMProvider. */
export class AttemptObserver {
  constructor(
    private readonly observer: RunObserver,
    private readonly stage: Stage,
    private readonly attempt: number,
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
    const started = this.observer.now();
    let result: CompletionResult | undefined;
    try {
      request.signal.throwIfAborted();
      result = await provider.complete(request);
      await this.observer.emit(
        'llm.request.completed',
        { status: result.status },
        { ...scope, durationMs: this.observer.now() - started },
      );
      return result;
    } catch (error) {
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
        usage: result?.usage ?? safe.usage,
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
      await this.observer.emit(
        'schema.validation.failed',
        { code: 'invalid_output' },
        { ...scope, durationMs: this.observer.now() - started },
      );
      throw new AppError('invalid_output');
    }
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
      durationMs: this.observer.now() - started,
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
