import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { readSupportStream } from '../src/web/client/stream-reader.js';
import { TimelineView } from '../src/web/client/timeline-view.js';
import { SupportApi } from '../src/web/client/api.js';

const id = '11111111-1111-4111-8111-111111111111';
const accepted = {
  type: 'accepted',
  requestId: id,
  mode: 'demo',
  receivedAt: '2026-10-25T12:00:00.000Z',
};
const event = {
  schemaVersion: 1,
  requestId: id,
  sequence: 1,
  timestamp: '2026-10-25T12:00:00.001Z',
  elapsedMs: 1,
  durationMs: null,
  provider: 'openai',
  model: 'gpt-6-luna',
  promptVersion: 'basic-v1',
  event: 'llm.request.started',
  stage: 'input_moderation',
  attempt: 1,
  details: {},
};
const trace = {
  requestId: id,
  provider: 'openai',
  model: 'gpt-6-luna',
  promptVersion: 'basic-v1',
  manualVersion: '1',
  safetyVersion: '1',
  priceVersion: '1',
  contextHashes: {},
  status: 'ok',
  abstained: false,
  stagesAttempted: 0,
  attempts: [],
  latencyMs: 2,
  knownCostUsd: '0',
  reservedUnknownUsd: '0',
  usageComplete: true,
};
const result = {
  type: 'result',
  requestId: id,
  mode: 'demo',
  trace,
  response: { answer: 'Revisá la facturación.', confidence: 0.8, category: 'billing', actions: [] },
};

function response(frames: unknown[]): Response {
  return new Response(frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n', {
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

test('cliente: procesa JSONL incremental y reconstruye UTF-8 cortado entre chunks', async () => {
  const bytes = new TextEncoder().encode(
    [accepted, { type: 'event', event }, result].map((frame) => JSON.stringify(frame)).join('\n') +
      '\n',
  );
  const received: unknown[] = [];
  const body = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  await readSupportStream(new Response(body), new AbortController().signal, (frame) => {
    received.push(frame);
  });
  assert.equal(received.length, 3);
  assert.deepEqual(received.at(-1), result);
});

test('cliente: entrega eventos antes del resultado final y espera un terminal confirmado', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  let resolveEvent!: () => void;
  const observed = new Promise<void>((resolve) => {
    resolveEvent = resolve;
  });
  const received: string[] = [];
  const reading = readSupportStream(new Response(body), new AbortController().signal, (frame) => {
    received.push(frame.type);
    if (frame.type === 'event') resolveEvent();
  });
  controller.enqueue(
    new TextEncoder().encode(
      JSON.stringify(accepted) + '\n' + JSON.stringify({ type: 'event', event }) + '\n',
    ),
  );
  await observed;
  assert.deepEqual(received, ['accepted', 'event']);
  controller.enqueue(new TextEncoder().encode(JSON.stringify(result) + '\n'));
  controller.close();
  await reading;
  assert.deepEqual(received, ['accepted', 'event', 'result']);
});

test('cliente: rechaza stream incompleto, IDs mezclados, secuencias repetidas y datos posteriores al terminal', async () => {
  for (const frames of [
    [accepted],
    [accepted, { type: 'event', event }, { type: 'event', event }, result],
    [
      accepted,
      { type: 'event', event: { ...event, requestId: '22222222-2222-4222-8222-222222222222' } },
      result,
    ],
    [accepted, result, result],
    [result],
    [accepted, { ...result, unexpected: 'extra' }],
  ]) {
    const received: string[] = [];
    await assert.rejects(
      readSupportStream(response(frames), new AbortController().signal, (frame) => {
        received.push(frame.type);
      }),
    );
    assert.equal(
      received.includes('result'),
      false,
      'No debe publicar éxito de un stream inválido',
    );
  }
});

test('cliente: limita tamaño y cantidad de eventos para no acumular streams ilimitados', async () => {
  await assert.rejects(
    readSupportStream(response([accepted, result]), new AbortController().signal, () => {}, {
      maxLineBytes: 30,
    }),
  );
  await assert.rejects(
    readSupportStream(
      response([accepted, { type: 'event', event }, result]),
      new AbortController().signal,
      () => {},
      { maxFrames: 2 },
    ),
  );
});

test('cliente: cancelar aborta la lectura pendiente y libera el stream', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const controller = new AbortController();
  const reading = readSupportStream(new Response(body), controller.signal, () => {});
  controller.abort();
  await assert.rejects(
    reading,
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );
  assert.equal(cancelled, true);
});

