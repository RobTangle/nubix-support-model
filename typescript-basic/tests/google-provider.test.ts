/**
 * Ejecuta el SDK real de Google contra respuestas HTTP falsas: comprueba traducción del request,
 * texto/estados, tokens de razonamiento, bloqueos, cancelación y errores sin usar la API real.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../src/errors.js';
import type { CompletionRequest } from '../src/provider-types.js';
import { GoogleGenAIProvider } from '../src/providers.js';

const request: CompletionRequest = {
  systemPrompt: 'Manual de soporte',
  userContent: '{"ticket":"Cargo duplicado"}',
  responseSchema: { type: 'object', properties: { answer: { type: 'string' } } },
  schemaName: 'support_response',
  maxOutputTokens: 1024,
  signal: new AbortController().signal,
};
const wireUsage = {
  total_input_tokens: 20,
  total_output_tokens: 12,
  total_thought_tokens: 5,
  total_cached_tokens: 8,
  total_tokens: 37,
};
const expectedUsage = {
  inputTokens: 20,
  outputTokens: 17,
  cachedInputTokens: 8,
  cacheWriteInputTokens: 0,
};

function interaction(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    id: 'interaction-test',
    status: 'completed',
    steps: [
      { type: 'thought', signature: 'signature', summary: [{ type: 'text', text: 'Privado' }] },
      {
        type: 'model_output',
        content: [
          { type: 'text', text: '{"answer":' },
          { type: 'text', text: '"Hola"}' },
        ],
      },
    ],
    usage: wireUsage,
    ...overrides,
  });
}

test('google: devuelve texto final, excluye pensamientos y contabiliza su consumo', async () => {
  let sent: Record<string, unknown> | undefined;
  const provider = new GoogleGenAIProvider('gemini-3.8-flash', 'fake-key', {
    fetch: async (input, init) => {
      sent = (await new Request(input, init).json()) as Record<string, unknown>;
      return interaction();
    },
  });
  const result = await provider.complete(request);
  assert.deepEqual(result, {
    text: '{"answer":"Hola"}',
    status: 'completed',
    usage: expectedUsage,
  });
  assert.equal(sent?.model, 'gemini-3.8-flash');
  assert.equal(sent?.system_instruction, request.systemPrompt);
  assert.equal(sent?.input, request.userContent);
  assert.deepEqual(sent?.response_format, {
    type: 'text',
    mime_type: 'application/json',
    schema: request.responseSchema,
  });
  assert.deepEqual(sent?.generation_config, { max_output_tokens: 1024 });
  assert.equal(sent?.store, false);
  assert.equal(sent?.stream, false);
});

test('google: conserva tokens ante truncamiento y estados que requieren otra acción', async () => {
  for (const status of [
    'incomplete',
    'requires_action',
    'in_progress',
    'queued',
    'future_status',
  ]) {
    const result = await new GoogleGenAIProvider('gemini-3.8-flash', 'fake-key', {
      fetch: async () => interaction({ status, steps: [] }),
    }).complete(request);
    assert.deepEqual(result, { text: '', status: 'incomplete', usage: expectedUsage });
  }
});

test('google: no publica salida fallida o cancelada y conserva el consumo', async () => {
  for (const [status, code] of [
    ['failed', 'provider_error'],
    ['cancelled', 'cancelled'],
    ['budget_exceeded', 'provider_error'],
  ] as const) {
    await assert.rejects(
      new GoogleGenAIProvider('gemini-3.8-flash', 'fake-key', {
        fetch: async () => interaction({ status }),
      }).complete(request),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, code);
        assert.deepEqual(error.usage, expectedUsage);
        return true;
      },
    );
  }
});

test('google: reconoce bloqueos en la interacción conservando consumo', async () => {
  for (const code of [
    'safety',
    'jailbreak',
    'prohibited_content',
    'blocklist',
    'recitation',
    'spii',
    'content_blocked',
  ]) {
    const result = await new GoogleGenAIProvider('gemini-3.8-flash', 'fake-key', {
      fetch: async () => interaction({ status: 'failed', errors: [{ code, message: 'SECRET' }] }),
    }).complete(request);
    assert.deepEqual(result, { text: '', status: 'refused', usage: expectedUsage });
  }
});

test('google: distingue bloqueos HTTP de errores de configuración y no reintenta', async () => {
  for (const [status, code, expected] of [
    [400, 'safety', 'refused'],
    [400, 'jailbreak', 'refused'],
    [400, 'invalid_request', 'invalid_request'],
    [401, 'authentication', 'authentication'],
    [403, 'permission_denied', 'permission'],
    [404, 'model_not_found', 'invalid_request'],
    [408, 'request_timeout', 'timeout'],
    [429, 'rate_limit_exceeded', 'rate_limit'],
    [499, 'cancelled', 'cancelled'],
    [503, 'service_unavailable', 'provider_unavailable'],
    [504, 'deadline_exceeded', 'timeout'],
  ] as const) {
    let calls = 0;
    const provider = new GoogleGenAIProvider('gemini-3.8-flash', 'fake-key', {
      fetch: async () => {
        calls++;
        return Response.json({ error: { code, message: 'SECRET ticket y API key' } }, { status });
      },
    });
    if (expected === 'refused') {
      assert.deepEqual(await provider.complete(request), {
        text: '',
        status: 'refused',
        usage: null,
      });
    } else {
      await assert.rejects(provider.complete(request), (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, expected);
        assert.equal(error.usage, null);
        assert.equal(error.cause, undefined);
        assert.doesNotMatch(error.message, /SECRET|ticket|API key/);
        return true;
      });
    }
    assert.equal(calls, 1);
  }
});

test('google: descarta consumo inválido o incompleto sin inventar tokens', async () => {
  for (const usage of [
    null,
    {},
    { ...wireUsage, total_input_tokens: undefined },
    { ...wireUsage, total_input_tokens: -1 },
    { ...wireUsage, total_output_tokens: 1.5 },
    { ...wireUsage, total_thought_tokens: -1 },
    { ...wireUsage, total_tokens: 36 },
    { ...wireUsage, total_tokens: null },
    { ...wireUsage, total_thought_tokens: undefined },
    { ...wireUsage, total_thought_tokens: undefined, total_tokens: undefined },
    { ...wireUsage, total_thought_tokens: Number.MAX_SAFE_INTEGER },
    { ...wireUsage, total_tool_use_tokens: 2 },
  ]) {
    const result = await new GoogleGenAIProvider('gemini-3.8-flash', 'fake-key', {
      fetch: async () => interaction({ usage }),
    }).complete(request);
    assert.equal(result.usage, null, JSON.stringify(usage));
  }
});

test('google: conserva totales sin total_tokens y distingue caché desconocida de cero', async () => {
  for (const cached of [undefined, null, -1, 21, 1.5, 0]) {
    const result = await new GoogleGenAIProvider('gemini-3.8-flash', 'fake-key', {
      fetch: async () =>
        interaction({
          usage: { ...wireUsage, total_tokens: undefined, total_cached_tokens: cached },
        }),
    }).complete(request);
    assert.deepEqual(result.usage, {
      ...expectedUsage,
      cachedInputTokens: cached === 0 ? 0 : null,
    });
  }
  const result = await new GoogleGenAIProvider('gemini-3.8-flash', 'fake-key', {
    fetch: async () =>
      interaction({
        usage: {
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_tokens: 0,
          total_cached_tokens: 0,
        },
      }),
  }).complete(request);
  assert.deepEqual(result.usage, {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
  });
});

test('google: sanitiza fallos de red sin reintentos ocultos', async () => {
  let calls = 0;
  await assert.rejects(
    new GoogleGenAIProvider('gemini-3.8-flash', 'fake-key', {
      fetch: async () => {
        calls++;
        throw new TypeError('SECRET conexión');
      },
    }).complete(request),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'provider_unavailable');
      assert.doesNotMatch(error.message, /SECRET/);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('google: propaga cancelación y timeout a la solicitud en vuelo', async () => {
  for (const reason of [
    new DOMException('Cancelado', 'AbortError'),
    new DOMException('Plazo', 'TimeoutError'),
  ]) {
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let aborted = false;
    const provider = new GoogleGenAIProvider('gemini-3.8-flash', 'fake-key', {
      fetch: async (input, init) => {
        const outgoing = new Request(input, init);
        ready();
        try {
          await delay(1000, undefined, { signal: outgoing.signal });
        } finally {
          aborted = outgoing.signal.aborted;
        }
        return interaction();
      },
    });
    const pending = assert.rejects(
      provider.complete({ ...request, signal: controller.signal }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, reason.name === 'TimeoutError' ? 'timeout' : 'cancelled');
        return true;
      },
    );
    await started;
    controller.abort(reason);
    await pending;
    assert.equal(aborted, true);
  }
});
