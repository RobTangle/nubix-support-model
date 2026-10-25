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
/** Filtros de lectura: no dependen del registro actual de prompts ni habilitan ejecuciones. */
export const labHistoryFiltersSchema = z.strictObject({
  includeEvaluationCases: z.boolean().default(false),
  provider: labRunSummarySchema.shape.provider.optional(),
  promptVersion: labRunSummarySchema.shape.promptVersion.optional(),
  status: labRunSummarySchema.shape.status.optional(),
  mode: labRunSummarySchema.shape.mode.optional(),
});
export const labHistoryQuerySchema = labHistoryFiltersSchema.extend({
  kind: labRunSummarySchema.shape.kind.optional(),
  limit: z.number().int().min(1).max(100).default(30),
  offset: z.number().int().min(0).max(1_000_000).default(0),
});
export const labHistoryOptionsSchema = z.strictObject({
  providers: z.array(labRunSummarySchema.shape.provider),
  promptVersions: z.array(labRunSummarySchema.shape.promptVersion),
});
export const labRunListSchema = z.strictObject({
  items: z.array(labRunSummarySchema),
  total: z.number().int().nonnegative(),
  filterOptions: labHistoryOptionsSchema.default({ providers: [], promptVersions: [] }),
});
export type LabHistoryFilters = z.input<typeof labHistoryFiltersSchema>;
export type LabHistoryQuery = z.input<typeof labHistoryQuerySchema>;
export type LabHistoryOptions = z.infer<typeof labHistoryOptionsSchema>;
export type LabRunSummary = z.infer<typeof labRunSummarySchema>;
export type LabRunDetail = z.infer<typeof labRunDetailSchema>;
