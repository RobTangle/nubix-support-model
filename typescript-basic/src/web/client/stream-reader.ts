import type { z } from 'zod';
import { streamFrameSchema } from '../contracts.js';

export type StreamFrame = z.infer<typeof streamFrameSchema>;
interface StreamLimits {
  maxLineBytes?: number;
  maxFrames?: number;
}

/** Un stream cerrado no prueba éxito: exigimos un único frame terminal y coherencia de identidad. */
export class StreamProtocolError extends Error {
  constructor() {
    super('El flujo recibido está incompleto o no cumple el contrato de eventos.');
    this.name = 'StreamProtocolError';
  }
}

/**
 * fetch entrega chunks arbitrarios: una línea o un carácter UTF-8 pueden atravesar varios.
 * El decodificador conserva bytes pendientes y Zod valida cada objeto antes de mostrarlo.
 */
export async function readSupportStream(
  response: Response,
  signal: AbortSignal,
  onFrame: (frame: StreamFrame) => void,
  limits: StreamLimits = {},
): Promise<void> {
  if (!response.body) throw new StreamProtocolError();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  // El contrato permite seis textos de 4000 puntos Unicode; el límite contempla sus bytes UTF-8.
  const maxLine = limits.maxLineBytes ?? 262_144;
  const maxFrames = limits.maxFrames ?? 500;
  let buffer = '';
  let requestId: string | undefined;
  let mode: string | undefined;
  let sequence = 0;
  let inspectionSequence = 0;
  let elapsed = 0;
  let count = 0;
  let terminal: StreamFrame | undefined;
  let exhausted = false;
  const abort = (): void => {
    void reader.cancel().catch(() => {});
  };
  const acceptLine = (line: string): void => {
    if (!line.trim()) return;
    if (terminal || encoder.encode(line).byteLength > maxLine || ++count > maxFrames)
      throw new StreamProtocolError();
    const frame = streamFrameSchema.parse(JSON.parse(line));
    if (frame.type === 'accepted') {
      if (requestId) throw new StreamProtocolError();
      requestId = frame.requestId;
      mode = frame.mode;
    } else {
      const id =
        frame.type === 'event'
          ? frame.event.requestId
          : frame.type === 'inspection'
            ? frame.inspection.requestId
            : frame.requestId;
      if (!requestId || id !== requestId) throw new StreamProtocolError();
      if (frame.type === 'event') {
        if (frame.event.sequence !== sequence + 1 || frame.event.elapsedMs < elapsed)
          throw new StreamProtocolError();
        sequence = frame.event.sequence;
        elapsed = frame.event.elapsedMs;
      } else if (frame.type === 'inspection') {
        if (frame.inspection.sequence !== inspectionSequence + 1) throw new StreamProtocolError();
        inspectionSequence = frame.inspection.sequence;
      } else {
        if (frame.type === 'result' && (frame.mode !== mode || frame.trace.requestId !== requestId))
          throw new StreamProtocolError();
        terminal = frame;
        return;
      }
    }
    onFrame(frame);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        acceptLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
      if (encoder.encode(buffer).byteLength > maxLine) throw new StreamProtocolError();
      if (chunk.done) break;
    }
    if (buffer.trim()) acceptLine(buffer);
    if (!terminal) throw new StreamProtocolError();
    onFrame(terminal);
    exhausted = true;
  } catch (error) {
    if (signal.aborted) throw new DOMException('La consulta fue cancelada.', 'AbortError');
    if (error instanceof StreamProtocolError) throw error;
    throw new StreamProtocolError();
  } finally {
    signal.removeEventListener('abort', abort);
    if (!exhausted) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
