/**
 * Vocabulario de observabilidad: define eventos/trazas compartidos y cómo acotar su espera.
 * execution.ts produce los intentos, service-run.ts arma el resumen y un EventSink los recibe.
 * El transporte concreto está en event-sink.ts para mantener estas reglas independientes del disco.
 */
import { AppError, type ErrorCode } from './errors.js';

/** Telemetría de operación: qué pasó, cuánto tardó y qué consumo pudo contabilizarse. */
export type Stage = 'input_moderation' | 'generation' | 'output_moderation';
/** Una etapa puede tener más de un intento por error transitorio o reparación del formato. */
export interface AttemptTrace {
  stage: Stage;
  attempt: number;
  /** valid indica que pasó el contrato de salida; no mide corrección semántica ni calidad. */
  status: string;
  /** null significa consumo desconocido; cero significa un conteo conocido de cero tokens. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** Tiempo local del intento, incluida validación; excluye la emisión posterior de este evento. */
  latencyMs: number;
  /** USD decimal como texto para no introducir redondeos binarios al sumar importes pequeños. */
  knownCostUsd: string | null;
  /** Reserva estimada que se mantiene comprometida si no se pudo conciliar un costo conocido. */
  reservedUnknownUsd: string;
  /** Hay desglose suficiente para el cálculo local; no es una confirmación de la factura real. */
  usageComplete: boolean;
}
/** Agrupa los intentos de un ticket y conserva contexto para comparar corridas. */
export interface RunTrace {
  /** UUID local compartido por los eventos de esta corrida; no es el ID remoto del proveedor. */
  requestId: string;
  provider: string;
  model: string;
  promptVersion: string;
  manualVersion: string;
  safetyVersion: string;
  priceVersion: string;
  /** Huellas del bundle de prompts: detectan cambios de contenido sin copiarlo a los logs. */
  contextHashes: Record<string, string>;
  status: 'ok' | 'escalated' | 'blocked' | 'error';
  abstained: boolean;
  /** Etapas iniciadas, no llamadas totales: attempts.length también cuenta los reintentos. */
  stagesAttempted: number;
  attempts: AttemptTrace[];
  /** Tiempo del flujo antes de emitir el resumen; no incluye el posterior archivado de la CLI. */
  latencyMs: number;
  knownCostUsd: string;
  reservedUnknownUsd: string;
  usageComplete: boolean;
  errorCode?: ErrorCode;
}
/**
 * Dos eventos estructurados: llm_attempt permite observar cada llamada y run_summary reúne
 * el resultado completo, incluso ante error. Repetir attempts en el resumen permite analizar
 * una corrida sin reconstruirla a partir de todas sus líneas anteriores.
 *
 * El contrato incluye metadatos, no tickets, prompts, respuestas ni claves. Los emisores deben
 * construir estos objetos explícitamente: el tipo TS no sanitiza objetos arbitrarios en runtime.
 */
export type TelemetryEvent =
  | ({
      event: 'llm_attempt';
      requestId: string;
      provider: string;
      model: string;
      promptVersion: string;
    } & AttemptTrace)
  | ({ event: 'run_summary' } & RunTrace);
/** Destino de eventos: el flujo puede usar una función síncrona o esperar un escritor asíncrono. */
export type EventSink = (event: TelemetryEvent, signal?: AbortSignal) => void | Promise<void>;
/** Captura de contenido para testing/evals. Se guarda explícitamente en reportes, no en TelemetryEvent. */
export interface CapturedOutput {
  stage: Stage;
  attempt: number;
  text: string;
}

/**
 * Impide que un destino de telemetría lento retenga al llamador indefinidamente.
 * AbortSignal rechaza esta espera, pero no cancela la Promise original ni garantiza que el
 * destino detenga su I/O. Ese destino debe aplicar su propia cancelación cuando la soporte.
 * Se conserva el manejador de rechazo de pending aunque el llamador ya haya dejado de esperar.
 */
export async function waitForTelemetry(pending: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = (): void => reject(new AppError('telemetry_error'));
    // Registrar antes de comprobar cubre también señales que llegaron abortadas al invocarnos.
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    pending
      .then(resolve, () => reject(new AppError('telemetry_error')))
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Normaliza sinks síncronos/asíncronos y limita la espera con el plazo del ticket. */
export async function emitWithinDeadline(
  sink: EventSink,
  event: TelemetryEvent,
  signal: AbortSignal,
): Promise<void> {
  // La microtarea convierte un throw síncrono del sink en rechazo de Promise. Se intenta emitir
  // incluso con señal abortada, sin garantizar entrega ni esperar indefinidamente a stderr.
  return waitForTelemetry(
    Promise.resolve().then(() => sink(event, signal)),
    signal,
  );
}
