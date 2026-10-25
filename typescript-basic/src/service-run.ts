/**
 * Ciclo de vida de una ejecución de ticket: crea su presupuesto, plazo, cancelación y traza,
 * ejecuta el flujo recibido y registra el cierre. service.ts elige las etapas del caso de uso;
 * este módulo concentra las tareas comunes para que también las reutilice la evaluación sin
 * moderación (evals/ablation.ts). Así cada consulta mantiene estado propio aunque comparta cliente.
 * Esta separación agrega indirección a cambio de compartir esas reglas entre flujos; un prototipo
 * con un único flujo podría mantener este código dentro de service.ts.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Budget } from './budget.js';
import { AppError } from './errors.js';
import {
  StructuredExecutor,
  type AssistantOptions,
  type ExecutionContext,
  type ProcessOptions,
} from './execution.js';
import { runtimeSettingsSchema } from './runtime-settings.js';
import {
  HUMAN_REVIEW_ACTION,
  supportResponseSchema,
  ticketSchema,
  type SupportResponse,
  type Ticket,
} from './schemas.js';
import type { RunTrace } from './telemetry.js';
import { emitWithinDeadline } from './telemetry.js';
import { RunObserver } from './observability/run-observer.js';
import { RunInspection } from './inspection/run-inspection.js';
import { finishObservedRun, validateObservedTicket } from './observability/lifecycle.js';

/** Resultado completo de un ticket: respuesta pública y datos operativos de su ejecución. */
export interface SupportRun {
  response: SupportResponse;
  trace: RunTrace;
}
/** Decisión final del flujo: responder, derivar por confianza o bloquear con una respuesta segura. */
export interface WorkflowResult {
  response: SupportResponse;
  status: 'ok' | 'blocked' | 'escalated';
  abstained: boolean;
}
/** Secuencia de etapas que se ejecuta usando el contexto y los límites creados por runSession. */
export type Workflow = (
  ticket: Ticket,
  executor: StructuredExecutor,
  context: ExecutionContext,
) => Promise<WorkflowResult>;

/**
 * Pide una propuesta y agrega revisión humana si la confianza declarada es menor que 0.70.
 * Devuelve null ante rechazo del modelo; las acciones producidas son sugerencias, no operaciones.
 * Este paso se comparte con la ablación: una prueba que retira moderación para medir su efecto,
 * manteniendo igual la generación y la regla de confianza.
 */
export async function generateProposal(
  ticket: Ticket,
  executor: StructuredExecutor,
  context: ExecutionContext,
  system: string,
): Promise<SupportResponse | null> {
  const answer = await executor.call(
    'generation',
    system,
    JSON.stringify({ ticket: ticket.text }),
    supportResponseSchema,
    context,
  );
  if (!answer || answer.confidence >= 0.7) return answer;
  await context.observer.emit('human_review.suggested', { confidence: answer.confidence });
  const actions = answer.actions.filter((action) => action !== HUMAN_REVIEW_ACTION).slice(0, 4);
  return supportResponseSchema.parse({ ...answer, actions: [...actions, HUMAN_REVIEW_ACTION] });
}

/**
 * Abre y cierra la "sesión" de trabajo de UN ticket, desde validación hasta resumen final.
 * Aquí session significa una corrida con recursos y límites propios; no guarda conversación
 * entre consultas. runSession aporta ese contexto y workflow decide qué etapas ejecutar.
 *
 * Extraer este ciclo de service.ts permite reutilizar presupuesto, cancelación y telemetría
 * en el flujo normal y en experimentos, sin duplicar su manejo de errores ni mezclar tickets.
 * StructuredExecutor, a su vez, resuelve cada llamada individual dentro de esta corrida.
 *
 * @param options Dependencias/configuración que pueden compartirse entre consultas.
 * @param input Entrada todavía desconocida; se valida antes de pasarla al workflow.
 * @param process Opciones de esta invocación: señal, presupuesto de lote y captura de salidas.
 * @param workflow Secuencia del caso de uso, que recibe ticket validado, ejecutor y contexto.
 * @returns Respuesta y traza finalizada. Ante error, la traza disponible viaja en AppError.trace.
 */
