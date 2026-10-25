import { z } from 'zod';
import { flowEventSchema } from '../observability/events.js';
import { supportResponseSchema, ticketSchema } from '../schemas.js';
import { inspectionEntrySchema } from '../inspection/contracts.js';

export const webProviderSchema = z.enum(['openai', 'xai', 'google-ai']);
export const webPromptSchema = z.enum(['basic-v1', 'basic-v2']);
export const webConfigurationSchema = z.strictObject({
  mode: z.enum(['demo', 'live']),
  providers: z.array(
    z.strictObject({
      id: webProviderSchema,
      label: z.string(),
      model: z.string(),
      available: z.boolean(),
    }),
  ),
  promptVersions: z.array(webPromptSchema),
  maxConcurrent: z.number().int().positive().max(16),
});
export const webRequestSchema = ticketSchema.extend({
  provider: webProviderSchema,
  promptVersion: webPromptSchema,
});
const count = z.number().int().nonnegative();
const money = z.string().regex(/^\d+(\.\d+)?$/u);
const stage = z.enum(['input_moderation', 'generation', 'output_moderation']);
/** Contrato de transporte sin imports Node: también se valida dentro del navegador. */
const traceSchema = z.strictObject({
  requestId: z.uuid(),
  provider: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  manualVersion: z.string(),
  safetyVersion: z.string(),
  priceVersion: z.string(),
  contextHashes: z.record(z.string(), z.string()),
  status: z.enum(['ok', 'escalated', 'blocked', 'error']),
  abstained: z.boolean(),
  stagesAttempted: count,
  attempts: z.array(
    z.strictObject({
      stage,
      attempt: count,
      status: z.string(),
      inputTokens: count.nullable(),
      outputTokens: count.nullable(),
      latencyMs: z.number().nonnegative(),
      knownCostUsd: money.nullable(),
      reservedUnknownUsd: money,
      usageComplete: z.boolean(),
    }),
  ),
  latencyMs: z.number().nonnegative(),
  knownCostUsd: money,
  reservedUnknownUsd: money,
  usageComplete: z.boolean(),
  errorCode: z.string().optional(),
});
export const streamFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('accepted'),
    requestId: z.uuid(),
    mode: z.enum(['demo', 'live']),
    receivedAt: z.iso.datetime(),
  }),
  z.strictObject({ type: z.literal('event'), event: flowEventSchema }),
  // Datos de depuración potencialmente no moderados: nunca representan una respuesta aprobada.
  z.strictObject({ type: z.literal('inspection'), inspection: inspectionEntrySchema }),
  z.strictObject({
    type: z.literal('result'),
    requestId: z.uuid(),
    mode: z.enum(['demo', 'live']),
    response: supportResponseSchema,
    trace: traceSchema,
  }),
  z.strictObject({
    type: z.literal('error'),
    requestId: z.uuid(),
    error: z.strictObject({ code: z.string().max(80), message: z.string().max(300) }),
  }),
]);
export type StreamFrame = z.infer<typeof streamFrameSchema>;
export type WebConfiguration = z.infer<typeof webConfigurationSchema>;
export type WebProvider = z.infer<typeof webProviderSchema>;
export type WebPrompt = z.infer<typeof webPromptSchema>;
