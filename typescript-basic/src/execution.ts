/**
 * Mecánica de cada llamada al LLM: arma el request, reserva dinero, aplica timeout, valida JSON
 * y controla los reintentos. service.ts decide el orden de etapas; este módulo aplica las mismas
 * reglas a generación y moderación, usando el contrato neutral de provider-types.ts.
 * La separación evita que cada etapa o proveedor implemente su propia política de ejecución.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { Budget, type PriceCatalog } from './budget.js';
import { AppError } from './errors.js';
import type { LLMProvider, TokenUsage } from './provider-types.js';
import type { PromptBundle } from './prompts.js';
import type { RuntimeSettings } from './runtime-settings.js';
import type { CapturedOutput, EventSink, RunTrace, Stage, AttemptTrace } from './telemetry.js';
import type { FlowSink } from './observability/events.js';
import type { RunObserver } from './observability/run-observer.js';
import { AttemptObserver } from './observability/attempt-observer.js';
import { recordObservedAttempt } from './observability/lifecycle.js';

/** Dependencias compartibles: cliente, prompts, precios y políticas generales del asistente. */
export interface AssistantOptions {
  provider: LLMProvider;
  providerName: string;
  model: string;
  prompts: PromptBundle;
  prices: PriceCatalog;
  settings?: Partial<RuntimeSettings>;
  emit?: EventSink;
  observe?: FlowSink;
}
/** Opciones de una corrida concreta; un presupuesto de lote puede abarcar varios tickets de evals. */
export interface ProcessOptions {
  signal?: AbortSignal;
  batchBudget?: Budget;
  /** Captura explícita para evaluaciones y reportes de testing; no forma parte de la telemetría. */
  capture?: (output: CapturedOutput) => void;
  observe?: FlowSink;
  requestId?: string;
}
/** Estado de un ticket compartido por sus etapas: deadline es un instante del reloj monotónico. */
export interface ExecutionContext {
  trace: RunTrace;
  deadline: number;
  signal: AbortSignal;
  budgets: Budget[];
  settings: RuntimeSettings;
  capture?: (output: CapturedOutput) => void;
  observer: RunObserver;
}

/**
 * "Structured" indica que la salida debe cumplir un esquema, además de ser JSON válido.
 * Executor coordina la llamada; el adaptador provider es quien se comunica con el SDK concreto.
 */
export class StructuredExecutor {
  constructor(private readonly options: AssistantOptions) {}

  /**
   * Ejecuta una etapa y devuelve su dato validado como T, o null ante rechazo explícito.
   * Hay hasta dos intentos totales: un fallo transitorio puede reintentarse con espera breve;
   * JSON inválido puede repararse agregando instrucciones, sin reenviar la salida cruda.
   * Ambas causas comparten el mismo límite para evitar multiplicar llamadas y costos.
   */
  async call<T>(
    stage: Stage,
    system: string,
    content: string,
    schema: z.ZodType<T>,
    context: ExecutionContext,
  ): Promise<T | null> {
    const price = this.options.prices.get(this.options.providerName, this.options.model);
    let repair = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (context.deadline <= performance.now()) throw new AppError('deadline_exceeded');
      context.signal.throwIfAborted();
      const request = {
        systemPrompt: system + (repair ? `\n${this.options.prompts.repair}` : ''),
        userContent: content,
        responseSchema: z.toJSONSchema(schema),
        schemaName: stage === 'generation' ? 'support_response' : 'safety_assessment',
        maxOutputTokens:
          stage === 'generation'
            ? context.settings.generationMaxTokens
            : context.settings.moderationMaxTokens,
      };
      const estimate = price.estimate(request);
      // Ambos contadores se comprueban sin await: la reserva no queda a medio hacer.
      for (const budget of context.budgets) budget.check(estimate);
      const reservations = context.budgets.map((budget) => ({
        budget,
        id: budget.reserve(estimate),
      }));
      if (attempt === 1) context.trace.stagesAttempted++;
      const started = performance.now();
      const timeout = AbortSignal.timeout(
        Math.max(
          1,
          Math.ceil(Math.min(context.settings.callTimeoutMs, context.deadline - started)),
        ),
      );
      const signal = AbortSignal.any([context.signal, timeout]);
      let usage: TokenUsage | null = null;
      let outcome: T | null = null;
      let failure: AppError | null = null;
      let status = 'valid';
      const observation = new AttemptObserver(context.observer, stage, attempt);
      try {
        signal.throwIfAborted();
        const result = await observation.complete(
          this.options.provider,
          { ...request, signal },
          estimate,
        );
        usage = result.usage;
        // Capturar antes de validar conserva también JSON inválido o texto truncado para debugging.
        // Este canal contiene texto del modelo y es independiente de los eventos de metadatos.
        if (context.capture) context.capture({ stage, attempt, text: result.text });
        signal.throwIfAborted();
        if (result.status === 'refused') {
          status = 'refused';
        } else {
          if (result.status !== 'completed') throw new AppError('incomplete_output');
          outcome = await observation.parse(result.text, schema);
        }
      } catch (error) {
        // Un SDK puede informar consumo al cerrar una solicitud ya cancelada. El decorador
        // lo conserva en AppError: recuperarlo antes de normalizar el motivo de cancelación.
        usage = error instanceof AppError ? (error.usage ?? usage) : usage;
        failure = signal.aborted
          ? new AppError(context.signal.aborted ? 'deadline_exceeded' : 'timeout', { usage })
          : error instanceof AppError
            ? error
            : new AppError('provider_error');
        usage = failure.usage ?? usage;
        status = failure.code;
      } finally {
        // Haber recibido tokens no alcanza: el costo conocido requiere un desglose que permita
        // aplicar las tarifas (incluida caché). Sin él, se conserva la reserva estimada del intento;
        // desconocido no se transforma en costo cero ni libera presupuesto para más llamadas.
        const cost = usage ? price.cost(usage) : null;
        const knownCost = cost?.complete ? cost.usd : null;
        for (const reservation of reservations)
          reservation.budget.settle(reservation.id, knownCost);
        // Se registra todo intento, incluso si fallaron el proveedor o la validación. valid sólo
        // expresa el contrato estructural; la calidad de la respuesta requiere otra evaluación.
        const item: AttemptTrace = {
          stage,
          attempt,
          status,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          latencyMs: performance.now() - started,
          knownCostUsd: knownCost,
          reservedUnknownUsd: knownCost === null ? estimate : '0',
          usageComplete: cost?.complete ?? false,
        };
        await recordObservedAttempt(this.options, context, item, usage);
      }
      // El consumo real puede superar la reserva: detener incluso antes de publicar éxito.
      for (const budget of context.budgets) budget.check('0');
      if (!failure) return outcome;
      if (
        attempt === 2 ||
        context.signal.aborted ||
        (!failure.retryable && failure.code !== 'invalid_output')
      )
        throw failure;
      repair = failure.code === 'invalid_output';
      await observation.retry(failure.code);
      if (!repair)
        await sleep(
          Math.min(100 + Math.random() * 100, Math.max(0, context.deadline - performance.now())),
          undefined,
          { signal: context.signal },
        );
    }
    throw new AppError('internal_error');
  }
}