test('cliente: HTTP y configuración inválida producen mensajes seguros sin reflejar errores crudos', async () => {
  for (const status of [400, 403, 429, 500]) {
    const api = new SupportApi(async () => new Response('SECRET ticket privado', { status }));
    await assert.rejects(
      api.run(
        { text: 'Factura', provider: 'openai', promptVersion: 'basic-v1' },
        new AbortController().signal,
        () => {},
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /SECRET|privado/);
        assert.match(error.message, status === 429 ? /ocupado/ : /rechazó/);
        return true;
      },
    );
  }
  const api = new SupportApi(async () => Response.json({ apiKey: 'SECRET' }));
  await assert.rejects(
    api.configuration(),
    (error: unknown) => error instanceof Error && !error.message.includes('SECRET'),
  );
});

test('cliente: fetch nativo conserva un receptor válido al usar el transporte predeterminado', async () => {
  const original = globalThis.fetch;
  const configuration = {
    mode: 'demo',
    providers: [{ id: 'openai', label: 'OpenAI', model: 'fixture', available: true }],
    promptVersions: ['basic-v1', 'basic-v2'],
    maxConcurrent: 4,
  };
  try {
    globalThis.fetch = async function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return Response.json(configuration);
    };
    assert.deepEqual(await new SupportApi().configuration(), configuration);
  } finally {
    globalThis.fetch = original;
  }
});

test('cliente: rechaza bytes UTF-8 inválidos y un terminal de otra modalidad', async () => {
  const invalidUtf8 = new Response(new Uint8Array([0xff, 0xff, 0x0a]));
  await assert.rejects(readSupportStream(invalidUtf8, new AbortController().signal, () => {}));
  await assert.rejects(
    readSupportStream(
      response([accepted, { ...result, mode: 'live' }]),
      new AbortController().signal,
      () => {},
    ),
  );
});

test('cliente: acepta respuestas válidas extensas con Unicode sin confundir caracteres con bytes', async () => {
  const frames: unknown[] = [];
  const large = {
    ...result,
    response: {
      ...result.response,
      answer: '🧠'.repeat(4000),
      actions: Array.from({ length: 5 }, () => '🧠'.repeat(4000)),
    },
  };
  await readSupportStream(response([accepted, large]), new AbortController().signal, (frame) => {
    frames.push(frame);
  });
  assert.equal(frames.length, 2);
});

test('vista: identifica actor, tiempos y detalles; renderiza respuestas como texto inerte', () => {
  const dom = new JSDOM(
    '<ol id="timeline"></ol><section id="result"></section><div id="summary"></div>',
  );
  const document = dom.window.document;
  const view = new TimelineView(
    document.querySelector('ol')!,
    document.querySelector('#result')!,
    document.querySelector('#summary')!,
  );
  view.append(event as never);
  view.append({
    ...event,
    sequence: 2,
    elapsedMs: 20,
    durationMs: 19,
    event: 'llm.request.completed',
  } as never);
  assert.match(document.querySelector('ol')!.textContent!, /LLM/);
  assert.match(document.querySelector('ol')!.textContent!, /19/);
  assert.equal(document.querySelectorAll('details').length, 2);
  view.complete({
    ...result,
    response: { ...result.response, answer: '<img src=x onerror=alert(1)>' },
  } as never);
  assert.equal(document.querySelectorAll('img').length, 0);
  assert.match(document.querySelector('#result')!.textContent!, /<img src=x/);
  assert.match(document.querySelector('#summary')!.textContent!, /simulad/i);
  assert.match(document.querySelector('#summary')!.textContent!, /1 request LLM observada/);
  dom.window.close();
});

test('panel: cancelar desde el formulario aborta el stream y rehabilita los controles', async () => {
  const html = await readFile(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/' });
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.document = dom.window.document;
  globalThis.fetch = async (input) => {
    if (String(input) === '/api/config')
      return Response.json({
        mode: 'demo',
        providers: [{ id: 'openai', label: 'OpenAI', model: 'fixture', available: true }],
        promptVersions: ['basic-v1', 'basic-v2'],
        maxConcurrent: 4,
      });
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(accepted) + '\n'));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'content-type': 'application/x-ndjson' } },
    );
  };
  try {
    await import('../src/web/client/main.js');
    await delay(5);
    dom.window.document.querySelector<HTMLButtonElement>('#run-button')!.click();
    await delay(5);
    assert.equal(
      dom.window.document.querySelector<HTMLButtonElement>('#cancel-button')!.disabled,
      false,
    );
    dom.window.document.querySelector<HTMLButtonElement>('#cancel-button')!.click();
    await delay(5);
    assert.equal(cancelled, true);
    assert.match(dom.window.document.querySelector('#status-message')!.textContent!, /cancelada/);
    assert.equal(
      dom.window.document.querySelector<HTMLButtonElement>('#run-button')!.disabled,
      false,
    );
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.document = previousDocument;
    dom.window.close();
  }
});
