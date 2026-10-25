import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../src/errors.js';
import { LabStore } from '../src/lab/storage.js';
import { createApp, type WebApplicationOptions } from '../src/web/app.js';
import { streamFrameSchema } from '../src/web/contracts.js';
import { SupportAssistant } from '../src/service.js';
import { loadPrices } from '../src/budget.js';
import { loadPrompts } from '../src/prompts.js';

const configuration = {
  mode: 'demo' as const,
  providers: [{ id: 'openai' as const, label: 'OpenAI', model: 'fixture', available: true }],
  promptVersions: ['basic-v1' as const],
  maxConcurrent: 1,
};
const body = { text: '  Factura original  ', provider: 'openai', promptVersion: 'basic-v1' };

test('cierre HTTP: espera cancelación y persiste consumo tardío antes de cerrar SQLite', async () => {
  const store = new LabStore(':memory:');
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const assistant = new SupportAssistant({
    providerName: 'openai',
    model: 'gpt-6-luna',
    prices: await loadPrices(),
    prompts: await loadPrompts(),
    provider: {
      async complete(request) {
        entered();
        await new Promise<void>((resolve) =>
          request.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        await delay(20);
        throw new AppError('cancelled', {
          usage: {
            inputTokens: 19,
            outputTokens: 2,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
          },
        });
      },
    },
  });
  const app = createApp({ configuration, store, createAssistant: () => assistant });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/support/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await started;
    await app.drain();
    const run = store.getRun(store.listRuns({}).items[0]!.id)!;
    assert.equal(run.status, 'cancelled');
    assert.match(JSON.stringify(run.result), /"inputTokens":19/);
    assert.doesNotMatch(JSON.stringify(run.events), /Factura original/);
    await response.body?.cancel();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

async function launch(createAssistant: WebApplicationOptions['createAssistant'], store: LabStore) {
  const server = createApp({ configuration, createAssistant, store }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

test('HTTP historial: persiste entrada original e inspección, separados de eventos y error seguro', async () => {
  const store = new LabStore(':memory:');
  let captured: unknown;
  const { server, url } = await launch(
    () => ({
      async process(input, options) {
        captured = input;
        assert.equal(store.getRun(options!.requestId!)!.status, 'running');
        await options!.inspect!({
          requestId: options!.requestId!,
          sequence: 1,
          timestamp: new Date().toISOString(),
          kind: 'input.received',
          data: { input: { text: body.text } },
        });
        throw new AppError('provider_error');
      },
    }),
    store,
  );
  try {
    const result = await fetch(`${url}/api/support/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const frames = (await result.text())
      .trim()
      .split('\n')
      .map((line) => streamFrameSchema.parse(JSON.parse(line)));
    assert.deepEqual(captured, { text: body.text });
    assert.equal(frames.filter((frame) => frame.type === 'inspection').length, 2);
    const list = await (await fetch(`${url}/api/history?kind=support&limit=1&offset=0`)).json();
    assert.equal(list.total, 1);
    assert.equal(list.items[0].status, 'failed');
    const detail = await (await fetch(`${url}/api/history/${list.items[0].id}`)).json();
    assert.deepEqual(detail.input, body);
    assert.equal(detail.inspections.length, 2);
    assert.equal(detail.inspections[0].kind, 'http.request');
    assert.deepEqual(detail.inspections[0].data.body, body);
    assert.equal(detail.events.length, 0);
    assert.equal(detail.error.code, 'provider_error');
    assert.equal((await fetch(`${url}/api/history?limit=101`)).status, 400);
    assert.equal((await fetch(`${url}/api/history/not-a-uuid`)).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test('HTTP historial: no crea asistente si no puede persistir', async () => {
  const store = new LabStore(':memory:');
  store.close();
  let created = false;
  const { server, url } = await launch(() => {
    created = true;
    throw new Error('No debería invocar API');
  }, store);
  try {
    const result = await fetch(`${url}/api/support/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(result.status, 503);
    assert.equal((await result.json()).error.code, 'report_error');
    assert.equal(created, false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('HTTP historial: conserva cancelación después de desconexión del navegador', async () => {
  const store = new LabStore(':memory:');
  const { server, url } = await launch(
    () => ({
      async process(_input, options) {
        await delay(10_000, undefined, { signal: options!.signal });
        throw new Error('Inalcanzable');
      },
    }),
    store,
  );
  const controller = new AbortController();
  try {
    const result = await fetch(`${url}/api/support/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    await result.body!.getReader().read();
    controller.abort();
    for (let count = 0; count < 50 && store.listRuns().items[0]!.status === 'running'; count++)
      await delay(10);
    const run = store.getRun(store.listRuns().items[0]!.id)!;
    assert.equal(run.status, 'cancelled');
    assert.equal(run.error!.code, 'cancelled');
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
