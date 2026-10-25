import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PriceCatalog } from '../costs/budget.js';
import { AppError, publicError } from '../errors.js';
import { EvalRunner, type TargetContext } from '../evals/runner.js';
import type { EvaluationDataset } from '../evals/data.js';
import type { EvaluationTarget } from '../evals/types.js';
import { assessReport, compareReports, humanReviewSchema } from '../evals/reviews.js';
import type { RuntimeSettings } from '../config/runtime-settings.js';
import { promptVersionSchema } from '../prompting/prompt-contracts.js';
import type { PromptRegistry } from '../prompting/prompt-registry.js';
import type { WebProvider } from '../web/contracts.js';
import { LabStore } from './storage.js';

export const evaluationInputSchema = z
  .strictObject({
    provider: z.enum(['openai', 'xai', 'google-ai']),
    operation: z.enum(['run', 'compare', 'adversarial']),
    promptVersion: promptVersionSchema,
    promptVersions: z.array(promptVersionSchema).min(2).max(100).optional(),
    baselinePromptVersion: promptVersionSchema.optional(),
    split: z.enum(['dev', 'test']),
    compareModeration: z.boolean(),
  })
  .refine(
    (input) =>
      (input.operation !== 'compare' || input.split === 'dev') &&
      (!input.compareModeration || input.operation === 'adversarial') &&
      (input.operation === 'compare' ||
        (input.promptVersions === undefined && input.baselinePromptVersion === undefined)),
  );
type EvaluationInput = z.infer<typeof evaluationInputSchema> & {
  promptVersions: string[];
  baselinePromptVersion: string;
};

interface EvaluationServiceOptions {
  store: LabStore;
  mode: 'demo' | 'live';
  models: ReadonlyMap<WebProvider, string>;
  settings: RuntimeSettings;
  prices: PriceCatalog;
  outputDir: string;
  dataset?: EvaluationDataset;
  registry: PromptRegistry;
  factory(
    provider: WebProvider,
    context: TargetContext,
  ): EvaluationTarget | Promise<EvaluationTarget>;
}

/** Jobs locales independientes del navegador: el runner conserva métricas, presupuesto y gates. */
export class LabEvaluationService {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();

  constructor(private readonly options: EvaluationServiceOptions) {}

  start(value: unknown): { jobId: string } {
    const parsed = evaluationInputSchema.safeParse(value);
    if (!parsed.success) throw new AppError('invalid_arguments');
    if (this.active.size) throw new AppError('rate_limit');
    const selected = parsed.data;
    const versions =
      selected.operation === 'compare'
        ? (selected.promptVersions ?? this.options.registry.versions.map((entry) => entry.id))
        : [selected.promptVersion];
    const baseline =
      selected.operation === 'compare'
        ? (selected.baselinePromptVersion ?? this.options.registry.baselineVersion)
        : selected.promptVersion;
    if (
      !this.options.registry.has(selected.promptVersion) ||
      versions.some((version) => !this.options.registry.has(version)) ||
      new Set(versions).size !== versions.length ||
      (selected.operation === 'compare' && (versions.length < 2 || !versions.includes(baseline)))
    )
      throw new AppError('invalid_arguments');
    const input: EvaluationInput = {
      ...selected,
      promptVersions: versions,
      baselinePromptVersion: baseline,
    };
    const model = this.options.models.get(input.provider);
    if (!model) throw new AppError('missing_key');
    this.options.prices.get(input.provider, model);
    const jobId = randomUUID();
    this.options.store.createRun({
      id: jobId,
      kind: 'evaluation',
      mode: this.options.mode,
      provider: input.provider,
      model,
      promptVersion: input.operation === 'compare' ? 'comparison' : input.promptVersion,
      input: input.operation === 'compare' ? input : selected,
    });
    const controller = new AbortController();
    // Posponer al microtask permite registrar el job antes de que el runner haga trabajo asíncrono.
    const done = Promise.resolve()
      .then(() => this.execute(jobId, model, input, controller.signal))
      .catch(() => {
        // Incluso si falla el disco al cerrar, no filtrar el error ni dejar un rechazo sin manejar.
        process.stderr.write(JSON.stringify(publicError(new AppError('report_error'))) + '\n');
      })
      .finally(() => this.active.delete(jobId));
    this.active.set(jobId, { controller, done });
    return { jobId };
  }

