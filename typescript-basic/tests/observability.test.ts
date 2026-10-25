import assert from 'node:assert/strict';
import test from 'node:test';
import { RunObserver } from '../src/observability/run-observer.js';
import { flowEventSchema, type FlowEvent } from '../src/observability/events.js';
import { SupportAssistant } from '../src/support/service.js';
import { loadPrices } from '../src/costs/budget.js';
import { loadPrompts } from '../src/prompting/prompts.js';
import type { LLMProvider } from '../src/llm/provider-types.js';
import { AppError } from '../src/errors.js';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventSink } from '../src/observability/event-sink.js';

const identity = {
  requestId: '11111111-1111-4111-8111-111111111111',
  provider: 'openai',
  model: 'gpt-6-luna',
  promptVersion: 'basic-v1',
};

test('observación: secuencia, UTC y duraciones monotónicas locales a cada corrida', async () => {
  const events: FlowEvent[] = [];
  let monotonic = 10;
  const observer = new RunObserver(
    identity,
    (event) => {
      events.push(event);
    },
    {
      now: () => monotonic,
      timestamp: () => new Date('2026-10-25T12:00:00.000Z'),
    },
  );
  await observer.emit('request.received');
  monotonic = 25;
  await observer.emit('input.validation.completed', { inputLength: 15 }, { durationMs: 3 });
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2],
  );
  assert.deepEqual(
    events.map((event) => event.elapsedMs),
    [0, 15],
  );
  assert.equal(events[1]!.timestamp, '2026-10-25T12:00:00.000Z');
  assert.equal(events[1]!.durationMs, 3);
  assert.equal(events[0]!.durationMs, null);
  assert.ok(events.every((event) => flowEventSchema.safeParse(event).success));
  const other: FlowEvent[] = [];
  const second = new RunObserver(
    { ...identity, requestId: '22222222-2222-4222-8222-222222222222' },
    (event) => {
      other.push(event);
    },
  );
  await second.emit('request.received');
  assert.equal(other[0]!.sequence, 1);
});

test('observación: rechaza metadatos no permitidos y nunca entrega contenido al sink', async () => {
  const events: FlowEvent[] = [];
  const observer = new RunObserver(identity, (event) => {
    events.push(event);
  });
  await assert.rejects(observer.emit('request.received', { ticket: 'PRIVADO' } as never));
  assert.equal(events.length, 0);
  await observer.emit('run.completed', { status: 'ok' });
  assert.doesNotMatch(JSON.stringify(events), /PRIVADO|ticket|apiKey/);
});

const usage = { inputTokens: 20, outputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0 };
const answer = { answer: 'RESPUESTA PRIVADA', confidence: 0.8, category: 'billing', actions: [] };

async function assistant(complete: LLMProvider['complete'], settings = {}) {
  return new SupportAssistant({
    provider: { complete },
    providerName: 'openai',
    model: 'gpt-6-luna',
    prices: await loadPrices(),
    prompts: await loadPrompts(),
    settings,
  });
}

test('servicio: eventos reales de tres requests, schema y costos sin contenido privado', async () => {
  const events: FlowEvent[] = [];
  const service = await assistant(async (request) => ({
    text: JSON.stringify(
      request.schemaName === 'safety_assessment' ? { decision: 'allow' } : answer,
    ),
    status: 'completed',
    usage,
  }));
  const result = await service.process(
    { text: 'TICKET PRIVADO' },
    {
      observe: (event: FlowEvent) => {
        events.push(event);
      },
    },
  );
  assert.equal(result.response.answer, answer.answer);
  assert.equal(events[0]!.event, 'request.received');
  assert.equal(events.at(-1)!.event, 'run.completed');
  assert.deepEqual(
    events.filter((event) => event.event === 'llm.request.started').map((event) => event.stage),
    ['input_moderation', 'generation', 'output_moderation'],
  );
  assert.equal(events.filter((event) => event.event === 'schema.validation.completed').length, 3);
  assert.equal(events.filter((event) => event.event === 'usage.recorded').length, 3);
  assert.equal(events.filter((event) => event.details.decision === 'allow').length, 2);
  assert.ok(events.every((event) => event.requestId === result.trace.requestId));
  assert.deepEqual(
    events.map((event) => event.sequence),
    events.map((_, index) => index + 1),
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /TICKET PRIVADO|RESPUESTA PRIVADA|systemPrompt|userContent/,
  );
});

test('servicio: observar y cancelar una corrida no mezcla eventos ni interrumpe otra', async () => {
  const service = await assistant(async (request) => {
    await delay(15, undefined, { signal: request.signal });
    return {
      text: JSON.stringify(
        request.schemaName === 'safety_assessment' ? { decision: 'allow' } : answer,
      ),
      status: 'completed',
      usage,
    };
  });
  const first: FlowEvent[] = [];
  const second: FlowEvent[] = [];
  const controller = new AbortController();
  const cancelled = service.process(
    { text: 'Factura uno' },
    {
      signal: controller.signal,
      observe: (event) => {
        first.push(event);
        if (event.event === 'llm.request.started') controller.abort();
      },
    },
  );
  const succeeded = service.process(
    { text: 'Factura dos' },
    {
      observe: (event) => {
        second.push(event);
      },
    },
  );
  await assert.rejects(
    cancelled,
    (error: unknown) => error instanceof AppError && error.code === 'cancelled',
  );
  const result = await succeeded;
  assert.equal(second.at(-1)!.event, 'run.completed');
  assert.notEqual(first[0]!.requestId, second[0]!.requestId);
  assert.ok(second.every((event) => event.requestId === result.trace.requestId));
  assert.deepEqual(
    second.map((event) => event.sequence),
    second.map((_, index) => index + 1),
  );
});

