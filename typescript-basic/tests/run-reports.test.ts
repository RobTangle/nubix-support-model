/** Prueba el escritor JSON en disco temporal: reservas, snapshots y corridas concurrentes independientes. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { loadPrices } from '../src/budget.js';
import { loadPrompts } from '../src/prompts.js';
import { readRuntimeSettings } from '../src/runtime-settings.js';
import { RunReportWriter } from '../src/run-reports/writer.js';
import type { RunReport } from '../src/run-reports/types.js';

test('reportes: reserva inicial y escrituras concurrentes conservan corridas independientes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nubbix-report-writer-'));
  try {
    const options = {
      directory,
      text: ' Factura ',
      normalizedText: 'Factura',
      inputSource: 'text' as const,
      provider: 'openai' as const,
      model: 'gpt-6-luna',
      prompts: await loadPrompts(),
      prices: await loadPrices(),
      runtimeSettings: readRuntimeSettings({}),
    };
    const writers = await Promise.all([
      RunReportWriter.create(options),
      RunReportWriter.create(options),
    ]);
    assert.notEqual(writers[0]!.path, writers[1]!.path);
    assert.equal(dirname(writers[0]!.path), dirname(writers[1]!.path));
    const initial = JSON.parse(await readFile(writers[0]!.path, 'utf8')) as RunReport;
    assert.equal(initial.state, 'running');
    assert.equal(initial.finishedAt, null);
    assert.equal(initial.runId, null);
    assert.equal(initial.response, null);
    assert.equal(initial.trace, null);
    assert.equal(initial.configuration.prices.source, options.prices.source);
    options.prompts.system = 'Cambio posterior';
    await Promise.all(
      writers.map((writer) =>
        writer.finish({
          response: null,
          trace: null,
          error: { code: 'configuration_error', message: 'Configuración inválida' },
          rawOutputs: [],
        }),
      ),
    );
    const finished = await Promise.all(
      writers.map(async (writer) => JSON.parse(await readFile(writer.path, 'utf8')) as RunReport),
    );
    assert.equal(finished.length, 2);
    for (const report of finished) {
      assert.equal(report.state, 'finished');
      assert.equal(report.error?.code, 'configuration_error');
      assert.notEqual(report.configuration.prompts.system, options.prompts.system);
    }
    assert.equal((await readdir(dirname(writers[0]!.path))).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
