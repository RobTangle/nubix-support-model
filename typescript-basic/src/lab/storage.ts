import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AppError, publicError, type ErrorCode } from '../errors.js';
import { flowEventSchema, type FlowEvent } from '../observability/events.js';
import { inspectionEntrySchema, type InspectionEntry } from '../inspection/contracts.js';
import { evaluationReportSchema, type EvaluationReport } from '../evals/types.js';
import { humanReviewSchema, validateReviews, type HumanReview } from '../evals/reviews.js';
import {
  labErrorSchema,
  labJsonSchema,
  labRunDetailSchema,
  labRunSummarySchema,
  type LabRunDetail,
  type LabRunSummary,
} from './contracts.js';

const createRunSchema = labRunSummarySchema
  .pick({ id: true, kind: true, mode: true, provider: true, model: true, promptVersion: true })
  .extend({ input: labJsonSchema, parentId: z.uuid().nullable().optional() });
const finishRunSchema = z.strictObject({
  status: z.enum(['completed', 'failed', 'cancelled', 'interrupted']),
  result: labJsonSchema.nullable().optional(),
  error: labErrorSchema.nullable().optional(),
});
const paginationSchema = z.strictObject({
  kind: z.enum(['support', 'evaluation']).optional(),
  limit: z.number().int().min(1).max(100).default(30),
  offset: z.number().int().min(0).max(1_000_000).default(0),
});
type CreateRunInput = Omit<z.input<typeof createRunSchema>, 'input'> & { input: unknown };
type FinishRunInput = Omit<z.input<typeof finishRunSchema>, 'result'> & { result?: unknown };
type ListRunsInput = z.input<typeof paginationSchema>;

/** SQLite local: operaciones breves, contratos validados y errores sin contenido del disco. */
export class LabStore {
  private readonly database: DatabaseSync;
  private readonly owner = randomUUID();
  private closed = false;

