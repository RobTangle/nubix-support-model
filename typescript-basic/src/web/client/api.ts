import type { z } from 'zod';
import { webConfigurationSchema } from '../contracts.js';
import { readSupportStream, type StreamFrame } from './stream-reader.js';

export type WebConfiguration = z.infer<typeof webConfigurationSchema>;
export interface SupportInput {
  text: string;
  provider: string;
  promptVersion: string;
}

/** Transporte del navegador: el resto de la interfaz no conoce fetch ni el formato JSONL. */
export class SupportApi {
  // La función flecha conserva la invocación global; guardar window.fetch y llamarlo como
  // this.request cambiaría su receptor a esta clase y algunos navegadores lo rechazan.
  constructor(private readonly request: typeof fetch = (input, init) => fetch(input, init)) {}

  async configuration(signal?: AbortSignal): Promise<WebConfiguration> {
    try {
      const response = await this.request('/api/config', { ...(signal ? { signal } : {}) });
      if (!response.ok) throw new Error('configuration');
      return webConfigurationSchema.parse(await response.json());
    } catch {
      throw new Error(
        'No se pudo cargar la configuración del servidor. Comprobá que siga iniciado.',
      );
    }
  }

  async run(
    input: SupportInput,
    signal: AbortSignal,
    onFrame: (frame: StreamFrame) => void,
  ): Promise<void> {
    let response: Response;
    try {
      response = await this.request('/api/support/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify(input),
        signal,
      });
    } catch {
      if (signal.aborted) throw new DOMException('La consulta fue cancelada.', 'AbortError');
      throw new Error('No se pudo conectar con el servidor. Revisá la conexión local.');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(
        response.status === 429
          ? 'El servidor está ocupado. Esperá a que termine otra ejecución e intentá nuevamente.'
          : `El servidor rechazó la consulta (HTTP ${response.status}). Revisá el ticket y la configuración.`,
      );
    }
    if (!response.headers.get('content-type')?.includes('application/x-ndjson')) {
      await response.body?.cancel().catch(() => {});
      throw new Error('El servidor no devolvió un flujo JSONL válido.');
    }
    await readSupportStream(response, signal, onFrame);
  }
}
