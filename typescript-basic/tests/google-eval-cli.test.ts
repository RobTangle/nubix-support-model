/** Prueba los comandos de evaluación con Google, su procedencia y presupuestos mediante HTTP simulado. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { readReport } from '../src/evals/storage.js';
import { installedPackageVersion } from '../src/evals/package-version.js';

const cli = fileURLToPath(new URL('../dist/eval-cli.js', import.meta.url));
const mock = new URL('./fixtures/mock-fetch.mjs', import.meta.url).href;
const emptyEnv = fileURLToPath(new URL('./fixtures/empty-env.txt', import.meta.url));
const directories: string[] = [];
const prefix = join(tmpdir(), 'nubbix-google-eval-');

after(async () => {
  for (const directory of directories) {
    assert.ok(directory.startsWith(prefix));
    await rm(directory, { recursive: true, force: true });
  }
});

async function run(args: string[], overrides: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(prefix);
  directories.push(directory);
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(NUBBIX_|OPENAI_|XAI_|GEMINI_)/u.test(key)) delete env[key];
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      mock,
      cli,
      ...args,
      '--provider',
      'google-ai',
      '--env-file',
      emptyEnv,
      '--output-dir',
      directory,
    ],
    {
      cwd: tmpdir(),
      env: { ...env, GEMINI_API_KEY: 'fake-google-eval', ...overrides },
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const reports = await Promise.all(
    (await readdir(directory))
      .filter((name) => name.endsWith('.json'))
      .map((name) => readReport(join(directory, name))),
  );
  return { ...result, reports };
}

// La CLI usa el SDK y servicio reales; sólo fetch se sustituye para impedir llamadas y gastos.
// Los reportes temporales dicen live por recorrer ese borde, pero NO son evidencia del modelo.
for (const scenario of [
  { name: 'run', args: ['run', '--split', 'dev'], cases: 60, calls: [180] },
  {
    name: 'compare',
    args: ['compare', '--prompt-versions', 'basic-v1,basic-v2'],
    cases: 60,
    calls: [180, 180],
  },
  { name: 'adversarial', args: ['adversarial'], cases: 20, calls: [60] },
  {
    name: 'ablación',
    args: ['adversarial', '--compare-moderation'],
    cases: 20,
    calls: [20, 60],
  },
]) {
  test(`Google AI eval CLI: ${scenario.name} conserva casos, etapas y procedencia del SDK`, async () => {
    const result = await run(scenario.args);
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.equal(result.reports.length, scenario.calls.length);
    assert.equal(JSON.parse(result.stdout).selection, 'pending_human_review');
    assert.deepEqual(
      result.reports.map((report) => report.metrics.llmCalls).sort((a, b) => a - b),
      scenario.calls,
    );
    for (const report of result.reports) {
      assert.equal(report.provider, 'google-ai');
      assert.equal(report.model, 'gemini-3.5-flash-lite');
      assert.equal(report.complete, true);
      assert.equal(report.records.length, scenario.cases);
      assert.equal(report.metrics.operationalErrors, 0);
      assert.equal(report.metrics.usageComplete, true);
      assert.equal(report.metrics.knownInputTokens, report.metrics.llmCalls * 20);
      assert.equal(report.metrics.knownOutputTokens, report.metrics.llmCalls * 10);
      assert.ok(Number(report.metrics.knownCostUsd) > 0);
      assert.equal(
        report.provenance.sdkVersions['google-ai'],
        await installedPackageVersion('@google/genai'),
      );
      assert.ok(report.records.every((row) => row.trace?.provider === 'google-ai'));
    }
    if (scenario.name === 'compare')
      assert.deepEqual(result.reports.map((report) => report.promptVersion).sort(), [
        'basic-v1',
        'basic-v2',
      ]);
  });
}

test('Google AI eval CLI: exige su clave antes de generar reportes', async () => {
  const result = await run(['run'], { GEMINI_API_KEY: '' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'missing_key');
  assert.equal(result.stdout, '');
  assert.equal(result.reports.length, 0);
});

test('eval CLI: políticas distintas se rechazan sin producir reportes ni ejecutar casos', async () => {
  const result = await run([
    'compare',
    '--prompt-versions',
    'basic-v3,basic-v4',
    '--baseline-prompt',
    'basic-v3',
  ]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error.code, 'incompatible_prompts');
  assert.equal(result.reports.length, 0);
});

test('Google AI eval CLI: presupuesto agotado preserva checkpoints y casos pendientes', async () => {
  const result = await run(['compare', '--prompt-versions', 'basic-v1,basic-v2'], {
    NUBBIX_EVAL_BUDGET_USD: '0.000001',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.reports.length, 2);
  assert.equal(
    result.reports.reduce((sum, report) => sum + report.metrics.notRunCases, 0),
    119,
  );
  assert.ok(result.reports.every((report) => !report.complete));
  assert.ok(result.reports.every((report) => report.stopReason === 'eval_budget_exceeded'));
  assert.ok(result.reports.every((report) => report.metrics.llmCalls === 0));
});

test('eval CLI: selección de variantes y baseline explícito provienen del registro', async () => {
  const result = await run([
    'compare',
    '--prompt-versions',
    'basic-v2,basic-v1',
    '--baseline-prompt',
    'basic-v2',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.reports.map((report) => report.promptVersion).sort(), [
    'basic-v1',
    'basic-v2',
  ]);
  assert.ok(
    result.reports.every((report) => report.provenance.baselinePromptVersion === 'basic-v2'),
  );
  const rejected = await run(['compare', '--prompt-versions', 'basic-v1,unknown']);
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stderr).error.code, 'invalid_arguments');
  assert.equal(rejected.reports.length, 0);
});

test('eval CLI: listar prompts es offline y publica defaults y etiquetas del registro', () => {
  const result = spawnSync(process.execPath, [cli, '--list-prompts'], {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const listed = JSON.parse(result.stdout);
  assert.equal(listed.defaultVersion, 'basic-v1');
  assert.equal(listed.baselineVersion, 'basic-v1');
  assert.ok(
    listed.versions.every((entry: { id: string; label: string }) => entry.id && entry.label),
  );
});
