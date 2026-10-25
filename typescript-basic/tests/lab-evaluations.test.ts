import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { loadPrices } from '../src/costs/budget.js';
import { LabStore } from '../src/lab/storage.js';
import { LabEvaluationService } from '../src/lab/evaluations.js';
import { readRuntimeSettings } from '../src/config/runtime-settings.js';
import { SupportAssistant } from '../src/support/service.js';
import { loadDataset } from '../src/evals/data.js';
import { createApp } from '../src/web/app.js';
import { PromptRegistry } from '../src/prompting/prompt-registry.js';
import { extendedRegistry } from './fixtures/extended-registry.js';

const input = {
  provider: 'openai',
  operation: 'compare',
  promptVersion: 'basic-v1',
  split: 'dev',
  compareModeration: false,
};

async function fixture(extraVersion = false) {
  const outputDir = await mkdtemp(join(tmpdir(), 'nubbix-lab-eval-'));
  const store = new LabStore(':memory:');
  const prices = await loadPrices();
  const dataset = await loadDataset();
  const service = new LabEvaluationService({
    registry: extraVersion ? await extendedRegistry(outputDir) : await PromptRegistry.load(),
    store,
    mode: 'demo',
    models: new Map([['openai', 'gpt-6-luna']]),
    prices,
    outputDir,
    settings: readRuntimeSettings({}),
    dataset: {
      ...dataset,
      tickets: [dataset.tickets.find((row) => row.split === 'dev')!],
      adversarial: [],
    },
    factory: (_provider, context) =>
      new SupportAssistant({
        providerName: 'openai',
        model: 'gpt-6-luna',
        prices,
        prompts: context.prompts,
        provider: {
          async complete(request) {
            return {
              status: 'completed',
              text: JSON.stringify(
                request.schemaName === 'safety_assessment'
                  ? { decision: 'allow' }
                  : {
                      answer: 'Solicitar período y referencia del cargo.',
                      category: 'billing',
                      confidence: 0.9,
                      actions: [],
                    },
              ),
              usage: {
                inputTokens: 10,
                outputTokens: 5,
                cachedInputTokens: 0,
                cacheWriteInputTokens: 0,
              },
            };
          },
        },
      }),
  });
  return {
    store,
    service,
    async close() {
      await service.close();
      store.close();
      await rm(outputDir, { recursive: true, force: true });
    },
  };
}

test('jobs eval: checkpoints, dos prompts, casos inspeccionables y revisiones sobreviven consultas', async () => {
  const lab = await fixture();
  try {
    const { jobId } = lab.service.start(input);
    assert.throws(() => lab.service.start(input), /límite/);
    for (let count = 0; lab.service.get(jobId)!.job.status === 'running' && count < 500; count++)
      await nextTurn();
    const snapshot = lab.service.get(jobId)!;
    assert.equal(snapshot.job.status, 'completed');
    assert.equal(snapshot.reports.length, 2);
    assert.equal(snapshot.progress.completed, 2);
    assert.equal(snapshot.progress.total, 2);
    assert.equal(snapshot.selection.status, 'pending_human_review');
    assert.ok(snapshot.reports.every((report) => report.provenance.evidence === 'fake'));
    const report = snapshot.reports[0]!;
    const row = report.records[0]!;
    const child = lab.store.getRun(row.trace!.requestId)!;
    assert.equal(child.parentId, jobId);
    assert.equal(child.inspections.filter((entry) => entry.kind === 'llm.response').length, 3);
    const review = {
      runId: report.runId,
      caseId: row.id,
      usefulness: 1,
      correctness: 1,
      policy: 1,
      severeIssue: false,
      attackSucceeded: null,
      unjustifiedRefusal: null,
      notes: 'Revisión de fixture',
    };
    lab.service.saveReview(jobId, report.runId, review);
    assert.deepEqual(lab.service.get(jobId)!.reviews, [review]);
    assert.throws(() =>
      lab.service.saveReview(jobId, report.runId, { ...review, caseId: 'unknown' }),
    );
    assert.throws(() => lab.service.start({ ...input, operation: 'compare', split: 'test' }));
    assert.throws(() => lab.service.start({ ...input, provider: 'google-ai' }));
  } finally {
    await lab.close();
  }
});

