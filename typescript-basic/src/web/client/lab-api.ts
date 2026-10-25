import { z } from 'zod';
import {
  labRunDetailSchema,
  labRunListSchema,
  labHistoryQuerySchema,
  type LabHistoryQuery,
} from '../../lab/contracts.js';

// El navegador valida la estructura necesaria sin importar el runner ni módulos de Node.
const jsonObject = z.record(z.string(), z.json());
const reviewSchema = z.strictObject({
  runId: z.uuid(),
  caseId: z.string(),
  usefulness: z.union([z.literal(0), z.literal(1)]).nullable(),
  correctness: z.union([z.literal(0), z.literal(1)]).nullable(),
  policy: z.union([z.literal(0), z.literal(1)]).nullable(),
  severeIssue: z.boolean().nullable(),
  attackSucceeded: z.boolean().nullable(),
  unjustifiedRefusal: z.boolean().nullable(),
  notes: z.string(),
});
const recordSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    kind: z.enum(['ticket', 'attack', 'benign']),
    response: jsonObject.nullable(),
    trace: jsonObject.nullable(),
    errorCode: z.string().nullable(),
    notRun: z.boolean(),
    publishedRuleFlags: z.array(z.string()),
    intermediateRuleFlags: z.array(z.string()),
    rawOutputs: z.array(z.object({ stage: z.string(), attempt: z.number(), text: z.string() })),
  })
  .passthrough();
const reportSchema = z
  .object({
    runId: z.uuid(),
    provider: z.string(),
    model: z.string(),
    promptVersion: z.string(),
    split: z.string(),
    mode: z.string(),
    complete: z.boolean(),
    provenance: jsonObject,
    metrics: jsonObject,
    records: z.array(recordSchema),
  })
  .passthrough();
const evaluationSchema = z.object({
  job: labRunDetailSchema,
  reports: z.array(reportSchema),
  progress: z.object({
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  assessments: z.json(),
  selection: z.json(),
  reviews: z.array(reviewSchema).default([]),
});
export type EvaluationSnapshot = z.infer<typeof evaluationSchema>;
export type EvaluationReportView = EvaluationSnapshot['reports'][number];
export interface EvaluationInput {
  provider: string;
  operation: 'run' | 'compare' | 'adversarial';
  promptVersion: string;
  split: 'dev' | 'test';
  compareModeration: boolean;
  promptVersions?: string[];
  baselinePromptVersion?: string;
}
export interface ReviewInput {
  runId: string;
  caseId: string;
  usefulness: 0 | 1 | null;
  correctness: 0 | 1 | null;
  policy: 0 | 1 | null;
  severeIssue: boolean | null;
  attackSucceeded: boolean | null;
  unjustifiedRefusal: boolean | null;
  notes: string;
}

/** Consultar datos persistidos nunca inicia una evaluación ni una llamada al proveedor. */
export class LabApi {
  constructor(private readonly request: typeof fetch = (input, init) => fetch(input, init)) {}

  async history(input: LabHistoryQuery, signal?: AbortSignal) {
    const { kind, limit, offset, includeEvaluationCases, ...filters } =
      labHistoryQuerySchema.parse(input);
    const query = new URLSearchParams({
      ...(kind ? { kind } : {}),
      limit: String(limit),
      offset: String(offset),
    });
    if (includeEvaluationCases) query.set('includeEvaluationCases', 'true');
    for (const [key, value] of Object.entries(filters))
      if (value !== undefined) query.set(key, value);
    return labRunListSchema.parse(
      await this.json(`/api/history?${query}`, {
        ...(signal ? { signal } : {}),
      }),
    );
  }

  async detail(id: string, signal?: AbortSignal) {
    try {
      return labRunDetailSchema.parse(
        await this.json(`/api/history/${encodeURIComponent(id)}`, {
          ...(signal ? { signal } : {}),
        }),
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error('No se pudo cargar la ejecución guardada.');
    }
  }

  async start(input: EvaluationInput, signal?: AbortSignal): Promise<string> {
    const value = await this.json('/api/evaluations', {
      method: 'POST',
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    });
    return z.object({ jobId: z.uuid() }).parse(value).jobId;
  }

  async evaluation(id: string, signal: AbortSignal): Promise<EvaluationSnapshot> {
    try {
      return evaluationSchema.parse(
        await this.json(`/api/evaluations/${encodeURIComponent(id)}`, { signal }),
      );
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(
        'No se pudo cargar la evaluación. El trabajo continúa en el servidor; podés reabrirlo desde el historial.',
      );
    }
  }

  async cancel(id: string): Promise<void> {
    await this.json(`/api/evaluations/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  }

  async review(jobId: string, reportId: string, review: ReviewInput): Promise<void> {
    await this.json(
      `/api/evaluations/${encodeURIComponent(jobId)}/reports/${encodeURIComponent(reportId)}/reviews`,
      { method: 'PUT', body: JSON.stringify(review) },
    );
  }

  private async json(path: string, init: RequestInit): Promise<unknown> {
    try {
      const response = await this.request(path, {
        ...init,
        headers: {
          accept: 'application/json',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(
          response.status === 429
            ? 'El servidor está ocupado. Ya puede haber una evaluación activa.'
            : `El servidor rechazó la operación (HTTP ${response.status}).`,
        );
      }
      if (response.status === 204) return null;
      return await response.json();
    } catch (error) {
      if (init.signal?.aborted) throw new DOMException('Lectura cancelada.', 'AbortError');
      if (error instanceof Error && error.message.startsWith('El servidor')) throw error;
      throw new Error('No se pudieron leer los datos del laboratorio. Comprobá la conexión local.');
    }
  }
}
