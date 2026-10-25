import { z } from 'zod';
import { flowEventSchema } from '../observability/events.js';
import { inspectionEntrySchema } from '../inspection/contracts.js';

/** Contratos compartidos con el navegador: sin dependencias de SQLite, filesystem o SDK. */
export const labJsonSchema = z.json();
export const labRunSummarySchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(['support', 'evaluation']),
  mode: z.enum(['demo', 'live']),
  provider: z.string().min(1).max(80),
  model: z.string().min(1).max(160),
  promptVersion: z.string().min(1).max(80),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  parentId: z.uuid().nullable(),
});
export const labErrorSchema = z.strictObject({
  code: z.string().min(1).max(80),
  message: z.string().min(1).max(300),
});
export const labRunDetailSchema = labRunSummarySchema.extend({
  input: labJsonSchema,
  result: labJsonSchema.nullable(),
  error: labErrorSchema.nullable(),
  events: z.array(flowEventSchema).max(4096),
  inspections: z.array(inspectionEntrySchema).max(512),
});
export const labRunListSchema = z.strictObject({
  items: z.array(labRunSummarySchema),
  total: z.number().int().nonnegative(),
});
export type LabRunSummary = z.infer<typeof labRunSummarySchema>;
export type LabRunDetail = z.infer<typeof labRunDetailSchema>;
