import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { RunReport } from '../src/run-reports/types.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const mock = new URL('./fixtures/mock-fetch.mjs', import.meta.url).href;
const emptyEnv = fileURLToPath(new URL('./fixtures/empty-env.txt', import.meta.url));

// Se pasan rutas absolutas y otro cwd para detectar recursos que dependan de la terminal.
function run(args: string[], input?: string, mode = 'success', reportsDir?: string) {
  const env = {
    ...process.env,
    OPENAI_API_KEY: 'fake-test',
    GEMINI_API_KEY: 'fake-gemini-test',
    NUBBIX_TEST_MODE: mode,
  };
  const directory = reportsDir ?? mkdtempSync(join(tmpdir(), 'nubbix-cli-reports-'));
  try {
    const result = spawnSync(
      process.execPath,
      ['--import', mock, cli, '--env-file', emptyEnv, '--reports-dir', directory, ...args],
      {
        cwd: tmpdir(),
        env,
        encoding: 'utf8',
        timeout: 10_000,
        ...(input === undefined ? {} : { input }),
      },
    );
    const reports: RunReport[] = [];
    if (existsSync(directory) && statSync(directory).isDirectory()) {
      for (const ticket of readdirSync(directory)) {
        for (const name of readdirSync(join(directory, ticket))) {
          if (name.endsWith('.json'))
            reports.push(
              JSON.parse(readFileSync(join(directory, ticket, name), 'utf8')) as RunReport,
            );
        }
      }
    }
    return { ...result, reports };
  } finally {
    if (reportsDir === undefined) rmSync(directory, { recursive: true, force: true });
  }
}

test('help no usa claves y no hay efectos al importar la biblioteca', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--stdin/);
  assert.equal(help.stderr, '');
  const library = new URL('../dist/index.js', import.meta.url).href;
  const imported = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `globalThis.fetch=()=>{throw Error('red inesperada')}; await import(${JSON.stringify(library)});`,
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  assert.equal(imported.stderr, '');
});

test('CLI publica sólo JSON y encuentra su YAML fuera del repositorio', () => {
  const result = run(['--text', '  Factura de octubre  ', '--provider', 'openai']);
  assert.equal(result.status, 0, result.stderr);
  const logs = result.stderr
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    logs.map((line) => line.event),
    ['llm_attempt', 'llm_attempt', 'llm_attempt', 'run_summary'],
  );
  assert.doesNotMatch(result.stderr, /Factura de octubre|Recibido:/);
  assert.deepEqual(JSON.parse(result.stdout), {
    answer: 'Recibido: Factura de octubre',
    confidence: 0.8,
    category: 'billing',
    actions: [],
  });
});

test('stdin conserva Unicode y recibe una sola consulta', () => {
  const result = run(['--stdin'], 'Cargo en mi suscripción 👩‍💻\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).answer, 'Recibido: Cargo en mi suscripción 👩‍💻');
});

test('entrada inválida o argumentos incompatibles fallan sin stdout', () => {
  for (const [args, input] of [
    [[], undefined],
    [['--text', ' '], undefined],
    [['--text', 'x', '--stdin'], undefined],
    [['--stdin'], 'x'.repeat(8001)],
    [['--unknown'], undefined],
  ] as const) {
    const result = run([...args], input);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(JSON.parse(result.stderr).error.code, /invalid_input|invalid_arguments/);
  }
});

test('fallos del proveedor salen por stderr sin datos privados', () => {
  const result = run(['--text', 'Consulta'], undefined, 'failure');
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  const logs = result.stderr
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(logs.at(-1).error.code, 'authentication');
  assert.doesNotMatch(result.stderr, /secret-test-key|privado|fake-test/);
});

test('SIGINT cancela también el flush bloqueado y conserva el error de cancelación', () => {
  const result = run(['--text', 'Consulta'], undefined, 'blocked_stderr');
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error.code, 'cancelled');
});