test('jobs eval: cancelación inmediata conserva casos not_run y no acredita éxito', async () => {
  const lab = await fixture();
  try {
    const { jobId } = lab.service.start(input);
    assert.equal(lab.service.cancel(jobId), true);
    await lab.service.close();
    const result = lab.service.get(jobId)!;
    assert.equal(result.job.status, 'cancelled');
    assert.ok(
      result.reports.every(
        (report) => !report.complete && report.records.every((row) => row.notRun),
      ),
    );
    assert.ok(result.assessments.every((assessment) => !assessment.eligible));
    const report = result.reports[0]!;
    assert.throws(() =>
      lab.service.saveReview(jobId, report.runId, {
        runId: report.runId,
        caseId: report.records[0]!.id,
        usefulness: 1,
        correctness: 1,
        policy: 1,
        severeIssue: false,
        attackSucceeded: null,
        unjustifiedRefusal: null,
        notes: '',
      }),
    );
  } finally {
    await lab.close();
  }
});

test('jobs eval: versión nueva por registro y selección explícita comparten los mismos contratos', async () => {
  const lab = await fixture(true);
  try {
    assert.throws(() => lab.service.start({ ...input, promptVersions: ['basic-v1', 'missing'] }));
    assert.throws(() =>
      lab.service.start({
        ...input,
        promptVersions: ['basic-v1', 'experiment-v3'],
        baselinePromptVersion: 'basic-v2',
      }),
    );
    const { jobId } = lab.service.start({
      ...input,
      promptVersions: ['basic-v1', 'experiment-v3'],
      baselinePromptVersion: 'basic-v1',
    });
    for (let count = 0; lab.service.get(jobId)!.job.status === 'running' && count < 500; count++)
      await nextTurn();
    const result = lab.service.get(jobId)!;
    assert.equal(result.job.status, 'completed');
    assert.deepEqual(
      result.reports.map((report) => report.promptVersion),
      ['basic-v1', 'experiment-v3'],
    );
    assert.deepEqual((result.job.input as { promptVersions: string[] }).promptVersions, [
      'basic-v1',
      'experiment-v3',
    ]);
    assert.ok(
      result.reports.every((report) => report.provenance.baselinePromptVersion === 'basic-v1'),
    );
  } finally {
    await lab.close();
  }
});

test('historia eval: leer selecciones retiradas no exige registro ni ejecuta targets', async () => {
  const lab = await fixture();
  const jobId = randomUUID();
  try {
    lab.store.createRun({
      id: jobId,
      kind: 'evaluation',
      mode: 'demo',
      provider: 'openai',
      model: 'gpt-6-luna',
      promptVersion: 'retired-v1,retired-v2',
      input: { ...input, promptVersion: 'retired-v1' },
    });
    lab.store.finishRun(jobId, { status: 'interrupted' });
    const snapshot = lab.service.get(jobId)!;
    assert.equal(snapshot.job.status, 'interrupted');
    assert.equal(snapshot.progress.total, 120);
    assert.deepEqual(snapshot.reports, []);
  } finally {
    await lab.close();
  }
});

test('HTTP eval: inicio validado, consulta offline y políticas de origen para operaciones con costo', async () => {
  const lab = await fixture();
  const server = createApp({
    configuration: {
      mode: 'demo',
      providers: [{ id: 'openai', label: 'OpenAI', model: 'gpt-6-luna', available: true }],
      promptVersions: ['basic-v1'],
      maxConcurrent: 1,
    },
    store: lab.store,
    evaluations: lab.service,
    createAssistant: () => {
      throw new Error('unused');
    },
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const rejected = await fetch(`${url}/api/evaluations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://example.com' },
      body: JSON.stringify(input),
    });
    assert.equal(rejected.status, 403);
    const invalid = await fetch(`${url}/api/evaluations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, outputDir: '/tmp' }),
    });
    assert.equal(invalid.status, 400);
    const started = await fetch(`${url}/api/evaluations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    assert.equal(started.status, 202);
    const { jobId } = await started.json();
    const snapshot = await (await fetch(`${url}/api/evaluations/${jobId}`)).json();
    assert.equal(snapshot.job.id, jobId);
    assert.ok(Array.isArray(snapshot.reviews));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await lab.close();
  }
});
