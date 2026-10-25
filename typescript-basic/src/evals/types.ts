/**
 * Define los contratos de evaluación: caso procesado, procedencia y reporte completo.
 * Incluye esquemas Zod porque los JSON del disco necesitan validación en ejecución; los tipos
 * TypeScript sólo verifican código al compilar. Centralizarlos mantiene lector y escritor de acuerdo.
 */
import { z } from 'zod';
import { promptVersionSchema } from '../prompt-contracts.js';
import type { ProcessOptions, SupportRun } from '../service.js';
import { supportResponseSchema } from '../schemas.js';
import { categorySchema } from './data.js';
import { metricsSchema, summarize } from './metrics.js';

/** Contrato mínimo evaluable: sirve tanto para el asistente completo como para la ablación. */
export interface EvaluationTarget {
  process(input: unknown, options?: ProcessOptions): Promise<SupportRun>;
}
const money = z.string().regex(/^\d+(\.\d+)?$/u);
const integer = z.number().int().nonnegative();
const stage = z.enum(['input_moderation', 'generation', 'output_moderation']);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const hashRecord = z.record(z.string(), sha256);
/** Un intento es una llamada al proveedor; una etapa puede requerir un reintento. */
export const attemptTraceSchema = z.strictObject({
  stage,
  attempt: integer,
  status: z.string(),
  inputTokens: integer.nullable(),
  outputTokens: integer.nullable(),
  latencyMs: z.number().nonnegative(),
  knownCostUsd: money.nullable(),
  reservedUnknownUsd: money,
  usageComplete: z.boolean(),
});
/** Traza operativa de un ticket: agrupa intentos, tiempos y costos, sin sus textos. */
export const runTraceSchema = z.strictObject({
  requestId: z.string(),
  provider: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  manualVersion: z.string(),
  safetyVersion: z.string(),
  priceVersion: z.string(),
  contextHashes: z.record(z.string(), z.string()),
  status: z.enum(['ok', 'escalated', 'blocked', 'error']),
  abstained: z.boolean(),
  stagesAttempted: integer,
  attempts: z.array(attemptTraceSchema),
  latencyMs: z.number().nonnegative(),
  knownCostUsd: money,
  reservedUnknownUsd: money,
  usageComplete: z.boolean(),
  errorCode: z.string().optional(),
});
/**
 * Evidencia por caso: conserva tanto la respuesta publicada como salidas intermedias para revisión.
 * A diferencia de la telemetría, este reporte de evaluación sí incluye textos del corpus sintético.
 */
export const caseRecordSchema = z.strictObject({
  id: z.string().min(1),
  text: z.string(),
  kind: z.enum(['ticket', 'attack', 'benign']),
  expectedCategory: categorySchema,
  expectedActions: z.array(z.string()),
  forbiddenPatterns: z.array(z.string()),
  scenario: z.string(),
  response: supportResponseSchema.nullable(),
  trace: runTraceSchema.nullable(),
  errorCode: z.string().nullable(),
  notRun: z.boolean(),
  latencyMs: z.number().nonnegative(),
  rawOutputs: z.array(z.strictObject({ stage, attempt: integer, text: z.string() })),
  publishedRuleFlags: z.array(z.string()),
  intermediateRuleFlags: z.array(z.string()),
});
/** Procedencia del experimento: versiones y huellas que permiten detectar condiciones distintas. */
export const provenanceSchema = z.strictObject({
  application: z.literal('nubbix-support-basic-ts'),
  applicationVersion: z.string(),
  reportVersion: z.literal(1),
  evidence: z.enum(['live', 'fake']),
  datasetHashes: hashRecord.refine((hashes) =>
    ['tickets', 'adversarial'].every((key) => Boolean(hashes[key])),
  ),
  promptHashes: hashRecord.refine((hashes) =>
    [
      'system',
      'manual',
      'safety',
      'inputModeration',
      'outputModeration',
      'repair',
      'examples',
    ].every((key) => Boolean(hashes[key])),
  ),
  schemaHash: sha256,
  priceHash: sha256,
  priceVersion: z.string(),
  settingsHash: sha256,
  settings: z.record(z.string(), z.union([z.string(), z.number()])),
  manualVersion: z.string(),
  safetyVersion: z.string(),
  canaryEnabled: z.boolean(),
  baselinePromptVersion: promptVersionSchema.optional(),
  sdkVersions: z.record(z.string(), z.string()),
});
// Validar al leer evita atribuir a TypeScript reportes Python o JSON adulterado/incompatible.
export const evaluationReportSchema = z
  .strictObject({
    runId: z.uuid(),
    createdAt: z.iso.datetime(),
    provider: z.string(),
    model: z.string(),
    promptVersion: promptVersionSchema,
    split: z.enum(['dev', 'test']),
    suite: z.enum(['all', 'adversarial']),
    mode: z.enum(['full', 'generation_only']),
    complete: z.boolean(),
    stopReason: z.string().nullable(),
    provenance: provenanceSchema,
    records: z.array(caseRecordSchema),
    metrics: metricsSchema,
  })
  .superRefine((report, context) => {
    if (new Set(report.records.map((row) => row.id)).size !== report.records.length)
      context.addIssue({ code: 'custom', message: 'IDs duplicados' });
    if (report.complete && report.records.some((row) => row.notRun))
      context.addIssue({ code: 'custom', message: 'Corrida incompleta' });
    for (const row of report.records)
      if (row.notRun && (row.response || row.trace || row.errorCode || row.rawOutputs.length))
        context.addIssue({ code: 'custom', message: 'Caso pendiente con resultado' });
    if (JSON.stringify(report.metrics) !== JSON.stringify(summarize(report.records)))
      context.addIssue({ code: 'custom', message: 'Métricas inconsistentes con los casos' });
  });
export type CaseRecord = z.infer<typeof caseRecordSchema>;
export type EvaluationReport = z.infer<typeof evaluationReportSchema>;
export type Provenance = z.infer<typeof provenanceSchema>;
