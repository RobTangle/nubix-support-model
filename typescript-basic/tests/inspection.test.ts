import assert from 'node:assert/strict';
import test from 'node:test';
import { RunInspection } from '../src/inspection/run-inspection.js';
import type { InspectionEntry } from '../src/inspection/contracts.js';
import { SupportAssistant } from '../src/support/service.js';
import { loadPrompts } from '../src/prompting/prompts.js';
import { loadPrices } from '../src/costs/budget.js';
import type { FlowEvent } from '../src/observability/events.js';
import { AppError } from '../src/errors.js';

const requestId = '11111111-1111-4111-8111-111111111111';

test('inspección: captura JSON acotado por un canal diferente con identidad y secuencia', async () => {
  const rows: InspectionEntry[] = [];
  const inspector = new RunInspection(requestId, (entry) => {
    rows.push(entry);
  });
  await inspector.record('input.received', { text: 'Factura privada' });
  await inspector.record('input.validated', { text: 'Factura privada' });
  assert.deepEqual(
    rows.map((row) => row.sequence),
    [1, 2],
  );
  assert.equal(rows[0]!.requestId, requestId);
  assert.deepEqual(rows[0]!.data, { text: 'Factura privada' });
  assert.ok(Number.isFinite(Date.parse(rows[0]!.timestamp)));
});

test('consumo: error del proveedor posterior al aborto conserva tokens conocidos', async () => {
  const controller = new AbortController();
  const assistant = new SupportAssistant({
    providerName: 'openai',
    model: 'gpt-6-luna',
    prompts: await loadPrompts(),
    prices: await loadPrices(),
    provider: {
      async complete() {
        controller.abort();
        throw new AppError('cancelled', {
          usage: {
            inputTokens: 17,
            outputTokens: 3,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
          },
        });
      },
    },
  });
  await assert.rejects(
    assistant.process({ text: 'Factura' }, { signal: controller.signal }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.trace!.attempts[0]!.inputTokens, 17);
      assert.ok(Number(error.trace!.knownCostUsd) > 0);
      return true;
    },
  );
});

test('inspector: trunca capturas grandes y conserva consumo si falla archivar una respuesta', async () => {
  const rows: InspectionEntry[] = [];
  await new RunInspection(requestId, (row) => {
    rows.push(row);
  }).record('llm.response', { text: 'x'.repeat(200_000) });
  assert.match(JSON.stringify(rows[0]!.data), /"truncated":true/);
  assert.ok(JSON.stringify(rows[0]).length < 20_000);
  const assistant = new SupportAssistant({
    providerName: 'openai',
    model: 'gpt-6-luna',
    prompts: await loadPrompts(),
    prices: await loadPrices(),
    provider: {
      async complete() {
        return {
          status: 'completed',
          text: '{"decision":"allow"}',
          usage: {
            inputTokens: 11,
            outputTokens: 3,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
          },
        };
      },
    },
  });
  await assert.rejects(
    assistant.process(
      { text: 'Factura' },
      {
        inspect: (row) => {
          if (row.kind === 'llm.response') throw new Error('Contenido privado');
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'report_error');
      assert.equal(error.trace!.attempts[0]!.inputTokens, 11);
      assert.doesNotMatch(error.message, /privado/);
      return true;
    },
  );
});

test('servicio: inspector muestra request, esquema y moderación pero eventos siguen sin contenido', async () => {
  const rows: InspectionEntry[] = [];
  const events: FlowEvent[] = [];
  const assistant = new SupportAssistant({
    providerName: 'openai',
    model: 'gpt-6-luna',
    prompts: await loadPrompts(),
    prices: await loadPrices(),
    provider: {
      async complete(request) {
        return {
          status: 'completed',
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
          },
          text: JSON.stringify(
            request.schemaName === 'safety_assessment'
              ? { decision: 'allow' }
              : { answer: 'Respuesta privada', confidence: 0.8, category: 'billing', actions: [] },
          ),
        };
      },
    },
  });
  await assistant.process(
    { text: ' TICKET PRIVADO ' },
    {
      requestId,
      inspect: (row: InspectionEntry) => {
        rows.push(row);
      },
      observe: (event) => {
        events.push(event);
      },
    },
  );
  assert.equal(rows[0]!.kind, 'input.received');
  assert.equal(rows.filter((row) => row.kind === 'llm.request').length, 3);
  assert.equal(rows.filter((row) => row.kind === 'llm.response').length, 3);
  const moderation = rows.find(
    (row) => row.kind === 'schema.validation' && row.stage === 'input_moderation',
  )!;
  assert.match(JSON.stringify(moderation.data), /allow/);
  assert.match(JSON.stringify(rows), /TICKET PRIVADO|Respuesta privada/);
  assert.doesNotMatch(JSON.stringify(events), /TICKET PRIVADO|Respuesta privada|systemPrompt/);
  assert.deepEqual(
    events.map((event) => event.sequence),
    events.map((_, index) => index + 1),
  );
});
