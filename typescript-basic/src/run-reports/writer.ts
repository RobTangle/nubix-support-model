import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../errors.js';
import { installedPackageVersion } from '../evals/package-version.js';
import { responseJsonSchema, safetyJsonSchema } from '../schemas.js';
import type { RunReport, RunReportOptions, RunReportResult } from './types.js';

/** Archivo por ejecución: la reserva inicial impide gastar si el destino no se puede escribir. */
export class RunReportWriter {
  private constructor(
    readonly path: string,
    private readonly initial: RunReport,
  ) {}

  static async create(options: RunReportOptions): Promise<RunReportWriter> {
    try {
      const startedAt = new Date().toISOString();
      const reportId = randomUUID();
      const ticketId = createHash('sha256').update(options.normalizedText).digest('hex');
      const directory = resolve(
        options.directory ?? fileURLToPath(new URL('../../reports/manual-tests/', import.meta.url)),
      );
      const path = join(directory, ticketId, `${options.provider}--${reportId}.json`);
      const sdk = { openai: 'openai', xai: '@xai-official/sdk', 'google-ai': '@google/genai' }[
        options.provider
      ];
      const [metadata, sdkVersion, zodVersion] = await Promise.all([
        readFile(new URL('../../package.json', import.meta.url), 'utf8').then(
          (source) => JSON.parse(source) as { name: string; version: string },
        ),
        installedPackageVersion(sdk),
        installedPackageVersion('zod'),
      ]);
      const report: RunReport = {
        formatVersion: 2,
        reportId,
        runId: null,
        startedAt,
        finishedAt: null,
        state: 'running',
        provenance: { source: 'cli', omitted: ['credentials', 'raw_sdk_objects'] },
        application: {
          name: metadata.name,
          version: metadata.version,
          nodeVersion: process.version,
          sdkVersions: { [options.provider]: sdkVersion, zod: zodVersion },
        },
        ticket: { id: ticketId, text: options.text, normalizedText: options.normalizedText },
        invocation: {
          workingDirectory: process.cwd(),
          inputSource: options.inputSource,
          provider: options.provider,
          model: options.model,
          promptVersion: options.prompts.version,
        },
        configuration: {
          runtimeSettings: structuredClone(options.runtimeSettings),
          prompts: structuredClone(options.prompts),
          schemas: {
            response: structuredClone(responseJsonSchema),
            moderation: structuredClone(safetyJsonSchema),
          },
          prices: {
            version: options.prices.version,
            hash: options.prices.hash,
            source: options.prices.source,
          },
        },
        response: null,
        trace: null,
        error: null,
        rawOutputs: [],
        humanReview: { status: 'pending', notes: [] },
      };
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
        signal: AbortSignal.timeout(2000),
      });
      return new RunReportWriter(path, report);
    } catch {
      throw new AppError('report_error');
    }
  }

  async finish(result: RunReportResult): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const report: RunReport = {
        ...this.initial,
        ...result,
        state: 'finished',
        runId: result.trace?.requestId ?? null,
        finishedAt: new Date().toISOString(),
      };
      await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
        signal: AbortSignal.timeout(2000),
      });
      await rename(temporary, this.path);
    } catch {
      throw new AppError('report_error');
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
