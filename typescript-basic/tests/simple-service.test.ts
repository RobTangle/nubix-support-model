import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../src/errors.js';
import type { CompletionRequest, CompletionResult } from '../src/llm/provider-types.js';
import { SimpleSupportAssistant } from '../src/support/simple/service.js';
import { HUMAN_REVIEW_ACTION, safeResponse } from '../src/support/schemas.js';

const prompts = {
  system: 'Generar según el manual.',
  inputModeration: 'Moderar entrada.',
  outputModeration: 'Moderar salida.',
  repair: 'Corregir el formato.',
};
const answer = {
  answer: 'Revisaremos los cargos.',
  category: 'billing',
  confidence: 0.9,
  actions: [],
};
const allow = { decision: 'allow' };

function fixture(values: unknown[]) {
  const requests: CompletionRequest[] = [];
  const assistant = new SimpleSupportAssistant({
    prompts,
    provider: {
      async complete(request) {
        requests.push(request);
        const value = values.shift();
        if (value instanceof Error) throw value;
        if (value === 'refused') return { text: '', status: 'refused', usage: null };
        return {
          text: value === 'invalid-json' ? '{' : JSON.stringify(value),
          status: 'completed',
          usage: null,
        } satisfies CompletionResult;
      },
    },
  });
  return { assistant, requests };
}

test('flujo simple: tres requests, esquemas distintos y moderación del objeto publicado', async () => {
  const { assistant, requests } = fixture([allow, answer, allow]);
  assert.deepEqual(await assistant.process({ text: '  Me cobraron dos veces.  ' }), answer);
  assert.deepEqual(
    requests.map((request) => request.systemPrompt),
    [prompts.inputModeration, prompts.system, prompts.outputModeration],
  );
  assert.deepEqual(JSON.parse(requests[0]!.userContent), { ticket: 'Me cobraron dos veces.' });
  assert.deepEqual(JSON.parse(requests[2]!.userContent), answer);
  assert.deepEqual(
    requests.map((request) => request.maxOutputTokens),
    [128, 1024, 128],
  );
  assert.deepEqual(Object.keys(requests[0]!.responseSchema.properties as object), ['decision']);
  assert.deepEqual(Object.keys(requests[1]!.responseSchema.properties as object), [
    'answer',
    'confidence',
    'category',
    'actions',
  ]);
});

test('entrada inválida se rechaza antes del proveedor', async () => {
  const { assistant, requests } = fixture([]);
  for (const input of [{ text: '' }, { text: 'a', extra: true }, { text: ' '.repeat(8001) }])
    await assert.rejects(assistant.process(input), { code: 'invalid_input' });
  assert.equal(requests.length, 0);
});

test('review, block y refusal nunca publican fragmentos del modelo', async () => {
  for (const decision of ['review', 'block']) {
    const input = fixture([{ decision }]);
    assert.deepEqual(await input.assistant.process({ text: 'Consulta' }), safeResponse());
    assert.equal(input.requests.length, 1);
    const output = fixture([allow, answer, { decision }]);
    assert.deepEqual(await output.assistant.process({ text: 'Consulta' }), safeResponse());
  }
  for (const values of [['refused'], [allow, 'refused'], [allow, answer, 'refused']]) {
    const { assistant } = fixture(values);
    assert.deepEqual(await assistant.process({ text: 'Consulta' }), safeResponse());
  }
});

test('baja confianza agrega revisión sin superar cinco acciones y después modera', async () => {
  const { assistant, requests } = fixture([
    allow,
    { ...answer, confidence: 0.5, actions: ['a', 'b', 'c', 'd', 'e'] },
    allow,
  ]);
  const result = await assistant.process({ text: 'Consulta' });
  assert.deepEqual(result.actions, ['a', 'b', 'c', 'd', HUMAN_REVIEW_ACTION]);
  assert.deepEqual(JSON.parse(requests[2]!.userContent), result);
});

test('JSON y esquema inválidos se reparan sin reenviar la salida inválida', async () => {
  for (const invalid of ['invalid-json', { decision: 'allow', extra: true }]) {
    const { assistant, requests } = fixture([invalid, allow, answer, allow]);
    await assistant.process({ text: 'Consulta' });
    assert.equal(requests[1]!.systemPrompt, `${prompts.inputModeration}\n${prompts.repair}`);
    assert.equal(requests[1]!.userContent, requests[0]!.userContent);
  }
});

test('fallos transitorios y de formato comparten dos intentos; moderación fallida no publica', async () => {
  const { assistant, requests } = fixture([new AppError('rate_limit'), 'invalid-json', allow]);
  await assert.rejects(assistant.process({ text: 'Consulta' }), { code: 'invalid_output' });
  assert.equal(requests.length, 2);
  const output = fixture([allow, answer, 'invalid-json', 'invalid-json']);
  await assert.rejects(output.assistant.process({ text: 'Consulta' }), { code: 'invalid_output' });
});

test('errores permanentes se sanitizan y no se reintentan', async () => {
  for (const error of [new AppError('authentication'), new Error('secreto del SDK')]) {
    const { assistant, requests } = fixture([error]);
    await assert.rejects(assistant.process({ text: 'Consulta' }), {
      code: error instanceof AppError ? 'authentication' : 'provider_error',
    });
    assert.equal(requests.length, 1);
  }
});

test('cancelación previa no consume API', async () => {
  const { assistant, requests } = fixture([]);
  await assert.rejects(assistant.process({ text: 'Consulta' }, AbortSignal.abort()), {
    code: 'cancelled',
  });
  assert.equal(requests.length, 0);
});

test('una instancia comparte proveedor sin mezclar tickets concurrentes', async () => {
  const assistant = new SimpleSupportAssistant({
    prompts,
    provider: {
      async complete(request) {
        await Promise.resolve();
        const value =
          request.schemaName === 'support_response'
            ? { ...answer, answer: (JSON.parse(request.userContent) as { ticket: string }).ticket }
            : allow;
        return { text: JSON.stringify(value), status: 'completed', usage: null };
      },
    },
  });
  const results = await Promise.all([
    assistant.process({ text: 'Primer ticket' }),
    assistant.process({ text: 'Segundo ticket' }),
  ]);
  assert.deepEqual(
    results.map((result) => result.answer),
    ['Primer ticket', 'Segundo ticket'],
  );
});
