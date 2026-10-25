import { AppError, type ErrorCode } from './errors.js';

export type Stage = 'input_moderation' | 'generation' | 'output_moderation';
export interface AttemptTrace {
  stage: Stage;
  attempt: number;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  knownCostUsd: string | null;
  reservedUnknownUsd: string;
  usageComplete: boolean;
}
export interface RunTrace {
  requestId: string;
  provider: string;
  model: string;
  promptVersion: string;
  manualVersion: string;
  safetyVersion: string;
  priceVersion: string;
  contextHashes: Record<string, string>;
  status: 'ok' | 'escalated' | 'blocked' | 'error';
  abstained: boolean;
  stagesAttempted: number;
  attempts: AttemptTrace[];
  latencyMs: number;
  knownCostUsd: string;
  reservedUnknownUsd: string;
  usageComplete: boolean;
  errorCode?: ErrorCode;
}
// La unión restringe qué puede registrar el programa: nunca recibe texto del ticket.
export type TelemetryEvent =
  | ({
      event: 'llm_attempt';
      requestId: string;
      provider: string;
      model: string;
      promptVersion: string;
    } & AttemptTrace)
  | ({ event: 'run_summary' } & RunTrace);
export type EventSink = (event: TelemetryEvent, signal?: AbortSignal) => void | Promise<void>;
export interface CapturedOutput {
  stage: Stage;
  attempt: number;
  text: string;
}

/** Acota sólo la espera del logger; las llamadas LLM se cancelan en su propio SDK. */
export async function waitForTelemetry(pending: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = (): void => reject(new AppError('telemetry_error'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    pending
      .then(resolve, () => reject(new AppError('telemetry_error')))
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function emitWithinDeadline(
  sink: EventSink,
  event: TelemetryEvent,
  signal: AbortSignal,
): Promise<void> {
  // Intentar el resumen incluso al vencer el plazo; no esperar indefinidamente a stderr.
  return waitForTelemetry(
    Promise.resolve().then(() => sink(event, signal)),
    signal,
  );
}
