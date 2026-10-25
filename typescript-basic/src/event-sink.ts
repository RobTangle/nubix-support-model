import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AppError } from './errors.js';
import type { EventSink } from './telemetry.js';
import { waitForTelemetry } from './telemetry.js';

/** Un sink asíncrono evita bloquear el event loop de una futura API con archivos síncronos. */
export async function createEventSink(
  path?: string,
): Promise<{ emit: EventSink; close(signal?: AbortSignal): Promise<void> }> {
  try {
    if (path) await mkdir(dirname(path), { recursive: true });
    const handle = path ? await open(path, 'a', 0o600) : null;
    let pending: Promise<void> = Promise.resolve();
    return {
      emit(event, signal) {
        const line = `${JSON.stringify(event)}\n`;
        const output = new Promise<void>((resolve, reject) =>
          process.stderr.write(line, (error) => (error ? reject(error) : resolve())),
        );
        // Registrar el rechazo desde ahora evita un unhandledRejection mientras espera el archivo.
        const outputDone = output.then(
          () => null,
          () => new AppError('telemetry_error'),
        );
        // Serializar escrituras impide mezclar líneas entre requests concurrentes.
        pending = pending
          .then(async () => {
            if (handle)
              await handle.appendFile(line, { encoding: 'utf8', ...(signal ? { signal } : {}) });
            const failure = await outputDone;
            if (failure) throw failure;
          })
          .catch(() => {
            throw new AppError('telemetry_error');
          });
        return pending;
      },
      async close(signal = AbortSignal.timeout(1000)) {
        const closing = pending.finally(() => handle?.close());
        return waitForTelemetry(closing, signal);
      },
    };
  } catch {
    throw new AppError('telemetry_error');
  }
}
