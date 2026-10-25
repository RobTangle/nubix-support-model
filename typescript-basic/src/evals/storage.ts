import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../errors.js';
import { evaluationReportSchema } from './types.js';
import type { EvaluationReport } from './types.js';
import { summarize } from './metrics.js';

export async function readReport(path: string): Promise<EvaluationReport> {
  try {
    return evaluationReportSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    throw new AppError('invalid_report');
  }
}

export function renderSummary(report: EvaluationReport): string {
  const metrics = summarize(report.records);
  return `# Evaluación ${report.runId}\n\nEvidencia: **${report.provenance.evidence}**. ${report.provider}/${report.model}; ${report.promptVersion}; ${report.split}; ${report.mode}.\n\nCasos intentados: ${metrics.attemptedCases}/${metrics.cases}. Completa: ${report.complete}. Motivo de parada: ${report.stopReason ?? 'ninguno'}.\n\n| Métrica | Valor |\n|---|---:|\n| Accuracy (tickets) | ${metrics.accuracy.toFixed(4)} |\n| Macro F1 / globalScore | ${metrics.macroF1.toFixed(4)} |\n| Errores / intentados | ${metrics.operationalErrors}/${metrics.attemptedCases} |\n| Respuestas públicas válidas | ${metrics.publicResponsesValid} |\n| Validez estructurada primera llamada | ${metrics.structuredValidityBeforeRetry.toFixed(4)} |\n| Validez estructurada tras reparación | ${metrics.structuredValidityAfterRetry.toFixed(4)} |\n| Llamadas LLM | ${metrics.llmCalls} |\n| Costo conocido USD | ${metrics.knownCostUsd} |\n| Reserva desconocida USD | ${metrics.reservedUnknownUsd} |\n| Uso completo | ${metrics.usageComplete} |\n| p50 / p95 ms | ${metrics.latencyP50Ms} / ${metrics.latencyP95Ms} |\n\nLas reglas automáticas son indicios parciales. Calidad, filtraciones y falsos bloqueos requieren revisión humana; los tests fake no prueban calidad del modelo. Datos sintéticos; no acreditan seguridad sobre tráfico real.\n`;
}

export function reviewTemplate(report: EvaluationReport): string {
  return (
    report.records
      .map((row) =>
        JSON.stringify({
          runId: report.runId,
          caseId: row.id,
          usefulness: null,
          correctness: null,
          policy: null,
          severeIssue: null,
          attackSucceeded: null,
          unjustifiedRefusal: null,
          notes: '',
        }),
      )
      .join('\n') + '\n'
  );
}

/** Cada escritor posee un UUID nuevo; sólo ese objeto puede actualizar su checkpoint. */
export class ReportWriter {
  private readonly paths = new Map<string, string>();

  constructor(private readonly directory: string) {}

  async reserve(report: EvaluationReport): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, `${report.runId}.json`);
    await writeFile(path, JSON.stringify(evaluationReportSchema.parse(report), null, 2) + '\n', {
      flag: 'wx',
    });
    this.paths.set(report.runId, path);
  }

  async checkpoint(report: EvaluationReport): Promise<void> {
    const path = this.paths.get(report.runId);
    if (!path) throw new AppError('invalid_report');
    report.metrics = summarize(report.records);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify(evaluationReportSchema.parse(report), null, 2) + '\n',
      { flag: 'wx' },
    );
    await rename(temporary, path);
  }

  async finish(report: EvaluationReport): Promise<void> {
    await this.checkpoint(report);
    await writeFile(join(this.directory, `${report.runId}.md`), renderSummary(report), {
      flag: 'wx',
    });
    await writeFile(join(this.directory, `${report.runId}.reviews.jsonl`), reviewTemplate(report), {
      flag: 'wx',
    });
  }
}
