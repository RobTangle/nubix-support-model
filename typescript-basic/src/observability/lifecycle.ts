import type { AssistantOptions, ExecutionContext } from '../llm/execution.js';
import { AppError } from '../errors.js';
import type { TokenUsage } from '../llm/provider-types.js';
import { ticketSchema, type Ticket } from '../support/schemas.js';
import { emitWithinDeadline, type AttemptTrace } from './telemetry.js';
import type { RunObserver } from './run-observer.js';

/** La entrada externa se valida antes de incorporar cualquier contenido al caso de uso. */
export async function validateObservedTicket(
  input: unknown,
  observer: RunObserver,
): Promise<Ticket> {
  await observer.emit('input.validation.started');
  const started = observer.now();
  const ticket = ticketSchema.safeParse(input);
  if (!ticket.success) {
    await observer.emit(
      'input.validation.failed',
      { code: 'invalid_input' },
      { durationMs: observer.now() - started },
    );
    throw new AppError('invalid_input');
  }
  await observer.emit(
    'input.validation.completed',
    { inputLength: Array.from(ticket.data.text).length },
    { durationMs: observer.now() - started },
  );
  return ticket.data;
}

/** Un único punto conserva traza, telemetría histórica y eventos finos sin mezclar transportes. */
export async function recordObservedAttempt(
  options: AssistantOptions,
  context: ExecutionContext,
  item: AttemptTrace,
  usage: TokenUsage | null,
): Promise<void> {
  context.trace.attempts.push(item);
  context.trace.usageComplete &&= item.usageComplete;
  if (options.emit) {
    await emitWithinDeadline(
      options.emit,
      {
        event: 'llm_attempt',
        requestId: context.trace.requestId,
        provider: options.providerName,
        model: options.model,
        promptVersion: options.prompts.version,
        ...item,
      },
      context.signal,
    );
  }
  const scope = { stage: item.stage, attempt: item.attempt };
  await context.observer.emit(
    'usage.recorded',
    {
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      cachedInputTokens: usage?.cachedInputTokens ?? null,
      knownCostUsd: item.knownCostUsd,
      reservedUnknownUsd: item.reservedUnknownUsd,
      usageComplete: item.usageComplete,
    },
    scope,
  );
  await context.observer.emit(
    'attempt.completed',
    { status: item.status },
    { ...scope, durationMs: item.latencyMs },
  );
}

export async function finishObservedRun(context: ExecutionContext): Promise<void> {
  const { trace, observer } = context;
  try {
    await observer.emit(
      trace.status === 'error' ? 'run.failed' : 'run.completed',
      {
        status: trace.status,
        ...(trace.errorCode ? { code: trace.errorCode } : {}),
      },
      { durationMs: trace.latencyMs },
    );
  } catch {
    const code =
      trace.errorCode ?? (context.signal.aborted ? 'deadline_exceeded' : 'telemetry_error');
    trace.status = 'error';
    trace.errorCode = code;
    throw new AppError(code, { trace });
  }
}
