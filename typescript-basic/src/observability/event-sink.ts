/**
 * Transporte de telemetría: convierte eventos en líneas para stderr y un archivo opcional.
 * Implementa el destino que recibe la aplicación por inyección; así el caso de uso emite eventos
 * sin depender de archivos, streams de terminal ni detalles de cierre de esos recursos.
 */
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AppError } from '../errors.js';
import type { TelemetryEvent } from './telemetry.js';
import type { FlowEvent } from './events.js';
import { waitForTelemetry } from './telemetry.js';

/**
 * Crea un destino (sink) de eventos: siempre escribe en stderr y opcionalmente en un archivo.
 * stdout queda disponible para la respuesta pública de la CLI y puede conectarse a otro proceso.
 * Aquí stderr transporta diagnósticos informativos además de errores; escribir allí no implica
 * que el comando haya fallado. El código de salida expresa el resultado de la CLI.
 *
 * Cada evento ocupa una línea JSON (JSONL), adecuada para agregar registros y procesarlos después.
 * El archivo usa I/O asíncrono; stderr puede ser síncrono según la plataforma y su destino.
 * La factory devuelve emit/close y ambos conservan handle/pending mediante un closure.
 * Estos eventos contienen metadatos; los reportes completos de testing se escriben por otra vía.
 *
 * @param path Archivo opcional. Se abre en append para conservar eventos de ejecuciones anteriores.
 * @returns emit agrega un evento; close espera lo pendiente e intenta cerrar el archivo.
 */
export async function createEventSink<T extends TelemetryEvent | FlowEvent = TelemetryEvent>(
  path?: string,
): Promise<{
  emit(event: T, signal?: AbortSignal): Promise<void>;
  close(signal?: AbortSignal): Promise<void>;
}> {
  try {
    if (path) await mkdir(dirname(path), { recursive: true });
    // 0o600 solicita lectura/escritura para el propietario en sistemas con permisos Unix.
    const handle = path ? await open(path, 'a', 0o600) : null;
    // Una Promise resuelta permite encadenar también la primera escritura con el mismo mecanismo.
    let pending: Promise<void> = Promise.resolve();
    return {
      emit(event) {
        const line = `${JSON.stringify(event)}\n`;
        // stderr empieza a escribirse ahora; la cola que sigue ordena los append del archivo.
        // El callback confirma esa escritura o su error, sin usar el booleano de backpressure.
        const output = new Promise<void>((resolve, reject) =>
          process.stderr.write(line, (error) => (error ? reject(error) : resolve())),
        );
        // Registrar el rechazo desde ahora evita un unhandledRejection mientras espera el archivo.
        const outputDone = output.then(
          () => null,
          () => new AppError('telemetry_error'),
        );
        // Cada append espera al anterior dentro de ESTA instancia. No es un bloqueo de archivo
        // entre procesos ni coordina otros sinks que abran la misma ruta. Un rechazo deja la cola
        // fallida: el llamador recibe telemetry_error y debe cerrar el sink, no ignorar el fallo.
        pending = pending
          .then(async () => {
            // El escritor puede compartirse entre tickets: una cancelación individual no debe
            // abortar el archivo y envenenar esta cola. El llamador acota su espera por separado.
            if (handle) await handle.appendFile(line, { encoding: 'utf8' });
            const failure = await outputDone;
            if (failure) throw failure;
          })
          .catch(() => {
            throw new AppError('telemetry_error');
          });
        return pending;
      },
      async close(signal = AbortSignal.timeout(1000)) {
        // finally intenta cerrar incluso si falló la cola. El segundo de timeout limita la espera
        // del llamador; el cierre subyacente puede terminar después si todavía hay I/O pendiente.
        const closing = pending.finally(() => handle?.close());
        return waitForTelemetry(closing, signal);
      },
    };
  } catch {
    throw new AppError('telemetry_error');
  }
}
