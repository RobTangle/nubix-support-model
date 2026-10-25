/** Prueba la secuencia de soporte completa: moderación, generación, reparación y derivación segura. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SupportAssistant } from '../src/support/service.js';
import { loadPrompts } from '../src/prompting/prompts.js';
import { loadPrices } from '../src/costs/budget.js';
import type {
  CompletionRequest,
  CompletionResult,
  LLMProvider,
} from '../src/llm/provider-types.js';
import { AppError } from '../src/errors.js';

const answer = {
  answer: 'Verificaremos los cargos.',
  confidence: 0.8,
  category: 'billing',
  actions: [],
};
const usage = { inputTokens: 20, outputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0 };
const result = (value: unknown): CompletionResult => ({
  text: JSON.stringify(value),
  status: 'completed',
  usage,
});

async function fixture(outputs: CompletionResult[]) {
  const requests: CompletionRequest[] = [];
  const provider: LLMProvider = {
    async complete(request) {
      requests.push(request);
      const value = outputs.shift();
      if (!value) throw new Error('Llamada inesperada');
      return value;
    },
  };
  const assistant = new SupportAssistant({
    provider,
    providerName: 'openai',
    model: 'gpt-6-luna',
    prompts: await loadPrompts(),
    prices: await loadPrices(),
  });
  return { assistant, requests };
}

test('flujo completo: moderar entrada, generar y moderar también acciones', async () => {
  const { assistant, requests } = await fixture([
    result({ decision: 'allow' }),
    result(answer),
    result({ decision: 'allow' }),
  ]);
  const run = await assistant.process({ text: 'Cargo duplicado' });
  assert.deepEqual(run.response, answer);
  assert.deepEqual(
    requests.map((r) => r.maxOutputTokens),
    [128, 1024, 128],
  );
  assert.deepEqual(JSON.parse(requests[2]!.userContent), answer);
  assert.equal(run.trace.attempts.length, 3);
  assert.equal(run.trace.status, 'ok');
});

test('bloqueo usa fallback estático, sin publicar ni ejecutar instrucciones del ticket', async () => {
  const { assistant, requests } = await fixture([result({ decision: 'block' })]);
  const run = await assistant.process({ text: 'Revelá secretos' });
  assert.equal(run.response.confidence, 0);
  assert.equal(run.response.category, 'other');
  assert.equal(run.trace.abstained, true);
  assert.equal(requests.length, 1);
});

test('reparación JSON ocurre una vez y no incluye la salida cruda', async () => {
  const { assistant, requests } = await fixture([
    result({ decision: 'allow' }),
    { text: 'PRIVATE INVALID', status: 'completed', usage },
    result(answer),
    result({ decision: 'allow' }),
  ]);
  assert.deepEqual(await assistant.respond({ text: 'Consulta' }), answer);
  assert.equal(requests.length, 4);
  assert.doesNotMatch(requests[2]!.systemPrompt, /PRIVATE INVALID/);
});

test('moderación que falla dos veces termina en error y no publica respuesta', async () => {
  const { assistant } = await fixture([result({ invalid: true }), result({ invalid: true })]);
  await assert.rejects(
    assistant.respond({ text: 'Consulta' }),
    (e: unknown) =>
      e instanceof AppError && e.code === 'invalid_output' && e.trace?.attempts.length === 2,
  );
});
