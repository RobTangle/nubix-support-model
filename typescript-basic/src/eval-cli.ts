#!/usr/bin/env node
/**
 * Entrada de terminal para evaluar conjuntos de casos, separada de la CLI que atiende un ticket.
 * Ofrece ejecuciones con API y operaciones offline sobre reportes/revisiones guardados. Decide el
 * modo antes de importar el borde live para que leer o comparar archivos no requiera credenciales.
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { AppError, publicError } from './errors.js';
import { readReport, renderSummary } from './evals/storage.js';
import { assessReport, compareReports, loadReviewDirectory, loadReviews } from './evals/reviews.js';
import { summarize } from './evals/metrics.js';

const help = `Evaluaciones sintéticas TypeScript (las llamadas live consumen presupuesto).
Uso:
  nubbix-support-eval run --provider openai|xai|google-ai [--prompt-version ID] --split dev|test
  nubbix-support-eval compare --provider openai|xai|google-ai [--prompt-versions ID --prompt-versions ID] [--baseline-prompt ID] [--split dev]
  nubbix-support-eval compare --reports v1.json v2.json --reviews-dir reviews
  nubbix-support-eval adversarial --provider openai|xai|google-ai [--prompt-version ID] [--compare-moderation]
  nubbix-support-eval summarize --report run.json [--reviews human.jsonl]
Opciones: --output-dir reports, --env-file archivo, --help.
Cada corrida produce JSON validado, resumen Markdown y revisión JSONL pendiente.
Comparar reportes y resumir son operaciones offline sin credenciales ni clientes SDK.
Las versiones y el baseline predeterminados se obtienen del registro YAML.
--list-prompts muestra el registro como JSON sin consumir API.
`;

/**
 * Valida subcomandos y conecta el evaluador o los lectores offline. argv explícito permite probar
 * la interpretación de comandos. run/compare/adversarial ejecutan casos; summarize analiza archivos,
 * y compare --reports compara evidencia ya guardada sin volver a llamar a los modelos.
 */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: {
        provider: { type: 'string' },
        'prompt-version': { type: 'string' },
        'prompt-versions': { type: 'string', multiple: true },
        'baseline-prompt': { type: 'string' },
        split: { type: 'string' },
        reports: { type: 'string', multiple: true },
        report: { type: 'string' },
        reviews: { type: 'string', multiple: true },
        'reviews-dir': { type: 'string' },
        'compare-moderation': { type: 'boolean' },
        'output-dir': { type: 'string' },
        'env-file': { type: 'string' },
        help: { type: 'boolean' },
        'list-prompts': { type: 'boolean' },
      },
    });
  } catch {
    throw new AppError('invalid_arguments');
  }
  const { values, positionals } = args;
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  if (values['list-prompts']) {
    if (positionals.length || Object.keys(values).some((name) => name !== 'list-prompts'))
      throw new AppError('invalid_arguments');
    const { PromptRegistry } = await import('./prompt-registry.js');
    const registry = await PromptRegistry.load();
    process.stdout.write(
      JSON.stringify(
        {
          defaultVersion: registry.defaultVersion,
          baselineVersion: registry.baselineVersion,
          versions: registry.versions,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }
  const command = positionals[0];
  if (!command || !['run', 'compare', 'adversarial', 'summarize'].includes(command))
    throw new AppError('invalid_arguments');
  const offline = command === 'summarize' || Boolean(values.reports);
  if (
    offline &&
    (values.provider ||
      values['prompt-version'] ||
      values['prompt-versions'] ||
      values.split ||
      values['compare-moderation'] ||
      values['env-file'] ||
      values['output-dir'])
  )
    throw new AppError('invalid_arguments');
  if (command === 'summarize') {
    if (
      !values.report ||
      values.reports ||
      positionals.length !== 1 ||
      (values.reviews && values['reviews-dir']) ||
      values['baseline-prompt']
    )
      throw new AppError('invalid_arguments');
    const report = await readReport(values.report);
    const reviews = values['reviews-dir']
      ? await loadReviewDirectory(values['reviews-dir'], [report])
      : await loadReviews(values.reviews ?? [], [report]);
    process.stdout.write(
      renderSummary(report) +
        `\nRevisión humana:\n${JSON.stringify(assessReport(report, reviews), null, 2)}\n`,
    );
    return;
  }
  if (values.reports) {
    if (command !== 'compare' || !values['reviews-dir'] || values.reviews || values.report)
      throw new AppError('invalid_arguments');
    const paths = [...values.reports.flatMap((path) => path.split(',')), ...positionals.slice(1)];
    const reports = await Promise.all(paths.map(readReport));
    const reviews = await loadReviewDirectory(values['reviews-dir'], reports);
    process.stdout.write(
      JSON.stringify(compareReports(reports, reviews, values['baseline-prompt']), null, 2) + '\n',
    );
    return;
  }
  if (
    values.report ||
    values.reviews ||
    values['reviews-dir'] ||
    positionals.length !== 1 ||
    (values['compare-moderation'] && command !== 'adversarial') ||
    (command === 'compare' && values['prompt-version']) ||
    (command !== 'compare' && (values['prompt-versions'] || values['baseline-prompt']))
  )
    throw new AppError('invalid_arguments');
  const provider = values.provider ?? 'openai';
  const split = values.split ?? 'dev';
  if (
    !['openai', 'xai', 'google-ai'].includes(provider) ||
    !['dev', 'test'].includes(split) ||
    (command === 'compare' && split !== 'dev')
  )
    throw new AppError('invalid_arguments');
  const { PromptRegistry } = await import('./prompt-registry.js');
  const registry = await PromptRegistry.load();
  const promptVersion = values['prompt-version'] ?? registry.defaultVersion;
  const promptVersions =
    command === 'compare'
      ? (values['prompt-versions']?.flatMap((value) => value.split(',')) ??
        registry.versions.map((entry) => entry.id))
      : [promptVersion];
  const baselinePromptVersion =
    command === 'compare' ? (values['baseline-prompt'] ?? registry.baselineVersion) : promptVersion;
  if (
    !promptVersions.length ||
    new Set(promptVersions).size !== promptVersions.length ||
    promptVersions.some((version) => !registry.has(version)) ||
    (command === 'compare' &&
      (promptVersions.length < 2 || !promptVersions.includes(baselinePromptVersion)))
  )
    throw new AppError('invalid_arguments');
  // El borde live se importa después de decidir modo: offline jamás construye clientes SDK.
  const [
    { readEnvironment, readSettings },
    { readRuntimeSettings },
    { loadPrices },
    { EvalRunner },
    { SupportAssistant },
    { createGenerationOnlyBaseline },
  ] = await Promise.all([
    import('./config.js'),
    import('./runtime-settings.js'),
    import('./budget.js'),
    import('./evals/runner.js'),
    import('./service.js'),
    import('./evals/ablation.js'),
  ]);
  const environment = await readEnvironment(values['env-file']);
  const providerSettings = readSettings(provider, environment);
  const settings = readRuntimeSettings(environment);
  const prices = await loadPrices();
  prices.get(provider, providerSettings.model);
  const { createProvider } = await import('./providers.js');
  const adapter = createProvider(providerSettings);
  const controller = new AbortController();
  const onInterrupt = (): void => controller.abort();
  process.once('SIGINT', onInterrupt);
  try {
    const runner = new EvalRunner({
      provider,
      model: providerSettings.model,
      settings,
      prices,
      evidence: 'live',
      outputDir: values['output-dir'] ?? 'reports',
      signal: controller.signal,
      registry,
      factory: ({ mode, prompts }) => {
        const options = {
          provider: adapter,
          providerName: provider,
          model: providerSettings.model,
          prompts,
          prices,
          settings,
          emit: (event: unknown) => {
            process.stderr.write(JSON.stringify(event) + '\n');
          },
        };
        return mode === 'generation_only'
          ? createGenerationOnlyBaseline(options)
          : new SupportAssistant(options);
      },
    });
    const reports = await runner.run({
      promptVersions,
      ...(command === 'compare' ? { baselinePromptVersion } : {}),
      split: split as 'dev' | 'test',
      suite: command === 'adversarial' ? 'adversarial' : 'all',
      compareModeration: values['compare-moderation'] ?? false,
    });
    process.stdout.write(
      JSON.stringify(
        {
          reports: reports.map((report) => ({
            runId: report.runId,
            complete: report.complete,
            stopReason: report.stopReason,
            evidence: report.provenance.evidence,
            metrics: summarize(report.records),
          })),
          selection: 'pending_human_review',
        },
        null,
        2,
      ) + '\n',
    );
    if (reports.some((report) => !report.complete)) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    process.stderr.write(JSON.stringify(publicError(error)) + '\n');
    process.exitCode = 1;
  });
