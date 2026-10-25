import { randomUUID } from 'node:crypto';
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

export interface SupportRun {
  response: SupportResponse;
  trace: RunTrace;
}
export interface WorkflowResult {
  response: SupportResponse;
  status: 'ok' | 'blocked' | 'escalated';
  abstained: boolean;
}
export type Workflow = (
  ticket: Ticket,
  executor: StructuredExecutor,
  context: ExecutionContext,
) => Promise<WorkflowResult>;

/** Compartir sólo el paso de generación permite una ablación controlada sin duplicar políticas. */
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
  const actions = answer.actions.filter((action) => action !== HUMAN_REVIEW_ACTION).slice(0, 4);
  return supportResponseSchema.parse({ ...answer, actions: [...actions, HUMAN_REVIEW_ACTION] });
}

/** El estado pertenece a una invocación, no al singleton que comparte varias requests. */
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
  const trace: RunTrace = {
    requestId: randomUUID(),
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
    budgets: [budget, ...(process.batchBudget ? [process.batchBudget] : [])],
    ...(process.capture ? { capture: process.capture } : {}),
  };
  let failure: AppError | undefined;
  try {
    const ticket = ticketSchema.safeParse(input);
    if (!ticket.success) throw new AppError('invalid_input');
    signal.throwIfAborted();
    const result = await workflow(ticket.data, new StructuredExecutor(options), context);
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
    trace.latencyMs = performance.now() - started;
    trace.knownCostUsd = budget.knownUsd;
    trace.reservedUnknownUsd = budget.unknownUsd;
    if (failure) failure.trace = trace;
    if (options.emit) {
      try {
        await emitWithinDeadline(options.emit, { event: 'run_summary', ...trace }, signal);
      } catch {
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
  }
}
