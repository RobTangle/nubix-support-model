#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadPrices } from '../budget.js';
import { readEnvironment, readSettings } from '../config.js';
import { AppError, publicError } from '../errors.js';
import { createEventSink } from '../event-sink.js';
import type { FlowEvent } from '../observability/events.js';
import { loadPrompts, type PromptVersion } from '../prompts.js';
import { createProvider } from '../providers.js';
import { readRuntimeSettings } from '../runtime-settings.js';
import { SupportAssistant } from '../service.js';
import type { TelemetryEvent } from '../telemetry.js';
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
Uso: node dist/web/server.js [--port 3000] [--live] [--env-file archivo] [--telemetry-file eventos.jsonl]
Sin --live usa un proveedor DEMO simulado: no necesita claves ni consume API.
--live habilita llamadas reales para proveedores con claves configuradas y consume saldo.
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
  const environment = values.live ? await readEnvironment(values['env-file']) : {};
  const prices = await loadPrices();
  const prompts = {
    'basic-v1': await loadPrompts('basic-v1'),
    'basic-v2': await loadPrompts('basic-v2'),
  };
  const settings = readRuntimeSettings(values.live ? environment : {});
  const clients = new Map<WebProvider, ReturnType<typeof createProvider>>();
  const models = new Map<WebProvider, string>();
  const configuration: WebConfiguration = {
    mode: values.live ? 'live' : 'demo',
    providers: (Object.keys(defaults) as WebProvider[]).map((provider) => {
      const available = !values.live || Boolean(environment[keys[provider]]?.trim());
      const selected = values.live && available ? readSettings(provider, environment) : null;
      const model = selected?.model ?? defaults[provider];
      if (available) prices.get(provider, model);
      if (selected) clients.set(provider, createProvider(selected));
      models.set(provider, model);
      return { id: provider, label: labels[provider], model, available };
    }),
    promptVersions: ['basic-v1', 'basic-v2'],
    maxConcurrent: 4,
  };
  if (values.live && !configuration.providers.some((provider) => provider.available))
    throw new AppError('missing_key');
  const sink = await createEventSink<TelemetryEvent | FlowEvent>(values['telemetry-file']);
  const app = createApp({
    configuration,
    observe: sink.emit,
    createAssistant(provider: WebProvider, version: PromptVersion) {
      const client = values.live ? clients.get(provider) : new DemoProvider();
      if (!client) throw new AppError('missing_key');
      return new SupportAssistant({
        provider: client,
        providerName: provider,
        model: models.get(provider)!,
        prompts: prompts[version],
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
