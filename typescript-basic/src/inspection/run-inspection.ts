import { AppError } from '../errors.js';
import { waitForTelemetry } from '../observability/telemetry.js';
import { inspectionEntrySchema, type InspectionEntry, type InspectionSink } from './contracts.js';

/** Captura optativa para el laboratorio local. Nunca se conecta al logger de operación. */
export class RunInspection {
  private sequence = 0;

  constructor(
    private readonly requestId: string,
    private readonly sink?: InspectionSink,
    private readonly signal?: AbortSignal,
  ) {}

  async record(
    kind: InspectionEntry['kind'],
    data: unknown,
    scope: Partial<Pick<InspectionEntry, 'stage' | 'attempt'>> = {},
  ): Promise<void> {
    if (!this.sink) return;
    try {
      if (this.sequence >= 200) throw new AppError('report_error');
      const serialized = JSON.stringify(data);
      const bounded =
        serialized && Buffer.byteLength(serialized, 'utf8') > 196_608
          ? { truncated: true, preview: serialized.slice(0, 12_000) }
          : data;
      const entry = inspectionEntrySchema.parse({
        requestId: this.requestId,
        sequence: ++this.sequence,
        timestamp: new Date().toISOString(),
        kind,
        ...scope,
        data: bounded,
      });
      await waitForTelemetry(
        Promise.resolve().then(() => this.sink!(entry, this.signal)),
        this.signal ?? AbortSignal.timeout(1000),
      );
    } catch {
      throw new AppError('report_error');
    }
  }
}
