/**
 * Coordina una evaluación: ejecuta casos conocidos, conserva respuestas y guarda sus resultados.
 * El runner organiza el experimento; el asistente sigue siendo quien procesa cada ticket.
 * Separarlos permite comparar prompts o moderación con el mismo corpus, presupuesto y registro.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Budget } from '../budget.js';
import type { PriceCatalog } from '../budget.js';
import { AppError } from '../errors.js';
import { loadPrompts } from '../prompts.js';
import type { PromptBundle, PromptVersion } from '../prompts.js';
import type { RuntimeSettings } from '../runtime-settings.js';
import { responseJsonSchema, safetyJsonSchema } from '../schemas.js';
import { compilePattern, hash, loadDataset } from './data.js';
import type { EvaluationDataset } from './data.js';
import { ReportWriter } from './storage.js';
import { summarize } from './metrics.js';
import { installedPackageVersion } from './package-version.js';
import type { EvaluationReport, EvaluationTarget, Provenance } from './types.js';

/** Condiciones con las que la factory debe construir el asistente de una variante del experimento. */
export interface TargetContext {
  promptVersion: PromptVersion;
  mode: 'full' | 'generation_only';
  prompts: PromptBundle;
}
/** Dependencias comunes de la corrida; evidence distingue llamadas reales de dobles de prueba. */
export interface EvalRunnerOptions {
  factory: (context: TargetContext) => EvaluationTarget | Promise<EvaluationTarget>;
  provider: string;
  model: string;
  settings: RuntimeSettings;
  prices: PriceCatalog;
  evidence: 'live' | 'fake';
  outputDir: string;
  signal?: AbortSignal;
  dataset?: EvaluationDataset;
  checkpoint?: (report: EvaluationReport) => void | Promise<void>;
}
/** Selecciona versiones, partición del corpus y si se compara el efecto de la moderación. */
export interface RunOptions {
  promptVersions: PromptVersion[];
  split: 'dev' | 'test';
  suite?: 'all' | 'adversarial';
  compareModeration?: boolean;
}
const fatalCodes = new Set([
  'eval_budget_exceeded',
  'cancelled',
  'authentication',
  'permission',
  'invalid_request',
  'configuration_error',
  'unknown_model',
]);

/** Lee la versión de esta aplicación, separada de las versiones instaladas de sus SDK. */
async function packageVersion(path: string): Promise<string> {
  const value = JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8')) as {
    version: string;
  };
  if (typeof value.version !== 'string') throw new AppError('configuration_error');
  return value.version;
}

/**
 * Ejecuta variantes contra el mismo conjunto de casos con un presupuesto compartido.
 * La factory permite usar el servicio real o un doble de prueba sin acoplar el runner al proveedor.
 */
export class EvalRunner {
  constructor(private readonly options: EvalRunnerOptions) {}

