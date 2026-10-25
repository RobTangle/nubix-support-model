/**
 * Prueba los adaptadores OpenAI/xAI con sus SDK reales y transporte HTTP simulado. Verifica que
 * respeten el contrato común y no introduzcan reintentos, exposición de secretos o consumo inventado.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProviderSettings } from '../src/config.js';
import { AppError } from '../src/errors.js';
import type { CompletionRequest } from '../src/provider-types.js';
import { createProvider } from '../src/providers.js';
import { responseJsonSchema } from '../src/schemas.js';

const settings: Record<'openai' | 'xai', ProviderSettings> = {
  openai: { provider: 'openai', apiKey: 'fake-openai-key', model: 'gpt-6-luna' },
  xai: { provider: 'xai', apiKey: 'fake-xai-key', model: 'grok-4.20-0309-non-reasoning' },
};
const answer = {
  answer: 'Soporte verificará los cargos.',
  confidence: 0.8,
  category: 'billing',
  actions: [],
};
const request: CompletionRequest = {
  systemPrompt: 'Manual de ejemplo',
  userContent: '{"ticket":"Cargo duplicado"}',
  responseSchema: responseJsonSchema,
  schemaName: 'support_response',
  maxOutputTokens: 1024,
  signal: new AbortController().signal,
};

/** Dobles en la frontera HTTP: se ejecutan los dos SDK reales sin usar la red. */
function apiResponse(
  status = 'completed',
  refused = false,
  usage: unknown = {
    input_tokens: 20,
    output_tokens: 12,
    total_tokens: 32,
    input_tokens_details: { cached_tokens: 8, cache_write_tokens: 4 },
  },
): Response {
  return Response.json({
    id: 'response-test',
    object: 'response',
    status,
    output: [
      {
        id: 'message-test',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: refused
          ? [{ type: 'refusal', refusal: 'No puedo responder.' }]
          : [{ type: 'output_text', text: JSON.stringify(answer), annotations: [] }],
      },
    ],
    usage,
  });
}

