/** Prueba el caso de uso sin red: prompts, rechazos, entrada inválida y aislamiento de consultas concurrentes. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'yaml';
import { AppError } from '../src/errors.js';
import type { CompletionResult, LLMProvider } from '../src/provider-types.js';
import { SupportAssistant, loadPrompt } from '../src/service.js';
import { loadPrompts } from '../src/prompts.js';
import { loadPrices } from '../src/budget.js';

const answer = {
  answer: 'Soporte lo verificará.',
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
const prompts = await loadPrompts();
const prices = await loadPrices();

function assistant(provider: LLMProvider, deadlineMs = 60_000) {
  return new SupportAssistant({
    provider,
    prompts,
    prices,
    providerName: 'openai',
    model: 'gpt-6-luna',
    settings: { deadlineMs, callTimeoutMs: Math.min(15_000, deadlineMs) },
  });
}

test('default conserva instrucciones locales y v2 sólo agrega ejemplos independientes', async () => {
  const base = parse(await readFile(new URL('../src/prompt.yaml', import.meta.url), 'utf8')) as {
    system: string;
  };
  const context = parse(
    await readFile(new URL('../src/resources/context.yaml', import.meta.url), 'utf8'),
  ) as { manual: string };
  assert.equal(await loadPrompt(), base.system.replaceAll('{{manual}}', context.manual.trimEnd()));
  const v2 = await loadPrompts('basic-v2');
  assert.ok(v2.system.startsWith(prompts.system));
  assert.equal(v2.hashes.manual, prompts.hashes.manual);
  assert.doesNotMatch(prompts.system, /NUBBIX_CANARY_7F2A/);
  assert.match((await loadPrompts('basic-v1', true)).system, /NUBBIX_CANARY_7F2A/);
});

test('entrada inválida no llama al proveedor', async () => {
  const provider: LLMProvider = {
    async complete() {
      throw new Error('No debe llamarse');
    },
  };
  await assert.rejects(
    assistant(provider).respond({ text: ' ' }),
    (e: unknown) =>
      e instanceof AppError && e.code === 'invalid_input' && e.trace?.attempts.length === 0,
  );
});

test('rechazo explícito deriva sin reintentos; truncamiento no se publica', async () => {
  for (const status of ['refused', 'incomplete'] as const) {
    let calls = 0;
    const provider: LLMProvider = {
      async complete() {
        calls++;
        return { text: '', status, usage };
      },
    };
    if (status === 'refused')
      assert.equal((await assistant(provider).respond({ text: 'Consulta' })).confidence, 0);
    else
      await assert.rejects(
        assistant(provider).respond({ text: 'Consulta' }),
        (e: unknown) => e instanceof AppError && e.code === 'incomplete_output',
      );
    assert.equal(calls, 1);
  }
});

test('varias llamadas comparten cliente sin mezclar tickets ni resultados', async () => {
  let active = 0;
  let maximum = 0;
  const provider: LLMProvider = {
    async complete(request) {
      active++;
      maximum = Math.max(maximum, active);
      await delay(5, undefined, { signal: request.signal });
      active--;
      if (request.schemaName === 'safety_assessment') return result({ decision: 'allow' });
      const ticket = JSON.parse(request.userContent) as { ticket: string };
      return result({ ...answer, answer: ticket.ticket });
    },
  };
  const service = assistant(provider);
  const responses = await Promise.all(
    Array.from({ length: 10 }, (_, i) => service.respond({ text: `Ticket ${i}` })),
  );
  assert.equal(maximum, 10);
  assert.deepEqual(
    responses.map((r) => r.answer),
    Array.from({ length: 10 }, (_, i) => `Ticket ${i}`),
  );
});

test('cancelar una llamada no cancela otra del mismo asistente', async () => {
  const provider: LLMProvider = {
    async complete(request) {
      await delay(10, undefined, { signal: request.signal });
      return result(request.schemaName === 'safety_assessment' ? { decision: 'allow' } : answer);
    },
  };
  const service = assistant(provider);
  const controller = new AbortController();
  const cancelled = service.respond({ text: 'Cancelar' }, controller.signal);
  const completed = service.respond({ text: 'Continuar' });
  controller.abort();
  await assert.rejects(cancelled, (e: unknown) => e instanceof AppError && e.code === 'cancelled');
  assert.deepEqual(await completed, answer);
});

test('el deadline total aborta la operación de red cooperativa', async () => {
  let aborted = false;
  const provider: LLMProvider = {
    async complete(request) {
      try {
        await delay(1000, undefined, { signal: request.signal });
      } finally {
        aborted = request.signal.aborted;
      }
      return result(answer);
    },
  };
  await assert.rejects(
    assistant(provider, 20).respond({ text: 'Consulta' }),
    (e: unknown) => e instanceof AppError && e.code === 'deadline_exceeded',
  );
  assert.equal(aborted, true);
});
