import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { AppError, publicError } from '../errors.js';
import type { ProcessOptions, SupportRun } from '../support/service.js';
import type { FlowSink } from '../observability/events.js';
import { inspectionEntrySchema, type InspectionEntry } from '../inspection/contracts.js';
import type { LabStore } from '../lab/storage.js';
import { labHistoryQuerySchema } from '../lab/contracts.js';
import type { LabEvaluationService } from '../lab/evaluations.js';
import { evaluationRoutes } from './evaluation-routes.js';
import { RequestTracker } from './request-tracker.js';
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
  store?: LabStore;
  evaluations?: LabEvaluationService;
}

/** Adaptador HTTP: sólo conoce transporte y límites; el caso de uso sigue en SupportAssistant. */
export function createApp(options: WebApplicationOptions) {
  const configuration = webConfigurationSchema.parse({
    ...options.configuration,
    maxConcurrent: options.maxConcurrent ?? options.configuration.maxConcurrent,
  });
  const app = express();
  const requests = new RequestTracker();
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
  if (options.evaluations) app.use('/api/evaluations', evaluationRoutes(options.evaluations));

  app.get('/api/config', (_request, response) => {
    response.json(configuration);
  });

  app.get('/api/history', (request, response) => {
    const parsed = labHistoryQuerySchema
      .extend({
        // z.coerce.boolean convertiría "false" en true: HTTP admite sólo estos literales.
        includeEvaluationCases: z
          .enum(['true', 'false'])
          .transform((value) => value === 'true')
          .optional(),
        limit: z
          .string()
          .regex(/^\d+$/u)
          .transform(Number)
          .pipe(z.number().int().min(1).max(100))
          .optional(),
        offset: z
          .string()
          .regex(/^\d+$/u)
          .transform(Number)
          .pipe(z.number().int().min(0).max(1_000_000))
          .optional(),
      })
      .pipe(labHistoryQuerySchema)
      .safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json(publicError(new AppError('invalid_input')));
      return;
    }
    try {
      response.json(
        options.store?.listRuns(parsed.data) ?? {
          items: [],
          total: 0,
          filterOptions: { providers: [], promptVersions: [] },
        },
      );
    } catch {
      response.status(503).json(publicError(new AppError('report_error')));
    }
  });

  app.get('/api/history/:id', (request, response) => {
    try {
      const id = z.uuid().safeParse(request.params.id);
      const detail = id.success ? options.store?.getRun(id.data) : null;
      if (!detail) {
        response
          .status(404)
          .json({ error: { code: 'not_found', message: 'Recurso no encontrado.' } });
        return;
      }
      response.json(detail);
    } catch {
      response.status(503).json(publicError(new AppError('report_error')));
    }
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
    const requestId = randomUUID();
    const receivedAt = new Date().toISOString();
    try {
      options.store?.createRun({
        id: requestId,
        kind: 'support',
        mode: configuration.mode,
        provider: parsed.data.provider,
        model: configuration.providers.find((provider) => provider.id === parsed.data.provider)!
          .model,
        promptVersion: parsed.data.promptVersion,
        input: request.body,
      });
    } catch {
      response.status(503).json(publicError(new AppError('report_error')));
      return;
    }
    active++;
    let persistedTerminal = false;
    const controller = new AbortController();
    const finishRequest = requests.track(controller);
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
    let inspectionSequence = 0;
    // El borde HTTP agrega su body al canal de inspección; renumera ese canal completo
    // sin cambiar los contadores ni el contrato de eventos del caso de uso.
    const inspect = async (entry: InspectionEntry): Promise<void> => {
      const inspection = { ...entry, sequence: ++inspectionSequence };
      options.store?.appendInspection(requestId, inspection);
      await stream.write({ type: 'inspection', inspection });
    };
    try {
      await stream.write({ type: 'accepted', requestId, mode: configuration.mode, receivedAt });
      await inspect(
        inspectionEntrySchema.parse({
          requestId,
          sequence: 1,
          timestamp: receivedAt,
          kind: 'http.request',
          data: {
            body: request.body,
            schema: z.toJSONSchema(webRequestSchema),
            localRules: {
              maxUnicodePointsBeforeTrim: 8000,
              bodyLimitBytes: 131072,
              sameOriginOnly: true,
            },
          },
        }),
      );
      const assistant = await options.createAssistant(
        parsed.data.provider,
        parsed.data.promptVersion,
      );
      const result = await assistant.process(
        { text: request.body.text },
        {
          requestId,
          signal,
          observe: async (event, eventSignal) => {
            options.store?.appendEvent(requestId, event);
            await options.observe?.(event, eventSignal);
            await stream.write({ type: 'event', event });
          },
          inspect,
        },
      );
      if (signal.aborted)
        throw new AppError(deadline.aborted ? 'deadline_exceeded' : 'cancelled', {
          trace: result.trace,
        });
      options.store?.finishRun(requestId, { status: 'completed', result });
      persistedTerminal = true;
      await stream.write({
        type: 'result',
        requestId,
        mode: configuration.mode,
        response: result.response,
        trace: result.trace,
      });
    } catch (error) {
      let safe = publicError(
        deadline.aborted
          ? new AppError('deadline_exceeded')
          : controller.signal.aborted
            ? new AppError('cancelled')
            : error,
      ).error;
      if (!persistedTerminal) {
        try {
          options.store?.finishRun(requestId, {
            status: controller.signal.aborted ? 'cancelled' : 'failed',
            result: error instanceof AppError && error.trace ? { trace: error.trace } : null,
            error: safe,
          });
          persistedTerminal = true;
        } catch {
          safe = publicError(new AppError('report_error')).error;
        }
      }
      if (!controller.signal.aborted && !response.destroyed) {
        try {
          // El deadline del trabajo venció, pero un cliente conectado todavía puede recibir
          // un error terminal con una ventana de escritura independiente y acotada.
          await stream.write(
            {
              type: 'error',
              requestId,
              error: safe,
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
      finishRequest();
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

  return Object.assign(app, { drain: () => requests.drain() });
}