for (const provider of ['openai', 'xai'] as const) {
  test(`${provider}: respeta nombre de esquema y límite para moderación`, async () => {
    let sent: Record<string, unknown> | undefined;
    const mockFetch: typeof fetch = async (input, init) => {
      sent = (await new Request(input, init).json()) as Record<string, unknown>;
      return apiResponse();
    };
    await createProvider(settings[provider], { fetch: mockFetch }).complete({
      ...request,
      schemaName: 'moderation_decision',
      maxOutputTokens: 128,
    });
    assert.equal(sent?.max_output_tokens, 128);
    assert.equal((sent?.text as { format: { name: string } }).format.name, 'moderation_decision');
  });

  test(`${provider}: conserva tokens y caché en respuestas completadas, rechazadas e incompletas`, async () => {
    for (const [status, refused] of [
      ['completed', false],
      ['completed', true],
      ['incomplete', false],
    ] as const) {
      const result = await createProvider(settings[provider], {
        fetch: async () => apiResponse(status, refused),
      }).complete(request);
      assert.deepEqual(result.usage, {
        inputTokens: 20,
        outputTokens: 12,
        cachedInputTokens: 8,
        cacheWriteInputTokens: provider === 'openai' ? 4 : 0,
      });
    }
  });

  test(`${provider}: conserva consumo conocido si el proveedor declara estado fallido`, async () => {
    await assert.rejects(
      createProvider(settings[provider], { fetch: async () => apiResponse('failed') }).complete(
        request,
      ),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'provider_error');
        assert.deepEqual(error.usage, {
          inputTokens: 20,
          outputTokens: 12,
          cachedInputTokens: 8,
          cacheWriteInputTokens: provider === 'openai' ? 4 : 0,
        });
        return true;
      },
    );
  });

  test(`${provider}: no inventa consumo cuando faltan totales o son inválidos`, async () => {
    for (const usage of [
      null,
      {},
      { output_tokens: 12 },
      { input_tokens: 20 },
      { input_tokens: -1, output_tokens: 12 },
      { input_tokens: 20.5, output_tokens: 12 },
      { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 12 },
      { input_tokens: 20, output_tokens: -1 },
      { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 12 },
      { input_tokens: 20, output_tokens: 12, total_tokens: 31 },
      { input_tokens: 20, output_tokens: 12, total_tokens: -1 },
      { input_tokens: 20, output_tokens: 12, total_tokens: null },
    ]) {
      const result = await createProvider(settings[provider], {
        fetch: async () => apiResponse('completed', false, usage),
      }).complete(request);
      assert.equal(result.usage, null);
    }
  });

  test(`${provider}: conserva totales y marca caché desconocida ante desglose ausente o inválido`, async () => {
    for (const detail of [
      undefined,
      null,
      {},
      { cached_tokens: -1 },
      { cached_tokens: 21 },
      { cached_tokens: 1.5 },
    ]) {
      const result = await createProvider(settings[provider], {
        fetch: async () =>
          apiResponse('completed', false, {
            input_tokens: 20,
            output_tokens: 12,
            total_tokens: 32,
            input_tokens_details: detail,
          }),
      }).complete(request);
      assert.deepEqual(result.usage, {
        inputTokens: 20,
        outputTokens: 12,
        cachedInputTokens: null,
        cacheWriteInputTokens: provider === 'openai' ? null : 0,
      });
    }
    const result = await createProvider(settings[provider], {
      fetch: async () =>
        apiResponse('completed', false, {
          input_tokens: 0,
          output_tokens: 0,
          input_tokens_details: { cached_tokens: 0 },
        }),
    }).complete(request);
    assert.deepEqual(result.usage, {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: provider === 'openai' ? null : 0,
    });
  });

  test(`${provider}: no publica prompts ni credenciales en logs del SDK`, () => {
    const source = `import { createProvider } from './src/providers.ts';
      const client = createProvider({ provider: '${provider}', apiKey: 'SECRET-KEY', model: '${settings[provider].model}' }, { fetch: async () => Response.json({ id: 'test', status: 'completed', output: [] }) });
      await client.complete({ systemPrompt: 'PRIVATE-MANUAL', userContent: 'PRIVATE-TICKET', responseSchema: { type: 'object' }, schemaName: 'test', maxOutputTokens: 128, signal: new AbortController().signal });`;
    const output = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', source],
      {
        cwd: new URL('..', import.meta.url),
        env: { ...process.env, OPENAI_LOG: 'debug', XAI_DEBUG: '0' },
        encoding: 'utf8',
      },
    );
    assert.equal(output.status, 0, output.stderr);
    assert.equal(output.stdout, '');
    assert.equal(output.stderr, '');
  });
}

test('openai: valida escritura y suma de subconjuntos sin perder totales', async () => {
  for (const [detail, cached, write] of [
    [{ cached_tokens: 8, cache_write_tokens: 13 }, null, null],
    [{ cached_tokens: 8, cache_write_tokens: -1 }, 8, null],
    [{ cached_tokens: 8, cache_write_tokens: 20.5 }, 8, null],
    [{ cached_tokens: 8, cache_write_tokens: 21 }, 8, null],
  ] as const) {
    const result = await createProvider(settings.openai, {
      fetch: async () =>
        apiResponse('completed', false, {
          input_tokens: 20,
          output_tokens: 12,
          total_tokens: 32,
          input_tokens_details: detail,
        }),
    }).complete(request);
    assert.deepEqual(result.usage, {
      inputTokens: 20,
      outputTokens: 12,
      cachedInputTokens: cached,
      cacheWriteInputTokens: write,
    });
  }
});

test('xai: rechaza XAI_DEBUG antes de construir el cliente y no registra secretos', () => {
  const source = `import { createProvider } from './src/providers.ts';
    try { createProvider({ provider: 'xai', apiKey: 'SECRET-KEY', model: 'grok-4.20-0309-non-reasoning' }, { fetch: async () => { throw Error('NETWORK'); } }); process.exitCode = 2; }
    catch (error) { console.log(error.code); if (process.env.XAI_DEBUG !== '1') process.exitCode = 3; }`;
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', source],
    {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, XAI_DEBUG: '1' },
      encoding: 'utf8',
    },
  );
  assert.equal(output.trim(), 'configuration_error');
  assert.doesNotMatch(output, /SECRET|Authorization|Bearer|curl/);
});

