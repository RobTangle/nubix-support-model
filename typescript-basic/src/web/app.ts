import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler } from 'express';
import { AppError, publicError } from '../errors.js';
import type { ProcessOptions, SupportRun } from '../service.js';
import type { FlowSink } from '../observability/events.js';
import { HttpEventStream } from './http-stream.js';
import {
  webConfigurationSchema,
  webRequestSchema,
  type WebConfiguration,
  type WebProvider,
  type WebPrompt,
} from './contracts.js';

interface SupportTarget {
  process(input: unknown, options?: ProcessOptions): Promise<SupportRun>;
}
export interface WebApplicationOptions {
  configuration: WebConfiguration;
  createAssistant(
    provider: WebProvider,
    promptVersion: WebPrompt,
  ): SupportTarget | Promise<SupportTarget>;
  maxConcurrent?: number;
  observe?: FlowSink;
  streamTimeoutMs?: number;
}

/** Adaptador HTTP: sólo conoce transporte y límites; el caso de uso sigue en SupportAssistant. */
export function createApp(options: WebApplicationOptions) {
  const configuration = webConfigurationSchema.parse({
    ...options.configuration,
    maxConcurrent: options.maxConcurrent ?? options.configuration.maxConcurrent,
  });
  const app = express();
  const timeoutMs = options.streamTimeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new AppError('configuration_error');
  let active = 0;
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    const host = request.headers.host;
    const localPort = request.socket.localPort;
    const allowed = new Set([
      `127.0.0.1:${localPort}`,
      `localhost:${localPort}`,
      `[::1]:${localPort}`,
    ]);
    if (
      !host ||
      !allowed.has(host.toLowerCase()) ||
      (request.headers.origin && request.headers.origin !== `http://${host}`) ||
      request.headers['sec-fetch-site'] === 'cross-site'
    ) {
      response.status(403).json({
        error: {
          code: 'forbidden',
          message: 'El panel sólo acepta solicitudes del mismo origen local.',
        },
      });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '128kb', strict: true }));
  app.get('/api/config', (_request, response) => {
    response.json(configuration);
  });
  app.post('/api/support/stream', async (request, response) => {
    const parsed = webRequestSchema.safeParse(request.body);
    if (
      !request.is('application/json') ||
      !parsed.success ||
      !configuration.providers.some(
        (provider) => provider.id === parsed.data.provider && provider.available,
      ) ||
      !configuration.promptVersions.includes(parsed.data.promptVersion)
    ) {
      response.status(400).json(publicError(new AppError('invalid_input')));
      return;
    }
    if (active >= configuration.maxConcurrent) {
      response.setHeader('Retry-After', '1');
      response.status(429).json({
        error: { code: 'busy', message: 'Se alcanzó el límite de ejecuciones simultáneas.' },
      });
      return;
    }
    active++;
    const requestId = randomUUID();
    const receivedAt = new Date().toISOString();
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([controller.signal, deadline]);
    const onClose = (): void => {
      if (!response.writableFinished) controller.abort();
    };
    response.once('close', onClose);
    response
      .status(200)
      .set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
    response.flushHeaders();
    const stream = new HttpEventStream(response, signal);
    try {
      await stream.write({ type: 'accepted', requestId, mode: configuration.mode, receivedAt });
      const assistant = await options.createAssistant(
        parsed.data.provider,
        parsed.data.promptVersion,
      );
      const result = await assistant.process(
        { text: parsed.data.text },
        {
          requestId,
          signal,
          observe: async (event, eventSignal) => {
            await options.observe?.(event, eventSignal);
            await stream.write({ type: 'event', event });
          },
        },
      );
      await stream.write({
        type: 'result',
        requestId,
        mode: configuration.mode,
        response: result.response,
        trace: result.trace,
      });
    } catch (error) {
      if (!controller.signal.aborted && !response.destroyed) {
        try {
          // El deadline del trabajo venció, pero un cliente conectado todavía puede recibir
          // un error terminal con una ventana de escritura independiente y acotada.
          await stream.write(
            {
              type: 'error',
              requestId,
              error: publicError(deadline.aborted ? new AppError('deadline_exceeded') : error)
                .error,
            },
            AbortSignal.timeout(500),
          );
        } catch {
          response.destroy();
        }
      }
    } finally {
      active--;
      response.removeListener('close', onClose);
      if (!response.destroyed) response.end();
    }
  });
  app.use(
    express.static(fileURLToPath(new URL('./public/', import.meta.url)), {
      dotfiles: 'deny',
      index: 'index.html',
    }),
  );
  app.use((_request, response) => {
    response.status(404).json({ error: { code: 'not_found', message: 'Recurso no encontrado.' } });
  });
  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    const tooLarge = error instanceof Error && 'type' in error && error.type === 'entity.too.large';
    response.status(tooLarge ? 413 : 400).json(publicError(new AppError('invalid_input')));
  };
  app.use(errorHandler);
  return app;
}
