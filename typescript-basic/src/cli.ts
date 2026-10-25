#!/usr/bin/env node
/**
 * Entrada de terminal para un ticket: interpreta argumentos/stdin, prepara dependencias y publica
 * el resultado. Conecta entorno, cliente, prompts, presupuesto, telemetría y archivo de testing;
 * las decisiones de soporte pertenecen a service.ts para poder reutilizarlas fuera de la terminal.
 */
import { parseArgs } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { readEnvironment, readSettings } from './config.js';
import { AppError, publicError } from './errors.js';
import { createProvider } from './providers.js';
import { loadPrices } from './budget.js';
import { createEventSink } from './event-sink.js';
import { loadPrompts, type PromptVersion } from './prompts.js';
import { readRuntimeSettings } from './runtime-settings.js';
import { ticketSchema, type SupportResponse } from './schemas.js';
import { SupportAssistant } from './service.js';
import { RunReportWriter } from './run-reports/writer.js';
import type { CapturedOutput, RunTrace } from './telemetry.js';

const help = `Nubbix didáctico en TypeScript: clasificar y proponer una respuesta.
Uso: nubbix-support-ts (--text "Consulta" | --stdin) [--provider openai|xai|google-ai]
Opciones:
  --text       Texto de un ticket (máximo 8000 caracteres).
  --stdin      Leer un ticket desde la entrada estándar hasta EOF.
  --provider   openai (predeterminado), xai o google-ai.
  --env-file   Archivo de variables; por defecto, .env en la raíz del repositorio.
  --prompt-version basic-v1 (predeterminado) o basic-v2, con ejemplos few-shot.
  --telemetry-file Archivo JSONL opcional, además de stderr.
  --reports-dir Directorio de JSONs por ejecución; por defecto, reports/manual-tests del proyecto TS.
  --help       Mostrar esta ayuda sin usar credenciales ni llamar al proveedor.
`;

/**
 * Lee stdin hasta EOF respetando caracteres UTF-8 partidos entre bloques de bytes.
 * Aplica el límite durante la lectura para evitar acumular una entrada ilimitada en memoria.
 */
async function readTicketFromStdin(): Promise<string> {
  const decoder = new StringDecoder('utf8');
  let text = '';
  for await (const chunk of process.stdin) {
    text += decoder.write(chunk as Buffer);
    if (Array.from(text).length > 8000) throw new AppError('invalid_input');
  }
  text += decoder.end();
  return text;
}

/**
 * Punto de composición (composition root): crea y conecta los componentes de la aplicación.
 * Conoce argv/stdin/stdout/process.env y traduce el ciclo de la terminal a una llamada al servicio.
 * El servicio recibe dependencias listas; no tiene que buscar claves ni interpretar comandos.
 */
async function main(): Promise<void> {
  let parsedArgs;
  try {
    parsedArgs = parseArgs({
      options: {
        text: { type: 'string' },
        stdin: { type: 'boolean' },
        provider: { type: 'string', default: 'openai' },
        'env-file': { type: 'string' },
        'prompt-version': { type: 'string', default: 'basic-v1' },
        'telemetry-file': { type: 'string' },
        'reports-dir': { type: 'string' },
        help: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch {
    throw new AppError('invalid_arguments');
  }
  if (parsedArgs.values.help) {
    process.stdout.write(help);
    return;
  }
  if ((parsedArgs.values.text !== undefined) === Boolean(parsedArgs.values.stdin))
    throw new AppError('invalid_arguments');
  const text = parsedArgs.values.stdin ? await readTicketFromStdin() : parsedArgs.values.text;
  const ticket = ticketSchema.safeParse({ text });
  if (!ticket.success) throw new AppError('invalid_input');
  if (!['basic-v1', 'basic-v2'].includes(parsedArgs.values['prompt-version']))
    throw new AppError('invalid_arguments');
  const env = await readEnvironment(parsedArgs.values['env-file']);
  const settings = readSettings(parsedArgs.values.provider, env);
  const prices = await loadPrices();
  prices.get(settings.provider, settings.model);
  const prompts = await loadPrompts(parsedArgs.values['prompt-version'] as PromptVersion);
  const runtimeSettings = readRuntimeSettings(env);
  const recorder = await RunReportWriter.create({
    text: text as string,
    normalizedText: ticket.data.text,
    inputSource: parsedArgs.values.stdin ? 'stdin' : 'text',
    provider: settings.provider,
    model: settings.model,
    prompts,
    prices,
    runtimeSettings,
    ...(parsedArgs.values['reports-dir'] === undefined
      ? {}
      : { directory: parsedArgs.values['reports-dir'] }),
  });
  const controller = new AbortController();
  const lifecycleDeadline = AbortSignal.timeout(60_000);
  const onInterrupt = (): void => controller.abort();
  process.once('SIGINT', onInterrupt);
  let response: SupportResponse | undefined;
  let failure: unknown;
  let trace: RunTrace | null = null;
  let sink: Awaited<ReturnType<typeof createEventSink>> | undefined;
  const rawOutputs: CapturedOutput[] = [];
  try {
    // El sink recibe sólo eventos operativos; process().capture conserva texto para el reporte.
    // Separar ambos destinos permite redirigir stderr sin mezclar contenido privado ni stdout.
    sink = await createEventSink(parsedArgs.values['telemetry-file']);
    const assistant = new SupportAssistant({
      provider: createProvider(settings),
      providerName: settings.provider,
      model: settings.model,
      prompts,
      prices,
      settings: runtimeSettings,
      emit: sink.emit,
    });
    const result = await assistant.process(ticket.data, {
      signal: controller.signal,
      capture: (output) => rawOutputs.push(output),
    });
    response = result.response;
    trace = result.trace;
  } catch (error) {
    failure = error;
    if (error instanceof AppError) trace = error.trace ?? null;
  } finally {
    try {
      await sink?.close(AbortSignal.any([controller.signal, lifecycleDeadline]));
    } catch (error) {
      // Un error secundario al cerrar no debe ocultar el motivo original del fallo.
      failure ??= controller.signal.aborted
        ? new AppError('cancelled')
        : lifecycleDeadline.aborted
          ? new AppError('deadline_exceeded')
          : error;
    }
  }
  let error = failure ? publicError(failure).error : null;
  if (error && trace) trace = { ...trace, status: 'error', errorCode: error.code };
  try {
    await recorder.finish({
      response: error ? null : (response ?? null),
      trace,
      error,
      rawOutputs,
    });
    if (!failure && controller.signal.aborted) {
      failure = new AppError('cancelled');
      error = publicError(failure).error;
      if (trace) trace = { ...trace, status: 'error', errorCode: error.code };
      await recorder.finish({ response: null, trace, error, rawOutputs });
    }
  } catch (reportFailure) {
    if (!failure) throw reportFailure;
    process.stderr.write(`${JSON.stringify(publicError(reportFailure))}\n`);
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }
  if (failure) throw failure;
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

// Importar index.ts no ejecuta esta función: el punto de entrada de la CLI es independiente.
main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
  process.exitCode = 2;
});