test('servicio: presupuesto insuficiente no anuncia una request y observer lento respeta deadline', async () => {
  let calls = 0;
  const provider: LLMProvider['complete'] = async () => {
    calls++;
    return { text: '{"decision":"allow"}', status: 'completed', usage };
  };
  const events: FlowEvent[] = [];
  const budgeted = await assistant(provider, { ticketBudgetUsd: '0.000001' });
  await assert.rejects(
    budgeted.process(
      { text: 'Factura' },
      {
        observe: (event) => {
          events.push(event);
        },
      },
    ),
    (error: unknown) => error instanceof AppError && error.code === 'budget_exceeded',
  );
  assert.equal(calls, 0);
  assert.equal(
    events.some((event) => event.event === 'llm.request.started'),
    false,
  );
  assert.equal(events.at(-1)!.event, 'run.failed');
  const bounded = await assistant(provider, { deadlineMs: 20 });
  const keepAlive = setTimeout(() => {}, 200);
  try {
    await assert.rejects(
      bounded.process({ text: 'Factura' }, { observe: () => new Promise<void>(() => {}) }),
      (error: unknown) => error instanceof AppError && error.code === 'deadline_exceeded',
    );
    assert.equal(calls, 0);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('servicio: bloqueo corta requests y reparación expone un segundo intento', async () => {
  let generation = 0;
  const service = await assistant(async (request) => {
    if (request.schemaName === 'support_response') generation++;
    return {
      text:
        request.schemaName === 'support_response' && generation === 1
          ? 'JSON inválido privado'
          : JSON.stringify(
              request.schemaName === 'safety_assessment' ? { decision: 'allow' } : answer,
            ),
      status: 'completed',
      usage,
    };
  });
  const events: FlowEvent[] = [];
  await service.process(
    { text: 'Factura' },
    {
      observe: (event: FlowEvent) => {
        events.push(event);
      },
    },
  );
  assert.equal(events.filter((event) => event.event === 'llm.request.started').length, 4);
  assert.equal(
    events.find((event) => event.event === 'retry.scheduled')?.details.code,
    'invalid_output',
  );
  assert.equal(
    events.filter(
      (event) => event.stage === 'generation' && event.event === 'llm.request.started',
    )[1]!.attempt,
    2,
  );
  assert.doesNotMatch(JSON.stringify(events), /JSON inválido privado/);
  events.length = 0;
  const blocked = await assistant(async () => ({
    text: '{"decision":"block"}',
    status: 'completed',
    usage,
  }));
  const result = await blocked.process(
    { text: 'Ataque' },
    {
      observe: (event: FlowEvent) => {
        events.push(event);
      },
    },
  );
  assert.equal(events.filter((event) => event.event === 'llm.request.started').length, 1);
  assert.equal(events.at(-1)!.details.status, 'blocked');
  assert.equal(result.trace.abstained, true);
});

test('servicio: fallo de observación después del SDK conserva tokens y costo conocido', async () => {
  const service = await assistant(async () => ({
    text: '{"decision":"allow"}',
    status: 'completed',
    usage,
  }));
  await assert.rejects(
    service.process(
      { text: 'Factura' },
      {
        observe: (event: FlowEvent) => {
          if (event.event === 'llm.request.completed') throw new Error('ERROR PRIVADO');
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'telemetry_error');
      assert.equal(error.trace?.attempts[0]?.inputTokens, 20);
      assert.ok(Number(error.trace?.knownCostUsd) > 0);
      assert.doesNotMatch(error.message, /ERROR PRIVADO/);
      return true;
    },
  );
});

test('servicio: SDK que informa consumo después del deadline conserva los tokens conocidos', async () => {
  const service = await assistant(
    async () => {
      await delay(35);
      return { text: '{"decision":"allow"}', status: 'completed', usage };
    },
    { deadlineMs: 15 },
  );
  await assert.rejects(
    service.process({ text: 'Factura' }, { observe: () => {} }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'deadline_exceeded');
      assert.equal(error.trace?.attempts[0]?.inputTokens, 20);
      assert.equal(error.trace?.attempts[0]?.outputTokens, 10);
      assert.ok(Number(error.trace?.knownCostUsd) > 0);
      return true;
    },
  );
});

test('logs compartidos: cancelar una request no envenena el archivo de las siguientes', async () => {
  const prefix = join(tmpdir(), 'nubbix-shared-events-');
  const directory = await mkdtemp(prefix);
  const path = join(directory, 'events.jsonl');
  const writer = await createEventSink<FlowEvent>(path);
  const captured: FlowEvent[] = [];
  const recorder = new RunObserver(identity, (event) => {
    captured.push(event);
  });
  await recorder.emit('request.received');
  const controller = new AbortController();
  controller.abort();
  try {
    await writer.emit(captured[0]!, controller.signal);
    await writer.emit({ ...captured[0]!, requestId: '22222222-2222-4222-8222-222222222222' });
    await writer.close();
    const rows = (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].requestId, rows[1].requestId);
  } finally {
    await writer.close().catch(() => {});
    assert.ok(directory.startsWith(prefix));
    await rm(directory, { recursive: true, force: true });
  }
});