for (const provider of ['openai', 'xai'] as const) {
  test(`${provider}: envía esquema estricto, límite de tokens y mensajes separados`, async () => {
    const captured: Request[] = [];
    const mockFetch: typeof fetch = async (input, init) => {
      captured.push(new Request(input, init));
      return apiResponse();
    };
    const result = await createProvider(settings[provider], { fetch: mockFetch }).complete(request);
    assert.equal(result.status, 'completed');
    assert.deepEqual(JSON.parse(result.text), answer);
    assert.equal(captured.length, 1);
    const sent = captured[0]!;
    const body = (await sent.json()) as Record<string, unknown>;
    assert.equal(
      sent.url,
      provider === 'openai'
        ? 'https://api.openai.com/v1/responses'
        : 'https://api.x.ai/v1/responses',
    );
    assert.equal(sent.headers.get('authorization'), `Bearer ${settings[provider].apiKey}`);
    assert.equal(body.model, settings[provider].model);
    assert.equal(body.store, false);
    assert.equal(body.stream, false);
    assert.equal(body.max_output_tokens, 1024);
    assert.deepEqual(body.tools, []);
    assert.deepEqual(body.input, [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.userContent },
    ]);
    const text = body.text as {
      format: { type: string; name: string; strict: boolean; schema: unknown };
    };
    assert.equal(text.format.type, 'json_schema');
    assert.equal(text.format.strict, true);
    assert.equal(text.format.name, 'support_response');
    assert.deepEqual(text.format.schema, responseJsonSchema);
    if (provider === 'openai') assert.deepEqual(body.reasoning, { effort: 'none' });
  });

  test(`${provider}: distingue rechazo y salida incompleta`, async () => {
    for (const [status, refused, expected] of [
      ['completed', true, 'refused'],
      ['incomplete', false, 'incomplete'],
    ] as const) {
      const mockFetch: typeof fetch = async () => apiResponse(status, refused);
      const result = await createProvider(settings[provider], { fetch: mockFetch }).complete(
        request,
      );
      assert.equal(result.status, expected);
    }
  });

  test(`${provider}: errores sanitizados y ningún reintento oculto`, async () => {
    for (const [status, code] of [
      [400, 'invalid_request'],
      [401, 'authentication'],
      [403, 'permission'],
      [404, 'invalid_request'],
      [429, 'rate_limit'],
      [503, 'provider_unavailable'],
    ] as const) {
      let calls = 0;
      const mockFetch: typeof fetch = async () => {
        calls++;
        return Response.json(
          { error: { message: 'SECRET ticket privado y api-key', type: 'invalid_request_error' } },
          { status },
        );
      };
      await assert.rejects(
        createProvider(settings[provider], { fetch: mockFetch }).complete(request),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, code);
          assert.doesNotMatch(error.message, /SECRET|privado|api-key/);
          assert.equal(error.cause, undefined);
          return true;
        },
      );
      assert.equal(calls, 1);
    }
  });

  test(`${provider}: cancela la solicitud de red en vuelo`, async () => {
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let aborted = false;
    const mockFetch: typeof fetch = async (input, init) => {
      const outgoing = new Request(input, init);
      ready();
      try {
        await delay(1000, undefined, { signal: outgoing.signal });
      } finally {
        aborted = outgoing.signal.aborted;
      }
      return apiResponse();
    };
    const pending = createProvider(settings[provider], { fetch: mockFetch }).complete({
      ...request,
      signal: controller.signal,
    });
    const rejected = assert.rejects(
      pending,
      (error: unknown) => error instanceof AppError && error.code === 'cancelled',
    );
    await started;
    controller.abort();
    await rejected;
    assert.equal(aborted, true);
  });

  test(`${provider}: abortar durante el body interrumpe su lectura`, async () => {
    const controller = new AbortController();
    let ready!: () => void;
    const reading = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let aborted = false;
    const mockFetch: typeof fetch = async (input, init) => {
      const outgoing = new Request(input, init);
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          outgoing.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              stream.error(outgoing.signal.reason);
            },
            { once: true },
          );
          stream.enqueue(new TextEncoder().encode('{"id":"response-test",'));
          ready();
        },
      });
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    };
    const pending = createProvider(settings[provider], { fetch: mockFetch }).complete({
      ...request,
      signal: controller.signal,
    });
    const rejected = assert.rejects(
      pending,
      (error: unknown) => error instanceof AppError && error.code === 'cancelled',
    );
    await reading;
    controller.abort();
    await rejected;
    assert.equal(aborted, true);
  });
}
