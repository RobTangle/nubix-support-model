import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { LabStore } from '../src/lab/storage.js';
import { summarize } from '../src/evals/metrics.js';
import type { EvaluationReport } from '../src/evals/types.js';

const input = () => ({
  id: randomUUID(),
  kind: 'support' as const,
  mode: 'demo' as const,
  provider: 'openai',
  model: 'fixture',
  promptVersion: 'basic-v1',
  input: { text: '  Factura original  ' },
});

test('SQLite: persiste, pagina y separa eventos e inspecciones por corrida', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-store-'));
  const path = join(directory, 'lab.sqlite');
  const first = input();
  const second = input();
  const store = new LabStore(path);
  try {
    store.createRun(first);
    store.createRun(second);
    store.appendInspection(first.id, {
      requestId: first.id,
      sequence: 1,
      timestamp: new Date().toISOString(),
      kind: 'input.received',
      data: first.input,
    });
    assert.throws(() =>
      store.appendInspection(second.id, {
        requestId: first.id,
        sequence: 1,
        timestamp: new Date().toISOString(),
        kind: 'input.received',
        data: {},
      }),
    );
    assert.throws(() =>
      store.appendInspection(first.id, {
        requestId: first.id,
        sequence: 3,
        timestamp: new Date().toISOString(),
        kind: 'input.received',
        data: {},
      }),
    );
    store.finishRun(first.id, { status: 'completed', result: { answer: 'Respuesta' } });
    assert.equal(store.listRuns({ limit: 1, offset: 0 }).total, 2);
    assert.equal(store.listRuns({ limit: 1, offset: 1 }).items.length, 1);
    assert.equal(store.listRuns({ kind: 'evaluation' }).total, 0);
    store.close();
    const reopened = new LabStore(path);
    try {
      const detail = reopened.getRun(first.id)!;
      assert.deepEqual(detail.input, first.input);
      assert.equal(detail.status, 'completed');
      assert.equal(detail.inspections.length, 1);
      assert.deepEqual(detail.events, []);
      assert.equal(reopened.getRun(second.id)!.status, 'interrupted');
      assert.equal(reopened.getRun(randomUUID()), null);
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite: recupera procesos muertos y no interrumpe dueños vivos', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-owner-'));
  const path = join(directory, 'lab.sqlite');
  const first = new LabStore(path);
  const live = input();
  const abandoned = input();
  try {
    first.createRun(live);
    first.createRun(abandoned);
    const database = new DatabaseSync(path);
    database.prepare('UPDATE runs SET owner_pid = ? WHERE id = ?').run(2_147_483_647, abandoned.id);
    database.close();
    const second = new LabStore(path);
    try {
      assert.equal(second.getRun(live.id)!.status, 'running');
      assert.equal(second.getRun(abandoned.id)!.status, 'interrupted');
    } finally {
      second.close();
    }
    assert.equal(first.getRun(live.id)!.status, 'running');
  } finally {
    first.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite: sanitiza corrupción, validación y escritura después de cierre', () => {
  const store = new LabStore(':memory:');
  assert.throws(() => store.createRun({ ...input(), id: 'invalid' }), { code: 'report_error' });
  store.close();
  assert.throws(() => store.createRun(input()), { code: 'report_error' });
});

