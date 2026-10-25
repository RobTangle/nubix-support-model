import { z } from 'zod';

const nonnegative = z.number().finite().nonnegative();
const money = z.string().regex(/^\d+(\.\d+)?$/u);
export const flowEventNameSchema = z.enum([
  'request.received',
  'input.validation.started',
  'input.validation.completed',
  'input.validation.failed',
  'budget.reserved',
  'llm.request.started',
  'llm.request.completed',
  'llm.request.failed',
  'schema.validation.started',
  'schema.validation.completed',
  'schema.validation.failed',
  'usage.recorded',
  'attempt.completed',
  'retry.scheduled',
  'human_review.suggested',
  'run.completed',
  'run.failed',
]);
/** Lista permitida: nunca aceptar objetos SDK o contenido del cliente como detalles arbitrarios. */
export const flowDetailsSchema = z.strictObject({
  status: z.string().max(64).optional(),
  code: z.string().max(64).optional(),
  decision: z.enum(['allow', 'review', 'block']).optional(),
  inputLength: nonnegative.int().optional(),
  inputTokens: nonnegative.int().nullable().optional(),
  outputTokens: nonnegative.int().nullable().optional(),
  cachedInputTokens: nonnegative.int().nullable().optional(),
  knownCostUsd: money.nullable().optional(),
  reservedUnknownUsd: money.optional(),
  estimatedCostUsd: money.optional(),
  usageComplete: z.boolean().optional(),
  maxOutputTokens: nonnegative.int().optional(),
  timeoutMs: nonnegative.optional(),
  confidence: z.number().min(0).max(1).optional(),
  category: z.enum(['billing', 'technical', 'account', 'other']).optional(),
});
export const flowEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: z.uuid(),
  sequence: z.number().int().positive(),
  timestamp: z.iso.datetime(),
  elapsedMs: nonnegative,
  durationMs: nonnegative.nullable(),
  provider: z.string().min(1).max(80),
  model: z.string().min(1).max(160),
  promptVersion: z.string().min(1).max(80),
  event: flowEventNameSchema,
  stage: z.enum(['input_moderation', 'generation', 'output_moderation']).optional(),
  attempt: z.number().int().min(1).max(2).optional(),
  details: flowDetailsSchema,
});
export type FlowEvent = z.infer<typeof flowEventSchema>;
export type FlowEventName = z.infer<typeof flowEventNameSchema>;
export type FlowDetails = z.infer<typeof flowDetailsSchema>;
export type FlowSink = (event: FlowEvent, signal?: AbortSignal) => void | Promise<void>;
