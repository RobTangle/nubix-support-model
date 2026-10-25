import type { Response } from 'express';
import { AppError } from '../errors.js';
import { streamFrameSchema, type StreamFrame } from './contracts.js';

/** Un escritor por request: ordena frames y aplica backpressure sin crear una cola ilimitada. */
export class HttpEventStream {
  private terminal = false;
  constructor(
    private readonly response: Response,
    private readonly signal: AbortSignal,
  ) {}

  async write(frame: StreamFrame, signal = this.signal): Promise<void> {
    if (this.terminal) throw new AppError('telemetry_error');
    signal.throwIfAborted();
    const text = `${JSON.stringify(streamFrameSchema.parse(frame))}\n`;
    if (Buffer.byteLength(text) > 256 * 1024) throw new AppError('telemetry_error');
    // Marcar antes de escribir evita un segundo terminal si el callback falla tras enviar bytes.
    this.terminal = frame.type === 'result' || frame.type === 'error';
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.response.removeListener('close', closed);
      };
      const finish = (error?: unknown): void => {
        cleanup();
        error ? reject(new AppError('telemetry_error')) : resolve();
      };
      const abort = (): void => finish(new AppError('cancelled'));
      const closed = (): void => finish(new AppError('cancelled'));
      const timer = setTimeout(() => finish(new AppError('telemetry_error')), 2000);
      signal.addEventListener('abort', abort, { once: true });
      this.response.once('close', closed);
      if (signal.aborted) {
        abort();
        return;
      }
      this.response.write(text, (error) => finish(error));
    });
  }
}
