import { AppError } from '../errors.js';
import { waitForTelemetry } from '../telemetry.js';
import {
  flowEventSchema,
  type FlowDetails,
  type FlowEvent,
  type FlowEventName,
  type FlowSink,
} from './events.js';

type Identity = Pick<FlowEvent, 'requestId' | 'provider' | 'model' | 'promptVersion'>;
interface Clock {
  now(): number;
  timestamp(): Date;
}
type Scope = Partial<Pick<FlowEvent, 'stage' | 'attempt' | 'durationMs'>>;

/** Un registrador por corrida; el servicio no conoce JSONL, Express ni elementos del navegador. */
export class RunObserver {
  private sequence = 0;
  private readonly started: number;

  constructor(
    private readonly identity: Identity,
    private readonly sink?: FlowSink,
    private readonly clock: Clock = { now: () => performance.now(), timestamp: () => new Date() },
    private readonly signal?: AbortSignal,
  ) {
    this.started = clock.now();
  }

  now(): number {
    return this.clock.now();
  }

  async emit(event: FlowEventName, details: FlowDetails = {}, scope: Scope = {}): Promise<void> {
    if (!this.sink) return;
    const value = flowEventSchema.parse({
      ...this.identity,
      schemaVersion: 1,
      sequence: ++this.sequence,
      timestamp: this.clock.timestamp().toISOString(),
      elapsedMs: Math.max(0, this.clock.now() - this.started),
      durationMs: scope.durationMs ?? null,
      event,
      ...scope,
      details,
    });
    try {
      const pending = Promise.resolve().then(() => this.sink!(value, this.signal));
      await waitForTelemetry(pending, this.signal ?? AbortSignal.timeout(1000));
    } catch {
      throw new AppError('telemetry_error');
    }
  }
}
