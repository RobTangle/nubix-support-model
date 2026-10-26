import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { PromptRegistry } from '../src/prompting/prompt-registry.js';
import { EvalRunner } from '../src/evals/runner.js';
import { LabEvaluationService } from '../src/lab/evaluations.js';
import { LabStore } from '../src/lab/storage.js';
import { loadPrices } from '../src/costs/budget.js';
import { readRuntimeSettings } from '../src/config/runtime-settings.js';
import { LabApi } from '../src/web/client/lab-api.js';

test('v4: recursos independientes conservan generación y ejemplos de v3 e insertan política en las tres etapas', async () => {
  const registry = await PromptRegistry.load();
  assert.equal(registry.defaultVersion, 'basic-v1');
  assert.equal(registry.baselineVersion, 'basic-v1');
  const root = new URL('../src/prompting/versions/', import.meta.url);
  for (const [file, field] of [
    ['system.yaml', 'system'],
    ['examples.yaml', 'examples'],
  ] as const) {
    const old = parse(await readFile(new URL(`basic-v3/${file}`, root), 'utf8'));
    const next = parse(await readFile(new URL(`basic-v4/${file}`, root), 'utf8'));
    assert.deepEqual(next[field], old[field]);
  }
  const bundle = registry.get('basic-v4');
  for (const prompt of [bundle.system, bundle.inputModeration, bundle.outputModeration]) {
    assert.match(prompt, /contraseña afectada/);
    assert.match(prompt, /sesiones/);
    assert.match(prompt, /no garantiza/i);
  }
  assert.doesNotMatch(bundle.inputModeration, /responde que no eres capaz/);
});

test('comparación incompatible: runner y jobs rechazan antes de targets, archivos o presupuesto de API', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'nubbix-phishing-'));
  const store = new LabStore(':memory:');
  let targets = 0;
  const options = {
    registry: await PromptRegistry.load(),
    prices: await loadPrices(),
    provider: 'openai',
    model: 'gpt-6-luna',
    evidence: 'fake' as const,
    outputDir,
    settings: readRuntimeSettings({}),
    factory: () => {
      targets++;
      throw new Error('No debe crear targets');
    },
  };
  try {
    await assert.rejects(
      new EvalRunner(options).run({ promptVersions: ['basic-v1', 'basic-v3'], split: 'dev' }),
      { code: 'incompatible_prompts' },
    );
    assert.deepEqual(await readdir(outputDir), []);
    const service = new LabEvaluationService({
      ...options,
      store,
      mode: 'demo',
      models: new Map([['openai', 'gpt-6-luna']]),
    });
    assert.throws(
      () =>
        service.start({
          provider: 'openai',
          operation: 'compare',
          promptVersion: 'basic-v1',
          promptVersions: ['basic-v1', 'basic-v3'],
          baselinePromptVersion: 'basic-v1',
          split: 'dev',
          compareModeration: false,
        }),
      { code: 'incompatible_prompts' },
    );
    assert.equal(store.listRuns().total, 0);
    assert.equal(targets, 0);
  } finally {
    store.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('UI: explica contexto incompatible sin reflejar mensajes enviados por el servidor', async () => {
  const api = new LabApi(async () =>
    Response.json(
      { error: { code: 'incompatible_prompts', message: 'SECRET texto arbitrario' } },
      { status: 400 },
    ),
  );
  await assert.rejects(
    api.start({
      provider: 'openai',
      operation: 'compare',
      promptVersion: 'basic-v1',
      split: 'dev',
      compareModeration: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /manual|moderación/);
      assert.doesNotMatch(error.message, /SECRET/);
      return true;
    },
  );
});