test('CLI archiva ticket, respuesta, salidas intermedias y configuración sin credenciales', () => {
  const result = run(['--text', '  Factura de octubre  ', '--provider', 'openai']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.reports.length, 1);
  const report = result.reports[0]!;
  assert.equal(report.formatVersion, 2);
  assert.equal(report.state, 'finished');
  assert.equal(report.runId, report.trace?.requestId);
  assert.match(report.reportId, /^[0-9a-f-]{36}$/);
  assert.match(report.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(report.finishedAt && report.finishedAt >= report.startedAt);
  assert.equal(report.ticket.text, '  Factura de octubre  ');
  assert.equal(report.ticket.normalizedText, 'Factura de octubre');
  assert.match(report.ticket.id, /^[0-9a-f]{64}$/);
  assert.deepEqual(report.response, JSON.parse(result.stdout));
  assert.equal(report.error, null);
  assert.equal(report.trace?.status, 'ok');
  assert.equal(report.trace?.attempts.length, 3);
  assert.deepEqual(
    report.rawOutputs.map((item) => item.stage),
    ['input_moderation', 'generation', 'output_moderation'],
  );
  assert.equal(JSON.parse(report.rawOutputs[1]!.text).answer, 'Recibido: Factura de octubre');
  assert.equal(report.configuration.runtimeSettings.moderationMaxTokens, 128);
  assert.equal(report.configuration.prompts.version, 'basic-v1');
  assert.ok(report.configuration.prompts.system.length > 0);
  assert.deepEqual(report.configuration.prompts.hashes, report.trace?.contextHashes);
  assert.equal(report.configuration.schemas.response.type, 'object');
  assert.match(report.configuration.prices.source, /openai:gpt-6-luna/);
  assert.equal(report.configuration.prices.version, report.trace?.priceVersion);
  assert.ok(report.application.sdkVersions.openai);
  assert.ok(report.application.version);
  assert.doesNotMatch(
    JSON.stringify(report),
    /fake-test|OPENAI_API_KEY|Authorization|secret-test-key/,
  );
  assert.doesNotMatch(result.stderr, /Factura de octubre|Recibido:/);
});

test('CLI archiva también fallos operativos y cancelaciones sin publicar una respuesta', () => {
  for (const [mode, code] of [
    ['failure', 'authentication'],
    ['blocked_stderr', 'cancelled'],
  ] as const) {
    const result = run(['--text', 'Consulta'], undefined, mode);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.reports.length, 1);
    const report = result.reports[0]!;
    assert.equal(report.state, 'finished');
    assert.equal(report.response, null);
    assert.equal(report.error?.code, code);
    assert.equal(report.trace?.status, 'error');
    assert.equal(report.trace?.errorCode, code);
    assert.doesNotMatch(JSON.stringify(report), /secret-test-key|fake-test|ticket privado/);
  }
});

test('CLI archiva Google con el SDK y el modelo efectivamente seleccionados', () => {
  const result = run(['--text', 'Factura', '--provider', 'google-ai']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.reports.length, 1);
  const report = result.reports[0]!;
  assert.equal(report.invocation.provider, 'google-ai');
  assert.equal(report.invocation.model, 'gemini-3.5-flash-lite');
  assert.ok(report.application.sdkVersions['google-ai']);
  assert.equal(report.trace?.provider, 'google-ai');
  assert.equal(report.trace?.attempts.length, 3);
  assert.equal(report.rawOutputs.length, 3);
  assert.deepEqual(report.response, JSON.parse(result.stdout));
  assert.doesNotMatch(JSON.stringify(report), /fake-gemini-test|fake-test/);
});

test('CLI conserva el reporte si SIGINT llega durante el archivado final', () => {
  const result = run(['--text', 'Factura'], undefined, 'report_sigint');
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.reports.length, 1);
  const report = result.reports[0]!;
  assert.equal(report.state, 'finished');
  assert.equal(report.error?.code, 'cancelled');
  assert.equal(report.trace?.status, 'error');
  assert.equal(report.trace?.errorCode, 'cancelled');
  assert.equal(report.trace?.attempts.length, 3);
  assert.equal(report.rawOutputs.length, 3);
  assert.equal(report.response, null);
});

test('CLI resuelve el directorio predeterminado desde el proyecto y no desde cwd', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nubbix-isolated-cli-'));
  try {
    cpSync(new URL('../dist/', import.meta.url), join(directory, 'dist'), { recursive: true });
    copyFileSync(new URL('../package.json', import.meta.url), join(directory, 'package.json'));
    symlinkSync(
      fileURLToPath(new URL('../node_modules/', import.meta.url)),
      join(directory, 'node_modules'),
      'junction',
    );
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        mock,
        join(directory, 'dist', 'cli.js'),
        '--env-file',
        emptyEnv,
        '--text',
        'Factura',
      ],
      {
        cwd: tmpdir(),
        env: { ...process.env, OPENAI_API_KEY: 'fake-test', NUBBIX_TEST_MODE: 'success' },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const root = join(directory, 'reports', 'manual-tests');
    const tickets = readdirSync(root);
    assert.equal(tickets.length, 1);
    const files = readdirSync(join(root, tickets[0]!));
    assert.equal(files.length, 1);
    const report = JSON.parse(
      readFileSync(join(root, tickets[0]!, files[0]!), 'utf8'),
    ) as RunReport;
    assert.equal(report.state, 'finished');
    assert.equal(report.invocation.workingDirectory, tmpdir());
    assert.deepEqual(report.response, JSON.parse(result.stdout));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI conserva ejecuciones repetidas del mismo ticket sin sobrescribir archivos', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nubbix-repeated-runs-'));
  try {
    const first = run(['--text', 'Factura'], undefined, 'success', directory);
    assert.equal(first.status, 0, first.stderr);
    const second = run(['--stdin'], 'Factura', 'success', directory);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.reports.length, 2);
    assert.equal(new Set(second.reports.map((item) => item.ticket.id)).size, 1);
    assert.equal(new Set(second.reports.map((item) => item.reportId)).size, 2);
    assert.deepEqual(
      second.reports.find((item) => item.reportId === first.reports[0]!.reportId),
      first.reports[0],
    );
    assert.deepEqual(second.reports.map((item) => item.invocation.inputSource).sort(), [
      'stdin',
      'text',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI rechaza un destino de reportes inválido antes de consultar al proveedor', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nubbix-invalid-reports-'));
  try {
    const destination = join(directory, 'existing-file');
    writeFileSync(destination, 'conservar');
    const result = run(['--text', 'Consulta'], undefined, 'success', destination);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'report_error');
    assert.equal(readFileSync(destination, 'utf8'), 'conservar');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
