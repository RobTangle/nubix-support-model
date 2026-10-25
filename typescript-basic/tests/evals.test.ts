/**
 * Prueba el sistema de evaluaciones: corpus, métricas, reportes, revisión humana y comparación.
 * Los modelos falsos comprueban el software del experimento; sus respuestas no acreditan calidad LLM.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import test, { after } from 'node:test';
import { Budget, loadPrices } from '../src/budget.js';
import { AppError } from '../src/errors.js';
import { readRuntimeSettings } from '../src/runtime-settings.js';
import { SupportAssistant } from '../src/service.js';
import { createGenerationOnlyBaseline } from '../src/evals/ablation.js';
import type { RunTrace } from '../src/telemetry.js';
import { compilePattern, hash, loadDataset, parseDataset } from '../src/evals/data.js';
import { summarize } from '../src/evals/metrics.js';
import { EvalRunner } from '../src/evals/runner.js';
import { installedPackageVersion } from '../src/evals/package-version.js';
import {
  assessReport,
  compareReports,
  loadReviews,
  validateReviews,
} from '../src/evals/reviews.js';
import type { HumanReview } from '../src/evals/reviews.js';
import { readReport, ReportWriter, reviewTemplate } from '../src/evals/storage.js';
import { evaluationReportSchema } from '../src/evals/types.js';
import type { CaseRecord, EvaluationReport } from '../src/evals/types.js';
import { readSharedResource } from '../src/resources.js';

const generatedDirectories: string[] = [];
const fixturePrefix = join(tmpdir(), 'nubbix-eval-output-');

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(fixturePrefix);
  generatedDirectories.push(directory);
  return directory;
}

after(async () => {
  for (const directory of generatedDirectories) {
    assert.ok(directory.startsWith(fixturePrefix));
    await rm(directory, { recursive: true, force: true });
  }
});

function trace(overrides: Partial<RunTrace> = {}): RunTrace {
  return {
    requestId: randomUUID(),
    provider: 'openai',
    model: 'fixture',
    promptVersion: 'basic-v1',
    manualVersion: '1',
    safetyVersion: '1',
    priceVersion: '1',
    contextHashes: {},
    status: 'ok',
    abstained: false,
    stagesAttempted: 1,
    attempts: [
      {
        stage: 'generation',
        attempt: 1,
        status: 'valid',
        inputTokens: 10,
        outputTokens: 20,
        latencyMs: 1,
        knownCostUsd: '0.001',
        reservedUnknownUsd: '0',
        usageComplete: true,
      },
    ],
    latencyMs: 1,
    knownCostUsd: '0.001',
    reservedUnknownUsd: '0',
    usageComplete: true,
    ...overrides,
  };
}

function record(overrides: Partial<CaseRecord> = {}): CaseRecord {
  return {
    id: randomUUID(),
    text: 'Consulta sintética',
    kind: 'ticket',
    expectedCategory: 'billing',
    expectedActions: [],
    forbiddenPatterns: [],
    scenario: 'Fixture de ingeniería; no mide modelos',
    response: {
      answer: 'Verificar con soporte.',
      category: 'billing',
      confidence: 0.8,
      actions: [],
    },
    trace: trace(),
    errorCode: null,
    notRun: false,
    latencyMs: 1,
    rawOutputs: [],
    publishedRuleFlags: [],
    intermediateRuleFlags: [],
    ...overrides,
  };
}

async function report(): Promise<EvaluationReport> {
  const dataset = await loadDataset();
  const records = [
    ...dataset.tickets.filter((row) => row.split === 'dev'),
    ...dataset.adversarial,
  ].map((row) =>
    record({
      id: row.id,
      text: row.text,
      kind: row.kind,
      expectedCategory: row.expectedCategory,
      expectedActions: row.expectedActions,
      forbiddenPatterns: row.forbiddenPatterns,
      scenario: row.scenario,
      response: {
        answer: 'Verificar con soporte.',
        category: row.expectedCategory,
        confidence: 0.8,
        actions: [],
      },
    }),
  );
  return {
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    provider: 'openai',
    model: 'fixture',
    promptVersion: 'basic-v1',
    split: 'dev',
    suite: 'all',
    mode: 'full',
    complete: true,
    stopReason: null,
    provenance: {
      application: 'nubbix-support-basic-ts',
      applicationVersion: 'test',
      reportVersion: 1,
      evidence: 'fake',
      datasetHashes: dataset.hashes,
      promptHashes: Object.fromEntries(
        [
          'system',
          'manual',
          'safety',
          'inputModeration',
          'outputModeration',
          'repair',
          'examples',
        ].map((key) => [key, hash(key)]),
      ),
      schemaHash: hash('schema'),
      priceHash: hash('prices'),
      priceVersion: '1',
      settingsHash: hash('settings'),
      settings: {},
      manualVersion: '1',
      safetyVersion: '1',
      canaryEnabled: true,
      sdkVersions: { fake: '1' },
    },
    records,
    metrics: summarize(records),
  };
}

function reviews(report: EvaluationReport): HumanReview[] {
  return report.records.map((row) => ({
    runId: report.runId,
    caseId: row.id,
    usefulness: 1,
    correctness: 1,
    policy: 1,
    severeIssue: false,
    attackSucceeded: row.kind === 'attack' ? false : null,
    unjustifiedRefusal: row.kind === 'benign' ? false : null,
    notes: '',
  }));
}

test('corpus canónico balanceado, regex Python traducida y canario ausente del ticket', async () => {
  const dataset = await loadDataset();
  assert.equal(dataset.tickets.length, 80);
  assert.equal(dataset.adversarial.length, 20);
  assert.equal(
    compilePattern('(?i)ya reintegr[eé] el dinero').test('YA REINTEGRÉ EL DINERO'),
    true,
  );
  assert.equal(
    compilePattern('(?i)\\b(ya|he)\\s+(reintegrado|reembolsado|devuelto)\\b').test(
      'He devuelto el dinero',
    ),
    true,
  );
  for (const expression of ['(?i:secret)', '(?P<id>a)', '\\Asecret', '['])
    assert.throws(
      () => compilePattern(expression),
      (error: unknown) => error instanceof AppError && error.code === 'invalid_dataset',
    );
  assert.equal(
    dataset.adversarial.find((row) => row.id === 'attack-04')!.text.includes('NUBBIX_CANARY_7F2A'),
    false,
  );
});

test('loader rechaza duplicados, desbalance y regex inválida antes de invocar proveedor', async () => {
  const [tickets, attacks] = await Promise.all([
    readSharedResource('datasets/tickets.jsonl'),
    readSharedResource('datasets/adversarial.jsonl'),
  ]);
  assert.throws(() => parseDataset(tickets.replace('dev-billing-02', 'dev-billing-01'), attacks));
  assert.throws(() =>
    parseDataset(tickets.replace('"category":"billing"', '"category":"account"'), attacks),
  );
  assert.throws(() =>
    parseDataset(tickets, attacks.replace('NUBBIX_OVERRIDE_OK"],', '(?P<bad>a)"],')),
  );
});

test('métricas conservan errores/pendientes y abstención other falla; baja confianza no abstiene', () => {
  const rows = [
    record({ expectedCategory: 'billing' }),
    record({
      expectedCategory: 'billing',
      response: { answer: 'ok', confidence: 0.2, category: 'technical', actions: [] },
      trace: trace({ status: 'escalated' }),
    }),
    record({ expectedCategory: 'technical', response: null, errorCode: 'timeout' }),
    record({
      expectedCategory: 'other',
      response: { answer: 'Derivar', confidence: 0, category: 'other', actions: [] },
      trace: trace({ abstained: true, status: 'blocked' }),
    }),
    record({ expectedCategory: 'account', response: null, trace: null, notRun: true }),
  ];
  const result = summarize(rows);
  assert.equal(result.accuracy, 0.2);
  assert.equal(result.perCategory.billing.precision, 1);
  assert.equal(result.perCategory.billing.recall, 0.5);
  assert.equal(result.perCategory.billing.f1, 2 / 3);
  assert.equal(result.macroF1, 1 / 6);
  assert.equal(result.confusionMatrix.other.abstained, 1);
  assert.equal(result.confusionMatrix.account.not_run, 1);
  assert.equal(result.confusionMatrix.billing.technical, 1);
  assert.equal(result.operationalErrorRate, 0.25);
  assert.equal(result.publicResponseValidityRate, 0.75);
  assert.equal(summarize([]).publicResponseValidityRate, 0);
  assert.equal(summarize([]).automatedFalseBlockRate, 0);
});

test('p50/p95 nearest rank, costos desconocidos y validez por etapa incluyen reparaciones', () => {
  const rows = Array.from({ length: 20 }, (_, index) => record({ latencyMs: index + 1 }));
  const repaired = trace({
    stagesAttempted: 2,
    attempts: [
      {
        stage: 'generation',
        attempt: 1,
        status: 'invalid_output',
        inputTokens: 10,
        outputTokens: 0,
        latencyMs: 1,
        knownCostUsd: null,
        reservedUnknownUsd: '0.02',
        usageComplete: false,
      },
      {
        stage: 'generation',
        attempt: 2,
        status: 'valid',
        inputTokens: 10,
        outputTokens: 20,
        latencyMs: 1,
        knownCostUsd: '0.001',
        reservedUnknownUsd: '0',
        usageComplete: true,
      },
      {
        stage: 'output_moderation',
        attempt: 1,
        status: 'refused',
        inputTokens: null,
        outputTokens: null,
        latencyMs: 1,
        knownCostUsd: null,
        reservedUnknownUsd: '0.01',
        usageComplete: false,
      },
    ],
    knownCostUsd: '0.001',
    reservedUnknownUsd: '0.03',
    usageComplete: false,
  });
  const result = summarize(rows);
  assert.equal(result.latencyP50Ms, 10);
  assert.equal(result.latencyP95Ms, 19);
  assert.equal(result.knownCostUsd, '0.02');
  const partial = summarize([record({ trace: repaired })]);
  assert.equal(partial.structuredValidityBeforeRetry, 0);
  assert.equal(partial.structuredValidityAfterRetry, 0.5);
  assert.equal(partial.estimatedCommittedUsd, '0.031');
  assert.equal(partial.usageComplete, false);
  assert.equal(partial.operationalErrors, 0);
});

test('revisiones estrictas detectan duplicados, huérfanos, campos inaplicables y diferencias sin notas', async () => {
  const run = await report();
  const rows = reviews(run);
  assert.equal(validateReviews([run], rows).length, 60);
  assert.throws(() => validateReviews([run], [...rows, rows[0]]));
  assert.throws(() => validateReviews([run], [{ ...rows[0], caseId: 'unknown' }]));
  assert.throws(() => validateReviews([run], [{ ...rows[0], attackSucceeded: false }]));
  const attack = run.records.find((row) => row.kind === 'attack')!;
  attack.publishedRuleFlags.push('marker');
  const human = rows.find((row) => row.caseId === attack.id)!;
  assert.throws(() => validateReviews([run], rows));
  human.notes = 'El marcador sólo se citó para rechazar la instrucción.';
  assert.doesNotThrow(() => validateReviews([run], rows));
});

test('template pendiente nunca acredita calidad; sólo 40 tickets cuentan en calidad humana', async () => {
  const run = await report();
  const template = reviewTemplate(run)
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
  const pending = assessReport(run, validateReviews([run], template));
  assert.equal(pending.pendingReviews, 60);
  assert.equal(pending.eligible, false);
  const rows = reviews(run);
  rows[0]!.correctness = 0;
  const attack = rows.find((row) => row.caseId.startsWith('attack'))!;
  attack.usefulness = 0;
  assert.equal(assessReport(run, rows).qualityRate, 39 / 40);
});

test('falsos bloqueos unen abstención automática y rechazo injustificado humano sin doble contar', async () => {
  const run = await report();
  const controls = run.records.filter((row) => row.kind === 'benign');
  controls[0]!.trace!.abstained = true;
  const rows = reviews(run);
  rows.find((row) => row.caseId === controls[0]!.id)!.unjustifiedRefusal = true;
  rows.find((row) => row.caseId === controls[1]!.id)!.unjustifiedRefusal = true;
  assert.equal(assessReport(run, rows).falseBlocks, 2);
  assert.equal(summarize(run.records).automatedFalseBlocks, 1);
  assert.equal(summarize(run.records).automatedFalseBlockRate, 0.1);
});

test('versiones SDK resuelven dependencia hoisted sin exportar package.json y reflejan versión instalada', async () => {
  const directory = await temporaryDirectory();
  const app = join(directory, 'node_modules', 'consumer');
  const sdk = join(directory, 'node_modules', '@fixture', 'sdk');
  await Promise.all([
    mkdir(app, { recursive: true }),
    mkdir(join(sdk, 'dist'), { recursive: true }),
  ]);
  await writeFile(
    join(app, 'package.json'),
    JSON.stringify({ name: 'consumer', version: '0.0.1' }),
  );
  await writeFile(
    join(sdk, 'package.json'),
    JSON.stringify({ name: '@fixture/sdk', version: '1.2.3', exports: { '.': './dist/index.js' } }),
  );
  await writeFile(join(sdk, 'dist', 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(join(sdk, 'dist', 'index.js'), 'export {};\n');
  const consumerRequire = createRequire(join(app, 'package.json'));
  const resolve = (specifier: string): string =>
    pathToFileURL(consumerRequire.resolve(specifier)).href;
  assert.throws(() => consumerRequire.resolve('@fixture/sdk/package.json'));
  assert.equal(await installedPackageVersion('@fixture/sdk', resolve), '1.2.3');
  await writeFile(
    join(sdk, 'package.json'),
    JSON.stringify({ name: '@fixture/sdk', version: '1.2.4', exports: { '.': './dist/index.js' } }),
  );
  assert.equal(await installedPackageVersion('@fixture/sdk', resolve), '1.2.4');
  assert.match(await installedPackageVersion('openai'), /^\d+\.\d+\.\d+/u);
});

test('comparación dev exige evidencia completa y desempata en favor de basic-v1', async () => {
  const first = await report();
  const second = structuredClone(first);
  second.runId = randomUUID();
  second.promptVersion = 'basic-v2';
  const allReviews = [...reviews(first), ...reviews(second)];
  assert.equal(compareReports([first, second], allReviews).recommendedPrompt, null);
  first.provenance.evidence = 'live';
  second.provenance.evidence = 'live';
  assert.equal(compareReports([second, first], allReviews).recommendedPrompt, 'basic-v1');
  assert.equal(compareReports([first, second], []).status, 'pending_human_review');
  second.split = 'test';
  assert.throws(() => compareReports([first, second], allReviews));
  second.split = 'dev';
  second.mode = 'generation_only';
  assert.throws(() => compareReports([first, second], allReviews));
  second.mode = 'full';
  second.provenance.settingsHash = 'different';
  assert.throws(() => compareReports([first, second], allReviews));
});

test('Zod rechaza formato Python y checkpoint no permite sobrescribir corrida ajena', async () => {
  const run = await report();
  assert.equal(evaluationReportSchema.safeParse({ ...run, run_id: run.runId }).success, false);
  const directory = await temporaryDirectory();
  const writer = new ReportWriter(directory);
  await writer.reserve(run);
  await assert.rejects(writer.reserve(run));
  await assert.rejects(new ReportWriter(directory).checkpoint(run));
  await writer.finish(run);
  assert.equal((await readReport(join(directory, `${run.runId}.json`))).runId, run.runId);
  assert.equal((await readdir(directory)).filter((path) => path.endsWith('.tmp')).length, 0);
  run.metrics.macroF1 = 0;
  await writeFile(join(directory, 'inconsistent.json'), JSON.stringify(run));
  await assert.rejects(readReport(join(directory, 'inconsistent.json')));
});

test('EvalRunner usa el servicio real; full recorre tres etapas y la ablación sólo generación', async () => {
  const directory = await temporaryDirectory();
  const prices = await loadPrices();
  const settings = readRuntimeSettings({});
  const calls = { generation: 0, moderation: 0 };
  const runner = new EvalRunner({
    provider: 'openai',
    model: 'gpt-6-luna',
    settings,
    prices,
    evidence: 'fake',
    outputDir: directory,
    factory: ({ mode, prompts }) => {
      const options = {
        providerName: 'openai',
        model: 'gpt-6-luna',
        prompts,
        prices,
        settings,
        provider: {
          async complete(request: { schemaName: string }) {
            const generation = request.schemaName === 'support_response';
            calls[generation ? 'generation' : 'moderation']++;
            return {
              text: JSON.stringify(generation ? record().response : { decision: 'allow' }),
              status: 'completed' as const,
              usage: {
                inputTokens: 10,
                outputTokens: 20,
                cachedInputTokens: 0,
                cacheWriteInputTokens: 0,
              },
            };
          },
        },
      };
      return mode === 'full'
        ? new SupportAssistant(options)
        : createGenerationOnlyBaseline(options);
    },
  });
  const runs = await runner.run({
    promptVersions: ['basic-v1'],
    split: 'dev',
    suite: 'adversarial',
    compareModeration: true,
  });
  assert.equal(calls.generation, 40);
  assert.equal(calls.moderation, 40);
  assert.equal(runs[0]!.metrics.llmCalls, 60);
  assert.equal(runs[1]!.metrics.llmCalls, 20);
  assert.equal(
    runs[0]!.records.every((row) => row.rawOutputs.length === 3),
    true,
  );
  assert.equal(
    runs[1]!.records.every((row) => row.rawOutputs.length === 1),
    true,
  );
  assert.equal(
    runs.every(
      (run) => run.complete && run.provenance.evidence === 'fake' && run.metrics.usageComplete,
    ),
    true,
  );
});

test('runner intercala versiones, comparte Budget y distingue filtración intermedia de respuesta publicada', async () => {
  const directory = await temporaryDirectory();
  const order: string[] = [];
  const budgets = new Set<Budget>();
  const runner = new EvalRunner({
    provider: 'openai',
    model: 'fixture',
    settings: readRuntimeSettings({}),
    prices: await loadPrices(),
    evidence: 'fake',
    outputDir: directory,
    factory: ({ promptVersion, prompts }) => {
      assert.equal(prompts.canaryEnabled, true);
      return {
        async process(input, options) {
          order.push(promptVersion);
          budgets.add(options!.batchBudget!);
          const text = (input as { text: string }).text;
          options!.capture?.({ stage: 'generation', attempt: 1, text: 'NUBBIX_CANARY_7F2A' });
          return {
            response: {
              answer: `Respuesta segura ${text.length}`,
              category: 'other',
              confidence: 0.8,
              actions: [],
            },
            trace: trace({ promptVersion }),
          };
        },
      };
    },
  });
  const runs = await runner.run({
    promptVersions: ['basic-v1', 'basic-v2'],
    split: 'dev',
    suite: 'adversarial',
  });
  assert.deepEqual(order.slice(0, 4), ['basic-v1', 'basic-v2', 'basic-v2', 'basic-v1']);
  assert.equal(budgets.size, 1);
  assert.equal(runs[0]!.complete, true);
  const canary = runs[0]!.records.find((row) => row.id === 'attack-04')!;
  assert.equal(canary.publishedRuleFlags.length, 0);
  assert.equal(canary.intermediateRuleFlags.length, 1);
  assert.equal(
    (await readReport(join(directory, `${runs[0]!.runId}.json`))).provenance.evidence,
    'fake',
  );
});

test('presupuesto/autenticación preservan resto not_run; error transitorio agotado continúa', async () => {
  for (const code of [
    'eval_budget_exceeded',
    'authentication',
    'permission',
    'invalid_request',
    'provider_unavailable',
  ] as const) {
    const directory = await temporaryDirectory();
    let count = 0;
    const runner = new EvalRunner({
      provider: 'openai',
      model: 'fixture',
      settings: readRuntimeSettings({}),
      prices: await loadPrices(),
      evidence: 'fake',
      outputDir: directory,
      factory: () => ({
        async process() {
          count++;
          throw new AppError(code, { trace: trace({ status: 'error', errorCode: code }) });
        },
      }),
    });
    const [run] = await runner.run({
      promptVersions: ['basic-v1'],
      split: 'dev',
      suite: 'adversarial',
    });
    assert.equal(run!.records.length, 20);
    assert.equal(count, code === 'provider_unavailable' ? 20 : 1);
    assert.equal(
      run!.records.filter((row) => row.notRun).length,
      code === 'provider_unavailable' ? 0 : 19,
    );
    assert.equal(run!.complete, code === 'provider_unavailable');
  }
});

test('ablación alterna full/generation_only y SIGINT preserva pendientes', async () => {
  const directory = await temporaryDirectory();
  const controller = new AbortController();
  const order: string[] = [];
  const runner = new EvalRunner({
    provider: 'openai',
    model: 'fixture',
    settings: readRuntimeSettings({}),
    prices: await loadPrices(),
    evidence: 'fake',
    outputDir: directory,
    signal: controller.signal,
    factory: ({ mode }) => ({
      async process() {
        order.push(mode);
        if (order.length === 4) controller.abort();
        return { response: record().response!, trace: trace() };
      },
    }),
  });
  const runs = await runner.run({
    promptVersions: ['basic-v1'],
    split: 'dev',
    suite: 'adversarial',
    compareModeration: true,
  });
  assert.deepEqual(order, ['full', 'generation_only', 'generation_only', 'full']);
  assert.equal(
    runs.every((run) => run.stopReason === 'cancelled' && !run.complete),
    true,
  );
  assert.equal(
    runs.every((run) => run.records.filter((row) => row.notRun).length === 18),
    true,
  );
});

test('CLI offline y ayuda funcionan sin claves incluso desde otro cwd; JSON inválido falla localmente', async () => {
  const directory = await temporaryDirectory();
  const cli = new URL('../dist/eval-cli.js', import.meta.url);
  const env = { ...process.env, OPENAI_API_KEY: '', XAI_API_KEY: '' };
  const help = spawnSync(process.execPath, [fileURLToPath(cli), '--help'], {
    cwd: directory,
    env,
    encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /offline/u);
  const run = await report();
  const path = join(directory, 'report.json');
  await writeFile(path, JSON.stringify(run));
  const summary = spawnSync(process.execPath, [fileURLToPath(cli), 'summarize', '--report', path], {
    cwd: directory,
    env,
    encoding: 'utf8',
  });
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /pending_human_review/u);
  await writeFile(path, '{}');
  const invalid = spawnSync(process.execPath, [fileURLToPath(cli), 'summarize', '--report', path], {
    cwd: directory,
    env,
    encoding: 'utf8',
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /invalid_report/u);
  await writeFile(join(directory, 'bad.jsonl'), '{"runId":"invalid"}\n');
  await assert.rejects(loadReviews([join(directory, 'bad.jsonl')], [run]));
  assert.ok(await readFile(join(directory, 'bad.jsonl'), 'utf8'));
});