  get(jobId: string) {
    const job = this.options.store.getRun(jobId);
    if (!job || job.kind !== 'evaluation') return null;
    const reports = this.options.store.getReports(jobId);
    const reviews = reports.flatMap((report) => this.options.store.getReviews(report.runId));
    // Los jobs anteriores pueden nombrar versiones retiradas. Leer historia no consulta el
    // registro actual ni reconstruye targets: utiliza la selección que quedó persistida.
    const input = evaluationInputSchema.parse(job.input);
    const variants =
      input.operation === 'compare'
        ? (input.promptVersions ?? job.promptVersion.split(','))
        : [input.promptVersion];
    const total = reports.length
      ? reports.reduce((sum, report) => sum + report.records.length, 0)
      : (input.operation === 'adversarial' ? 20 : 60) *
        (input.operation === 'compare' ? variants.length : input.compareModeration ? 2 : 1);
    const assessments = reports.map((report) => assessReport(report, reviews));
    const selection =
      input.operation === 'compare' && reports.length >= 2 && reports.length === variants.length
        ? compareReports(reports, reviews, input.baselinePromptVersion)
        : { recommendedPrompt: null, status: 'not_applicable' };
    return {
      job,
      reports,
      reviews,
      progress: {
        completed: reports.reduce(
          (sum, report) => sum + report.records.filter((record) => !record.notRun).length,
          0,
        ),
        total,
      },
      assessments,
      selection,
    };
  }

  cancel(jobId: string): boolean {
    const job = this.options.store.getRun(jobId);
    if (!job || job.kind !== 'evaluation') return false;
    this.active.get(jobId)?.controller.abort();
    return true;
  }

  saveReview(jobId: string, reportId: string, value: unknown): void {
    const job = this.options.store.getRun(jobId);
    const report = this.options.store.getReports(jobId).find((entry) => entry.runId === reportId);
    const review = humanReviewSchema.safeParse(value);
    if (
      !job ||
      job.status === 'running' ||
      !report ||
      !review.success ||
      review.data.runId !== reportId ||
      review.data.notes.length > 8000
    )
      throw new AppError('invalid_review');
    if (report.records.find((record) => record.id === review.data.caseId)?.notRun !== false)
      throw new AppError('invalid_review');
    this.options.store.saveReview(reportId, review.data);
  }

  async close(): Promise<void> {
    for (const job of this.active.values()) job.controller.abort();
    await Promise.all([...this.active.values()].map((job) => job.done));
  }

  private async execute(
    jobId: string,
    model: string,
    input: EvaluationInput,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const runner = new EvalRunner({
        provider: input.provider,
        model,
        settings: this.options.settings,
        prices: this.options.prices,
        evidence: this.options.mode === 'live' ? 'live' : 'fake',
        outputDir: this.options.outputDir,
        signal,
        registry: this.options.registry,
        ...(this.options.dataset ? { dataset: this.options.dataset } : {}),
        checkpoint: (report) => this.options.store.saveReport(jobId, report),
        factory: async (context) => {
          const target = await this.options.factory(input.provider, context);
          return {
            process: async (ticket, process = {}) => {
              const id = randomUUID();
              this.options.store.createRun({
                id,
                parentId: jobId,
                kind: 'support',
                mode: this.options.mode,
                provider: input.provider,
                model,
                promptVersion: context.promptVersion,
                input: ticket,
              });
              try {
                const result = await target.process(ticket, {
                  ...process,
                  requestId: id,
                  observe: (event) => this.options.store.appendEvent(id, event),
                  inspect: (entry) => this.options.store.appendInspection(id, entry),
                });
                if (signal.aborted) throw new AppError('cancelled', { trace: result.trace });
                this.options.store.finishRun(id, { status: 'completed', result });
                return result;
              } catch (error) {
                const safe = error instanceof AppError ? error : new AppError('internal_error');
                this.options.store.finishRun(id, {
                  status: signal.aborted ? 'cancelled' : 'failed',
                  result: safe.trace ? { trace: safe.trace } : null,
                  error: publicError(safe).error,
                });
                throw safe;
              }
            },
          };
        },
      });
      const reports = await runner.run({
        promptVersions: input.promptVersions,
        ...(input.operation === 'compare'
          ? { baselinePromptVersion: input.baselinePromptVersion }
          : {}),
        split: input.split,
        suite: input.operation === 'adversarial' ? 'adversarial' : 'all',
        compareModeration: input.compareModeration,
      });
      const complete = reports.every((report) => report.complete);
      this.options.store.finishRun(jobId, {
        status: signal.aborted ? 'cancelled' : complete ? 'completed' : 'failed',
        result: {
          reportIds: reports.map((report) => report.runId),
          stopReason: reports.find((report) => report.stopReason)?.stopReason ?? null,
        },
      });
    } catch (error) {
      // El rechazo se consume aquí para que ningún job detached produzca unhandledRejection.
      this.options.store.finishRun(jobId, {
        status: signal.aborted ? 'cancelled' : 'failed',
        error: publicError(error).error,
      });
    }
  }
}