  constructor(path: string) {
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(path);
      this.database = database;
      database.exec(
        'PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;',
      );
      const version = database.prepare('PRAGMA user_version').get()!['user_version'];
      if (version !== 0 && version !== 1) throw new AppError('report_error');
      if (version === 0)
        database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE runs (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, mode TEXT NOT NULL,
          provider TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL,
          status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT,
          parent_id TEXT REFERENCES runs(id), input_json TEXT NOT NULL,
          result_json TEXT, error_json TEXT, owner_pid INTEGER NOT NULL, owner_token TEXT NOT NULL
        );
        CREATE INDEX runs_history ON runs(kind, created_at DESC, id DESC);
        CREATE TABLE events (run_id TEXT NOT NULL REFERENCES runs(id), sequence INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run_id, sequence));
        CREATE TABLE inspections (run_id TEXT NOT NULL REFERENCES runs(id), sequence INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run_id, sequence));
        CREATE TABLE reports (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES runs(id), payload TEXT NOT NULL);
        CREATE INDEX reports_job ON reports(job_id);
        CREATE TABLE reviews (report_id TEXT NOT NULL REFERENCES reports(id), case_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(report_id, case_id));
        PRAGMA user_version = 1;
        COMMIT;
      `);
      const owners = database
        .prepare("SELECT DISTINCT owner_pid FROM runs WHERE status = 'running'")
        .all();
      for (const row of owners) {
        const pid = z.number().int().positive().parse(row['owner_pid']);
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') continue;
          database
            .prepare(
              "UPDATE runs SET status = 'interrupted', finished_at = ? WHERE status = 'running' AND owner_pid = ?",
            )
            .run(new Date().toISOString(), pid);
        }
      }
    } catch {
      try {
        database?.close();
      } catch {
        /* El constructor conserva el error sanitizado original. */
      }
      throw new AppError('report_error');
    }
  }

  private operation<T>(work: () => T): T {
    try {
      if (this.closed) throw new AppError('report_error');
      return work();
    } catch {
      throw new AppError('report_error');
    }
  }

  private json(value: unknown, maximum = 8 * 1024 * 1024): string {
    const encoded = JSON.stringify(labJsonSchema.parse(value));
    if (Buffer.byteLength(encoded) > maximum) throw new AppError('report_error');
    return encoded;
  }

  createRun(input: CreateRunInput): LabRunSummary {
    return this.operation(() => {
      const parsed = createRunSchema.parse(input);
      const { input: body, ...metadata } = parsed;
      const summary = labRunSummarySchema.parse({
        ...metadata,
        status: 'running',
        createdAt: new Date().toISOString(),
        finishedAt: null,
        parentId: parsed.parentId ?? null,
      });
      this.database
        .prepare(
          'INSERT INTO runs (id, kind, mode, provider, model, prompt_version, status, created_at, finished_at, parent_id, input_json, owner_pid, owner_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          summary.id,
          summary.kind,
          summary.mode,
          summary.provider,
          summary.model,
          summary.promptVersion,
          summary.status,
          summary.createdAt,
          summary.finishedAt,
          summary.parentId,
          this.json(body, 128 * 1024),
          process.pid,
          this.owner,
        );
      return summary;
    });
  }

  appendEvent(id: string, event: FlowEvent): void {
    this.operation(() => {
      const parsed = flowEventSchema.parse(event);
      this.append('events', id, parsed.requestId, parsed.sequence, this.json(parsed), 4096);
    });
  }

  appendInspection(id: string, entry: InspectionEntry): void {
    this.operation(() => {
      const parsed = inspectionEntrySchema.parse(entry);
      this.append(
        'inspections',
        id,
        parsed.requestId,
        parsed.sequence,
        this.json(parsed, 512 * 1024),
        512,
      );
    });
  }

  private append(
    table: 'events' | 'inspections',
    id: string,
    requestId: string,
    sequence: number,
    payload: string,
    maximum: number,
  ): void {
    z.uuid().parse(id);
    if (id !== requestId || sequence > maximum) throw new AppError('report_error');
    const result = this.database
      .prepare(
        `INSERT INTO ${table} (run_id, sequence, payload) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND status = 'running') AND ? = (SELECT COALESCE(MAX(sequence), 0) + 1 FROM ${table} WHERE run_id = ?)`,
      )
      .run(id, sequence, payload, id, sequence, id);
    if (result.changes !== 1) throw new AppError('report_error');
  }

  finishRun(id: string, input: FinishRunInput): void {
    this.operation(() => {
      z.uuid().parse(id);
      const parsed = finishRunSchema.parse(input);
      const safeError = parsed.error
        ? labErrorSchema.parse(publicError(new AppError(parsed.error.code as ErrorCode)).error)
        : null;
      const result = this.database
        .prepare(
          "UPDATE runs SET status = ?, result_json = ?, error_json = ?, finished_at = ? WHERE id = ? AND status = 'running'",
        )
        .run(
          parsed.status,
          parsed.result == null ? null : this.json(parsed.result),
          safeError ? this.json(safeError) : null,
          new Date().toISOString(),
          id,
        );
      if (result.changes !== 1) throw new AppError('report_error');
    });
  }

  private summary(row: Record<string, unknown>): LabRunSummary {
    return labRunSummarySchema.parse({
      id: row['id'],
      kind: row['kind'],
      mode: row['mode'],
      provider: row['provider'],
      model: row['model'],
      promptVersion: row['prompt_version'],
      status: row['status'],
      createdAt: row['created_at'],
      finishedAt: row['finished_at'],
      parentId: row['parent_id'],
    });
  }

  listRuns(input: ListRunsInput = {}): { items: LabRunSummary[]; total: number } {
    return this.operation(() => {
      const parsed = paginationSchema.parse(input);
      const rows = this.database
        .prepare(
          'SELECT * FROM runs WHERE (? IS NULL OR kind = ?) ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
        )
        .all(parsed.kind ?? null, parsed.kind ?? null, parsed.limit, parsed.offset);
      const total = this.database
        .prepare('SELECT COUNT(*) AS total FROM runs WHERE (? IS NULL OR kind = ?)')
        .get(parsed.kind ?? null, parsed.kind ?? null)!['total'];
      return {
        items: rows.map((row) => this.summary(row)),
        total: z.number().int().nonnegative().parse(total),
      };
    });
  }

  getRun(id: string): LabRunDetail | null {
    return this.operation(() => {
      z.uuid().parse(id);
      const row = this.database.prepare('SELECT * FROM runs WHERE id = ?').get(id);
      if (!row) return null;
      return labRunDetailSchema.parse({
        ...this.summary(row),
        input: JSON.parse(String(row['input_json'])),
        result: row['result_json'] == null ? null : JSON.parse(String(row['result_json'])),
        error: row['error_json'] == null ? null : JSON.parse(String(row['error_json'])),
        events: this.database
          .prepare('SELECT payload FROM events WHERE run_id = ? ORDER BY sequence')
          .all(id)
          .map((event) => JSON.parse(String(event['payload']))),
        inspections: this.database
          .prepare('SELECT payload FROM inspections WHERE run_id = ? ORDER BY sequence')
          .all(id)
          .map((entry) => JSON.parse(String(entry['payload']))),
      });
    });
  }

  saveReport(jobId: string, report: EvaluationReport): void {
    this.operation(() => {
      z.uuid().parse(jobId);
      const parsed = evaluationReportSchema.parse(report);
      const result = this.database
        .prepare(
          "INSERT INTO reports (id, job_id, payload) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND kind = 'evaluation') ON CONFLICT(id) DO UPDATE SET payload = excluded.payload WHERE reports.job_id = excluded.job_id",
        )
        .run(parsed.runId, jobId, this.json(parsed, 16 * 1024 * 1024), jobId);
      if (result.changes !== 1) throw new AppError('report_error');
    });
  }

  getReports(jobId: string): EvaluationReport[] {
    return this.operation(() => {
      z.uuid().parse(jobId);
      return this.database
        .prepare('SELECT payload FROM reports WHERE job_id = ? ORDER BY rowid')
        .all(jobId)
        .map((row) => evaluationReportSchema.parse(JSON.parse(String(row['payload']))));
    });
  }

  saveReview(reportId: string, review: HumanReview): void {
    this.operation(() => {
      z.uuid().parse(reportId);
      const row = this.database.prepare('SELECT payload FROM reports WHERE id = ?').get(reportId);
      if (!row) throw new AppError('report_error');
      const report = evaluationReportSchema.parse(JSON.parse(String(row['payload'])));
      const parsed = validateReviews([report], [humanReviewSchema.parse(review)])[0]!;
      if (parsed.runId !== reportId) throw new AppError('report_error');
      this.database
        .prepare(
          'INSERT INTO reviews (report_id, case_id, payload) VALUES (?, ?, ?) ON CONFLICT(report_id, case_id) DO UPDATE SET payload = excluded.payload',
        )
        .run(reportId, parsed.caseId, this.json(parsed));
    });
  }

  getReviews(reportId: string): HumanReview[] {
    return this.operation(() => {
      z.uuid().parse(reportId);
      const rows = this.database
        .prepare('SELECT payload FROM reviews WHERE report_id = ? ORDER BY case_id')
        .all(reportId);
      const reviews = rows.map((row) =>
        humanReviewSchema.parse(JSON.parse(String(row['payload']))),
      );
      if (!reviews.length) return reviews;
      const report = this.database
        .prepare('SELECT payload FROM reports WHERE id = ?')
        .get(reportId)!;
      return validateReviews(
        [evaluationReportSchema.parse(JSON.parse(String(report['payload'])))],
        reviews,
      );
    });
  }

  close(): void {
    if (this.closed) return;
    this.operation(() => {
      this.database
        .prepare(
          "UPDATE runs SET status = 'interrupted', finished_at = ? WHERE owner_token = ? AND status = 'running'",
        )
        .run(new Date().toISOString(), this.owner);
      this.database.close();
      this.closed = true;
    });
  }
}
