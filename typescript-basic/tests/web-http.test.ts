import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { request as httpRequest, type Server } from 'node:http';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp, type WebApplicationOptions } from '../src/web/app.js';
import { streamFrameSchema, type WebConfiguration } from '../src/web/contracts.js';
import { AppError } from '../src/errors.js';
import { DemoProvider } from '../src/web/demo-provider.js';
import type { FlowEvent } from '../src/observability/events.js';

const configuration: WebConfiguration = {
  mode: 'demo',
  providers: [{ id: 'openai', label: 'OpenAI', model: 'fixture', available: true }],
  promptVersions: ['basic-v1', 'basic-v2'],
  maxConcurrent: 1,
};
const response = {
  answer: 'Propuesta segura',
  confidence: 0.8,
  category: 'billing' as const,
  actions: [],
};

test('HTTP registro: admite una versión nueva configurada y rechaza IDs ausentes antes del asistente', async () => {
  const calls: string[] = [];
  const { server, url } = await launch(
    (_provider, version) => {
      calls.push(version);
      return {
        async process() {
          throw new AppError('provider_error');
        },
      };
    },
    {
      configuration: {
        ...configuration,
        promptVersions: ['basic-v1', 'experiment-v3'],
        prompts: [
          { id: 'basic-v1', label: 'Base' },
          { id: 'experiment-v3', label: 'Experimento' },
        ],
        defaultPromptVersion: 'experiment-v3',
        baselinePromptVersion: 'basic-v1',
      } as never,
    },
  );
  try {
    const config = await (await fetch(`${url}/api/config`)).json();
    assert.equal(config.defaultPromptVersion, 'experiment-v3');
    for (const [version, status] of [
      ['experiment-v3', 200],
      ['unknown-v9', 400],
    ] as const) {
      const result = await fetch(`${url}/api/support/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Factura', provider: 'openai', promptVersion: version }),
      });
      assert.equal(result.status, status);
      await result.text();
    }
    assert.deepEqual(calls, ['experiment-v3']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function launch(
  createAssistant: Parameters<typeof createApp>[0]['createAssistant'],
  extra: Partial<WebApplicationOptions> = {},
) {
  const server: Server = createApp({ configuration, createAssistant, ...extra }).listen(
    0,
    '127.0.0.1',
  );
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function trace(requestId: string) {
  return {
    requestId,
    provider: 'openai',
    model: 'fixture',
    promptVersion: 'basic-v1',
    manualVersion: '1',
    safetyVersion: '1',
    priceVersion: '1',
    contextHashes: {},
    status: 'ok' as const,
    abstained: false,
    stagesAttempted: 0,
    attempts: [],
    latencyMs: 1,
    knownCostUsd: '0',
    reservedUnknownUsd: '0',
    usageComplete: true,
  };
}

test('HTTP: entrega accepted antes de terminar y finaliza con un único resultado validado', async () => {
  let completed = false;
  const { server, url } = await launch(() => ({
    async process(_input, options) {
      await delay(120, undefined, { signal: options?.signal });
      completed = true;
      return { response, trace: trace(options!.requestId!) };
    },
  }));
  try {
    const result = await fetch(`${url}/api/support/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Factura', provider: 'openai', promptVersion: 'basic-v1' }),
    });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
    const reader = result.body!.getReader();
    const first = await reader.read();
    assert.equal(completed, false);
    const chunks = [new TextDecoder().decode(first.value)];
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(new TextDecoder().decode(chunk.value));
    }
    const frames = chunks
      .join('')
      .trim()
      .split('\n')
      .map((line) => streamFrameSchema.parse(JSON.parse(line)));
    assert.equal(frames[0]!.type, 'accepted');
    assert.equal(frames.at(-1)!.type, 'result');
    assert.equal(frames.filter((frame) => frame.type === 'result').length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('HTTP: valida origen, campos, proveedores y sanitiza errores operativos', async () => {
  const { server, url } = await launch(() => ({
    async process() {
      throw new AppError('authentication');
    },
  }));
  try {
    const config = await fetch(`${url}/api/config`);
    assert.deepEqual(await config.json(), configuration);
    for (const body of [
      { text: 'Factura', provider: 'openai', promptVersion: 'basic-v1', apiKey: 'SECRET' },
      { text: '', provider: 'openai', promptVersion: 'basic-v1' },
      { text: 'Factura', provider: 'xai', promptVersion: 'basic-v1' },
    ]) {
      const result = await fetch(`${url}/api/support/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(result.status, 400);
      assert.doesNotMatch(await result.text(), /SECRET/);
    }
    const foreign = await fetch(`${url}/api/support/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: '{}',
    });
    assert.equal(foreign.status, 403);
    const result = await fetch(`${url}/api/support/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Factura', provider: 'openai', promptVersion: 'basic-v1' }),
    });
    const frames = (await result.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(frames.at(-1).type, 'error');
    assert.equal(frames.at(-1).error.code, 'authentication');
    assert.equal(frames.filter((frame) => frame.type === 'result').length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('HTTP: límite concurrente y desconexión cancelan sólo la corrida correspondiente', async () => {
  let cancelled = false;
  const { server, url } = await launch(() => ({
    async process(_input, options) {
      try {
        await delay(10_000, undefined, { signal: options?.signal });
      } finally {
        cancelled = options!.signal!.aborted;
      }
      return { response, trace: trace(options!.requestId!) };
    },
  }));
  const controller = new AbortController();
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Factura', provider: 'openai', promptVersion: 'basic-v1' }),
  };
  try {
    const first = await fetch(`${url}/api/support/stream`, { ...init, signal: controller.signal });
    assert.equal(first.status, 200);
    const second = await fetch(`${url}/api/support/stream`, init);
    assert.equal(second.status, 429);
    controller.abort();
    for (let index = 0; index < 20 && !cancelled; index++) await delay(10);
    assert.equal(cancelled, true);
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('HTTP: rechaza cuerpos grandes, JSON roto y Host ajeno antes de crear un asistente', async () => {
  let created = 0;
  const { server, url } = await launch(() => {
    created++;
    throw new Error('No debería crear un cliente');
  });
  try {
    const large = await fetch(`${url}/api/support/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'a'.repeat(140 * 1024) }),
    });
    assert.equal(large.status, 413);
    const broken = await fetch(`${url}/api/support/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"text":',
    });
    assert.equal(broken.status, 400);
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest(
        `${url}/api/config`,
        { headers: { host: 'attacker.example' } },
        (incoming) => {
          incoming.resume();
          incoming.once('end', () => resolve(incoming.statusCode!));
        },
      );
      outgoing.once('error', reject);
      outgoing.end();
    });
    assert.equal(hostStatus, 403);
    assert.equal(created, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('demo: bloqueo exacto y generación conservan contratos sin red y aceptan cancelación', async () => {
  const provider = new DemoProvider();
  const request = {
    systemPrompt: 'Fixture',
    userContent: JSON.stringify({ ticket: 'DEMO_BLOCK' }),
    responseSchema: {},
    signal: new AbortController().signal,
    schemaName: 'safety_assessment',
    maxOutputTokens: 128,
  };
  assert.deepEqual(JSON.parse((await provider.complete(request)).text), { decision: 'block' });
  assert.deepEqual(
    JSON.parse(
      (
        await provider.complete({
          ...request,
          userContent: JSON.stringify({ ticket: 'DEMO_BLOCK factura' }),
        })
      ).text,
    ),
    { decision: 'allow' },
  );
  const result = await provider.complete({
    ...request,
    schemaName: 'support_response',
    userContent: JSON.stringify({ ticket: 'No puedo acceder a mi cuenta' }),
  });
  assert.equal(JSON.parse(result.text).category, 'account');
  assert.equal(result.status, 'completed');
  const controller = new AbortController();
  const pending = provider.complete({ ...request, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending);
});

test('servidor: help no requiere claves ni abre sockets', () => {
  const help = spawnSync(process.execPath, ['--import', 'tsx', 'src/web/server.ts', '--help'], {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, OPENAI_API_KEY: '', XAI_API_KEY: '', GEMINI_API_KEY: '' },
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--demo/);
  assert.match(help.stdout, /LIVE por defecto/);
  assert.match(help.stdout, /--live/);
  assert.equal(help.stderr, '');
});

test('HTTP: logs y stream reciben el mismo evento y requestId', async () => {
  const observed: FlowEvent[] = [];
  const { server, url } = await launch(
    () => ({
      async process(_input, options) {
        await options!.observe!(
          {
            schemaVersion: 1,
            requestId: options!.requestId!,
            sequence: 1,
            timestamp: new Date().toISOString(),
            elapsedMs: 0,
            durationMs: null,
            provider: 'openai',
            model: 'fixture',
            promptVersion: 'basic-v1',
            event: 'request.received',
            details: {},
          },
          options?.signal,
        );
        return { response, trace: trace(options!.requestId!) };
      },
    }),
    {
      observe: (event) => {
        observed.push(event);
      },
    },
  );
  try {
    const result = await fetch(`${url}/api/support/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Factura', provider: 'openai', promptVersion: 'basic-v1' }),
    });
    const frames = (await result.text())
      .trim()
      .split('\n')
      .map((line) => streamFrameSchema.parse(JSON.parse(line)));
    const events = frames.filter((frame) => frame.type === 'event').map((frame) => frame.event);
    assert.deepEqual(observed, events);
    assert.equal(observed.length, 1);
    const accepted = frames[0]!;
    assert.equal(accepted.type, 'accepted');
    if (accepted.type === 'accepted') assert.equal(observed[0]!.requestId, accepted.requestId);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('HTTP: deadline genera error terminal explícito si el navegador sigue conectado', async () => {
  const { server, url } = await launch(
    () => ({
      async process(_input, options) {
        await delay(5000, undefined, { signal: options?.signal });
        return { response, trace: trace(options!.requestId!) };
      },
    }),
    { streamTimeoutMs: 30 },
  );
  try {
    const result = await fetch(`${url}/api/support/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Factura', provider: 'openai', promptVersion: 'basic-v1' }),
    });
    const frames = (await result.text())
      .trim()
      .split('\n')
      .map((line) => streamFrameSchema.parse(JSON.parse(line)));
    assert.equal(frames.at(-1)!.type, 'error');
    const terminal = frames.at(-1)!;
    if (terminal.type === 'error') assert.equal(terminal.error.code, 'deadline_exceeded');
    assert.equal(frames.filter((frame) => frame.type === 'result').length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