export async function runSession(
  options: AssistantOptions,
  input: unknown,
  process: ProcessOptions,
  workflow: Workflow,
): Promise<SupportRun> {
  const settings = runtimeSettingsSchema.parse(options.settings ?? {});
  const started = performance.now();
  const deadline = started + settings.deadlineMs;
  const deadlineSignal = AbortSignal.timeout(settings.deadlineMs);
  const signal = process.signal
    ? AbortSignal.any([process.signal, deadlineSignal])
    : deadlineSignal;
  const budget = new Budget(settings.ticketBudgetUsd);
  // Una traza pertenece a un ticket, aunque el asistente y el cliente SDK se reutilicen.
  // requestId correlaciona sus eventos; versiones y hashes identifican la configuración usada.
  // El estado inicial error es provisional: sólo el workflow completado lo cambia a éxito/bloqueo.
  const trace: RunTrace = {
    requestId: process.requestId ?? randomUUID(),
    provider: options.providerName,
    model: options.model,
    promptVersion: options.prompts.version,
    manualVersion: options.prompts.manualVersion,
    safetyVersion: options.prompts.safetyVersion,
    priceVersion: options.prices.version,
    contextHashes: { ...options.prompts.hashes },
    status: 'error',
    abstained: false,
    stagesAttempted: 0,
    attempts: [],
    latencyMs: 0,
    knownCostUsd: '0',
    reservedUnknownUsd: '0',
    usageComplete: true,
  };
  const context: ExecutionContext = {
    trace,
    deadline,
    signal,
    settings,
    inspector: new RunInspection(trace.requestId, process.inspect, signal),
    observer: new RunObserver(
      {
        requestId: trace.requestId,
        provider: options.providerName,
        model: options.model,
        promptVersion: options.prompts.version,
      },
      process.observe ?? options.observe,
      undefined,
      signal,
    ),
    budgets: [budget, ...(process.batchBudget ? [process.batchBudget] : [])],
    ...(process.capture ? { capture: process.capture } : {}),
  };
  let failure: AppError | undefined;
  try {
    await context.observer.emit('request.received');
    await context.inspector.record('input.received', input);
    const ticket = await validateObservedTicket(input, context.observer);
    await context.inspector.record('input.validated', {
      input: ticket,
      schema: z.toJSONSchema(ticketSchema),
      localRules: { maxUnicodePointsBeforeTrim: 8000, trim: true, rejectEmptyAfterTrim: true },
    });
    signal.throwIfAborted();
    const result = await workflow(ticket, new StructuredExecutor(options), context);
    signal.throwIfAborted();
    trace.status = result.status;
    trace.abstained = result.abstained;
    return { response: result.response, trace };
  } catch (error) {
    failure = process.signal?.aborted
      ? new AppError('cancelled')
      : signal.aborted
        ? new AppError('deadline_exceeded')
        : error instanceof AppError
          ? error
          : new AppError('internal_error');
    trace.status = 'error';
    trace.errorCode = failure.code;
    throw failure;
  } finally {
    // Este bloque corre también si se retorna una respuesta o se lanza un error. El reloj monotónico
    // mide duración del flujo; todavía no incluye emitir este resumen ni escribir el reporte de CLI.
    trace.latencyMs = performance.now() - started;
    trace.knownCostUsd = budget.knownUsd;
    trace.reservedUnknownUsd = budget.unknownUsd;
    // Un fallo no devuelve SupportRun: transportar su traza permite archivar el trabajo parcial.
    if (failure) failure.trace = trace;
    if (options.emit) {
      try {
        // El resumen contiene los intentos para ser útil por sí solo. Se intenta enviarlo aun ante
        // fallos; una señal vencida o un sink roto pueden impedir su entrega. El reporte es otra vía.
        await emitWithinDeadline(options.emit, { event: 'run_summary', ...trace }, signal);
      } catch {
        // La política actual exige poder registrar telemetría: un sink fallido convierte la corrida
        // en error, en lugar de publicar éxito silenciosamente sin observabilidad.
        const code = process.signal?.aborted
          ? 'cancelled'
          : signal.aborted
            ? 'deadline_exceeded'
            : 'telemetry_error';
        trace.status = 'error';
        trace.errorCode = code;
        throw new AppError(code, { trace });
      }
    }
    await finishObservedRun(context);
  }
}