  /**
   * Reserva reportes antes de consumir API y guarda un checkpoint (avance persistido) por caso.
   * Si se detiene por presupuesto, cancelación u otro error fatal, los pendientes quedan explícitos.
   */
  async run(run: RunOptions): Promise<EvaluationReport[]> {
    if (
      !run.promptVersions.length ||
      new Set(run.promptVersions).size !== run.promptVersions.length ||
      (run.compareModeration && run.promptVersions.length !== 1)
    )
      throw new AppError('invalid_arguments');
    const dataset = this.options.dataset ?? (await loadDataset());
    const cases =
      run.suite === 'adversarial'
        ? dataset.adversarial
        : [...dataset.tickets.filter((row) => row.split === run.split), ...dataset.adversarial];
    for (const row of cases) for (const pattern of row.forbiddenPatterns) compilePattern(pattern);
    const versions = await Promise.all([
      packageVersion('../../package.json'),
      installedPackageVersion('openai'),
      installedPackageVersion('@xai-official/sdk'),
      installedPackageVersion('zod'),
      installedPackageVersion('@google/genai'),
    ]);
    const writer = new ReportWriter(this.options.outputDir);
    const budget = new Budget(this.options.settings.evalBudgetUsd, 'eval_budget_exceeded');
    const entries: {
      report: EvaluationReport;
      context: TargetContext;
      target?: EvaluationTarget;
    }[] = [];
    for (const promptVersion of run.promptVersions) {
      const prompts = await loadPrompts(promptVersion, true);
      for (const mode of run.compareModeration
        ? (['full', 'generation_only'] as const)
        : (['full'] as const)) {
        // La procedencia permite reproducir las condiciones y rechazar comparaciones incompatibles.
        // Cada hash cubre un artefacto distinto: dataset, prompts, contrato JSON, precios y límites.
        // No fija la aleatoriedad del proveedor ni garantiza volver a obtener la misma respuesta.
        const provenance: Provenance = {
          application: 'nubbix-support-basic-ts',
          applicationVersion: versions[0]!,
          reportVersion: 1,
          evidence: this.options.evidence,
          datasetHashes: dataset.hashes,
          promptHashes: prompts.hashes,
          schemaHash: hash(
            JSON.stringify({ response: responseJsonSchema, moderation: safetyJsonSchema }),
          ),
          priceHash: this.options.prices.hash,
          priceVersion: this.options.prices.version,
          settingsHash: hash(JSON.stringify(this.options.settings)),
          settings: { ...this.options.settings },
          manualVersion: prompts.manualVersion,
          safetyVersion: prompts.safetyVersion,
          canaryEnabled: prompts.canaryEnabled,
          sdkVersions: {
            openai: versions[1]!,
            xai: versions[2]!,
            zod: versions[3]!,
            'google-ai': versions[4]!,
          },
        };
        const records = cases.map((row) => ({
          id: row.id,
          text: row.text,
          kind: row.kind,
          expectedCategory: row.expectedCategory,
          expectedActions: row.expectedActions,
          forbiddenPatterns: row.forbiddenPatterns,
          scenario: row.scenario,
          response: null,
          trace: null,
          errorCode: null,
          notRun: true,
          latencyMs: 0,
          rawOutputs: [],
          publishedRuleFlags: [],
          intermediateRuleFlags: [],
        }));
        const report: EvaluationReport = {
          runId: randomUUID(),
          createdAt: new Date().toISOString(),
          provider: this.options.provider,
          model: this.options.model,
          promptVersion,
          split: run.split,
          suite: run.suite ?? 'all',
          mode,
          complete: false,
          stopReason: null,
          provenance,
          records,
          metrics: summarize(records),
        };
        await writer.reserve(report);
        await this.options.checkpoint?.(report);
        entries.push({ report, context: { promptVersion, mode, prompts } });
      }
    }
    let stop: string | null = null;
    for (let index = 0; index < cases.length && !stop; index++) {
      // Intercalar por caso reduce deriva temporal; alternar orden evita favorecer siempre a v1.
      const ordered = index % 2 ? [...entries].reverse() : entries;
      for (const entry of ordered) {
        if (this.options.signal?.aborted) {
          stop = 'cancelled';
          break;
        }
        const row = entry.report.records[index]!;
        const started = performance.now();
        row.notRun = false;
        try {
          entry.target ??= await this.options.factory(entry.context);
          const result = await entry.target.process(
            { text: row.text },
            {
              batchBudget: budget,
              ...(this.options.signal ? { signal: this.options.signal } : {}),
              capture: (output) => row.rawOutputs.push(output),
            },
          );
          row.response = result.response;
          row.trace = result.trace;
          const published = JSON.stringify(result.response);
          row.publishedRuleFlags = row.forbiddenPatterns.filter((pattern) =>
            compilePattern(pattern).test(published),
          );
        } catch (error) {
          const safe = error instanceof AppError ? error : new AppError('internal_error');
          row.errorCode = safe.code;
          row.trace = safe.trace ?? null;
          if (fatalCodes.has(safe.code)) stop = safe.code;
        }
        row.intermediateRuleFlags = row.forbiddenPatterns.filter((pattern) =>
          row.rawOutputs.some((output) => compilePattern(pattern).test(output.text)),
        );
        row.latencyMs = performance.now() - started;
        await writer.checkpoint(entry.report);
        await this.options.checkpoint?.(entry.report);
        if (stop) break;
      }
    }
    for (const { report } of entries) {
      report.complete = report.records.every((row) => !row.notRun);
      report.stopReason = stop;
      await writer.finish(report);
      await this.options.checkpoint?.(report);
    }
    return entries.map((entry) => entry.report);
  }
}
