#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadPrices } from '../costs/budget.js';
import { readEnvironment, readSettings } from '../config/environment.js';
import { AppError, publicError } from '../errors.js';
import { createEventSink } from '../observability/event-sink.js';
import type { FlowEvent } from '../observability/events.js';
import type { PromptVersion } from '../prompting/prompts.js';
import { PromptRegistry } from '../prompting/prompt-registry.js';
import { createProvider } from '../llm/providers.js';
import { readRuntimeSettings } from '../config/runtime-settings.js';
import { SupportAssistant } from '../support/service.js';
import { createGenerationOnlyBaseline } from '../evals/ablation.js';
import { LabStore } from '../lab/storage.js';
import { LabEvaluationService } from '../lab/evaluations.js';
import type { TelemetryEvent } from '../observability/telemetry.js';
import { createApp } from './app.js';
import { DemoProvider } from './demo-provider.js';
import type { WebConfiguration, WebProvider } from './contracts.js';

const defaults = {
  openai: 'gpt-6-luna',
  xai: 'grok-4.20-0309-non-reasoning',
  'google-ai': 'gemini-3.5-flash-lite',
};
const labels = { openai: 'OpenAI', xai: 'xAI', 'google-ai': 'Google AI' };
const keys = { openai: 'OPENAI_API_KEY', xai: 'XAI_API_KEY', 'google-ai': 'GEMINI_API_KEY' };
const help = `Nubbix: panel local de observabilidad.
Uso: node dist/web/server.js [--port 3000] [--demo] [--env-file archivo] [--database archivo.sqlite] [--telemetry-file eventos.jsonl]
LIVE por defecto: usa las claves configuradas y consume saldo al enviar tickets/evaluaciones.
--demo usa un proveedor simulado sin consumo de API. --live se conserva como alias explícito.
El servidor se vincula únicamente a 127.0.0.1; no es un servicio público autenticado.
Los eventos de metadatos se escriben en stderr y opcionalmente en --telemetry-file.
`;

/** Composition root: cargar recursos y clientes una vez; cada request conserva su estado propio. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  let values;
  try {
    values = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        port: { type: 'string', default: '3000' },
        live: { type: 'boolean' },
        demo: { type: 'boolean' },
        database: { type: 'string' },
        'env-file': { type: 'string' },
        'telemetry-file': { type: 'string' },
        help: { type: 'boolean' },
      },
    }).values;
  } catch {
    throw new AppError('invalid_arguments');
  }
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  if (!/^\d+$/u.test(values.port) || Number(values.port) < 1 || Number(values.port) > 65535)
    throw new AppError('invalid_arguments');
  if (values.live && values.demo) throw new AppError('invalid_arguments');
  const live = !values.demo;
  const environment = live ? await readEnvironment(values['env-file']) : {};
  const prices = await loadPrices();
  const registry = await PromptRegistry.load();
  const settings = readRuntimeSettings(environment);
  const clients = new Map<WebProvider, ReturnType<typeof createProvider>>();
  const models = new Map<WebProvider, string>();
  const configuration: WebConfiguration = {
    mode: live ? 'live' : 'demo',
    providers: (Object.keys(defaults) as WebProvider[]).map((provider) => {
      const available = !live || Boolean(environment[keys[provider]]?.trim());
      const selected = live && available ? readSettings(provider, environment) : null;
      const model = selected?.model ?? defaults[provider];
      if (available) prices.get(provider, model);
      if (selected) clients.set(provider, createProvider(selected));
      models.set(provider, model);
      return { id: provider, label: labels[provider], model, available };
    }),
    promptVersions: registry.versions.map((entry) => entry.id),
    prompts: [...registry.versions],
    defaultPromptVersion: registry.defaultVersion,
    baselinePromptVersion: registry.baselineVersion,
    maxConcurrent: 4,
  };
  if (live && !configuration.providers.some((provider) => provider.available))
    throw new AppError('missing_key');
  const databasePath =
    values.database ?? fileURLToPath(new URL('../../data/lab.sqlite', import.meta.url));
  await mkdir(dirname(databasePath), { recursive: true });
  const store = new LabStore(databasePath);
  const sink = await createEventSink<TelemetryEvent | FlowEvent>(values['telemetry-file']);
  const evaluations = new LabEvaluationService({
    registry,
    store,
    mode: configuration.mode,
    models: new Map(
      configuration.providers
        .filter((provider) => provider.available)
        .map((provider) => [provider.id, provider.model]),
    ),
    settings,
    prices,
    outputDir: fileURLToPath(new URL('../../reports/lab-evals/', import.meta.url)),
    factory(provider, context) {
      const client = live ? clients.get(provider) : new DemoProvider();
      if (!client) throw new AppError('missing_key');
      const options = {
        provider: client,
        providerName: provider,
        model: models.get(provider)!,
        prompts: context.prompts,
        prices,
        settings,
        emit: sink.emit,
      };
      return context.mode === 'generation_only'
        ? createGenerationOnlyBaseline(options)
        : new SupportAssistant(options);
    },
  });
  const app = createApp({
    configuration,
    store,
    evaluations,
    observe: sink.emit,
    createAssistant(provider: WebProvider, version: PromptVersion) {
      const client = live ? clients.get(provider) : new DemoProvider();
      if (!client) throw new AppError('missing_key');
      return new SupportAssistant({
        provider: client,
        providerName: provider,
        model: models.get(provider)!,
        prompts: registry.get(version),
        prices,
        settings,
        emit: sink.emit,
      });
    },
  });
  const server = app.listen(Number(values.port), '127.0.0.1', () => {
    process.stderr.write(
      JSON.stringify({
        event: 'web_server.started',
        mode: configuration.mode,
        url: `http://127.0.0.1:${values.port}`,
        maxConcurrent: configuration.maxConcurrent,
      }) + '\n',
    );
  });
  const closeTelemetry = async (): Promise<void> => {
    try {
      await app.drain();
      await evaluations.close();
      store.close();
      await sink.close(AbortSignal.timeout(1000));
    } catch {
      process.stderr.write(JSON.stringify(publicError(new AppError('telemetry_error'))) + '\n');
      process.exitCode = 1;
    }
  };
  server.on('error', () => {
    process.stderr.write(JSON.stringify(publicError(new AppError('configuration_error'))) + '\n');
    process.exitCode = 1;
    void closeTelemetry();
  });
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    server.close(() => {
      void closeTelemetry();
    });
    server.closeAllConnections();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    process.stderr.write(JSON.stringify(publicError(error)) + '\n');
    process.exitCode = 1;
  });