test('SQLite: checkpoints y revisiones conservan pertenencia y validan contenido', () => {
  const store = new LabStore(':memory:');
  const job = { ...input(), kind: 'evaluation' as const };
  const other = { ...input(), kind: 'evaluation' as const };
  const records: EvaluationReport['records'] = [
    {
      id: 'case-1',
      text: 'Sintético',
      kind: 'ticket',
      expectedCategory: 'billing',
      expectedActions: [],
      forbiddenPatterns: [],
      scenario: 'fixture',
      response: null,
      trace: null,
      errorCode: null,
      notRun: true,
      latencyMs: 0,
      rawOutputs: [],
      publishedRuleFlags: [],
      intermediateRuleFlags: [],
    },
  ];
  const report: EvaluationReport = {
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
    provider: 'openai',
    model: 'fixture',
    promptVersion: 'basic-v1',
    split: 'dev',
    suite: 'all',
    mode: 'full',
    complete: false,
    stopReason: null,
    records,
    metrics: summarize(records),
    provenance: {
      application: 'nubbix-support-basic-ts',
      applicationVersion: 'test',
      reportVersion: 1,
      evidence: 'fake',
      datasetHashes: { tickets: 'a'.repeat(64), adversarial: 'b'.repeat(64) },
      promptHashes: Object.fromEntries(
        [
          'system',
          'manual',
          'safety',
          'inputModeration',
          'outputModeration',
          'repair',
          'examples',
        ].map((key) => [key, 'c'.repeat(64)]),
      ),
      schemaHash: 'd'.repeat(64),
      priceHash: 'e'.repeat(64),
      priceVersion: '1',
      settingsHash: 'f'.repeat(64),
      settings: {},
      manualVersion: '1',
      safetyVersion: '1',
      canaryEnabled: true,
      sdkVersions: {},
    },
  };
  const review = {
    runId: report.runId,
    caseId: 'case-1',
    usefulness: null,
    correctness: null,
    policy: null,
    severeIssue: null,
    attackSucceeded: null,
    unjustifiedRefusal: null,
    notes: 'Pendiente',
  };
  try {
    store.createRun(job);
    store.createRun(other);
    store.saveReport(job.id, report);
    store.saveReport(job.id, { ...report, stopReason: 'cancelled' });
    assert.equal(store.getReports(job.id).length, 1);
    assert.equal(store.getReports(job.id)[0]!.stopReason, 'cancelled');
    assert.deepEqual(store.getReports(other.id), []);
    assert.throws(() => store.saveReport(other.id, report), { code: 'report_error' });
    store.saveReview(report.runId, review);
    store.saveReview(report.runId, { ...review, notes: 'Actualizada' });
    assert.equal(store.getReviews(report.runId).length, 1);
    assert.equal(store.getReviews(report.runId)[0]!.notes, 'Actualizada');
    assert.throws(() => store.saveReview(report.runId, { ...review, caseId: 'inexistente' }), {
      code: 'report_error',
    });
    assert.throws(() => store.saveReview(report.runId, { ...review, attackSucceeded: true }), {
      code: 'report_error',
    });
    assert.throws(() => store.saveReport(job.id, { ...report, complete: true }), {
      code: 'report_error',
    });
    assert.deepEqual(store.getReviews(randomUUID()), []);
  } finally {
    store.close();
  }
});

test('SQLite: conserva eventos ordenados y sanitiza mensajes arbitrarios', () => {
  const store = new LabStore(':memory:');
  const run = input();
  const event = {
    schemaVersion: 1 as const,
    requestId: run.id,
    sequence: 1,
    timestamp: new Date().toISOString(),
    elapsedMs: 0,
    durationMs: null,
    provider: 'openai',
    model: 'fixture',
    promptVersion: 'basic-v1',
    event: 'request.received' as const,
    details: {},
  };
  try {
    store.createRun(run);
    store.appendEvent(run.id, event);
    assert.throws(() => store.appendEvent(run.id, event), { code: 'report_error' });
    store.appendEvent(run.id, { ...event, sequence: 2, event: 'run.failed' });
    store.finishRun(run.id, {
      status: 'failed',
      error: { code: 'provider_error', message: 'SECRET SDK body' },
    });
    const detail = store.getRun(run.id)!;
    assert.deepEqual(
      detail.events.map((entry) => entry.sequence),
      [1, 2],
    );
    assert.doesNotMatch(detail.error!.message, /SECRET/);
    assert.throws(() => store.appendEvent(run.id, { ...event, sequence: 3 }), {
      code: 'report_error',
    });
    assert.throws(() => store.finishRun(run.id, { status: 'completed', result: {} }), {
      code: 'report_error',
    });
  } finally {
    store.close();
  }
});

test('SQLite: migración v1 usa WAL y la lectura corrupta no expone su contenido', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-corrupt-'));
  const path = join(directory, 'lab.sqlite');
  const store = new LabStore(path);
  const run = input();
  const database = new DatabaseSync(path);
  try {
    store.createRun(run);
    assert.equal(database.prepare('PRAGMA user_version').get()!['user_version'], 1);
    assert.equal(database.prepare('PRAGMA journal_mode').get()!['journal_mode'], 'wal');
    database
      .prepare('UPDATE runs SET input_json = ? WHERE id = ?')
      .run('SECRET invalid JSON', run.id);
    assert.throws(
      () => store.getRun(run.id),
      (error: unknown) => {
        assert.ok(error instanceof Error && 'code' in error);
        assert.equal(error.code, 'report_error');
        assert.doesNotMatch(error.message, /SECRET|JSON|sqlite|lab-corrupt/i);
        return true;
      },
    );
  } finally {
    database.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
