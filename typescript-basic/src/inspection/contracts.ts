import { z } from 'zod';

/** Canal de depuración con contenido: separado de la telemetría de metadatos y validado en UI. */
export const inspectionEntrySchema = z.strictObject({
  requestId: z.uuid(),
  sequence: z.number().int().positive(),
  timestamp: z.iso.datetime(),
  kind: z.enum([
    'http.request',
    'input.received',
    'input.validated',
    'llm.request',
    'llm.response',
    'schema.validation',
  ]),
  stage: z.enum(['input_moderation', 'generation', 'output_moderation']).optional(),
  attempt: z.number().int().min(1).max(2).optional(),
  data: z.json(),
});
export type InspectionEntry = z.infer<typeof inspectionEntrySchema>;
export type InspectionSink = (entry: InspectionEntry, signal?: AbortSignal) => void | Promise<void>;
