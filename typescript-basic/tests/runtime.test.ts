import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SupportAssistant } from '../src/service.js';
import { loadPrices } from '../src/budget.js';
import { loadPrompts } from '../src/prompts.js';
import { AppError } from '../src/errors.js';
import type { CompletionRequest, CompletionResult, LLMProvider } from '../src/provider-types.js';
import type { TelemetryEvent } from '../src/telemetry.js';

const usage = { inputTokens: 20, outputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0 };
const answer = { answer: 'RESPUESTA PRIVADA', confidence: 0.8, category: 'billing', actions: [] };
const result = (value: unknown): CompletionResult => ({
  text: JSON.stringify(value),
  status: 'completed',
  usage,
});
const prices = await loadPrices();
const prompts = await loadPrompts();

function service(
  complete: LLMProvider['complete'],
  emit?: (event: TelemetryEvent) => void | Promise<void>,
  settings = {},
) {
  return new SupportAssistant({
    provider: { complete },
    providerName: 'openai',
    model: 'gpt-6-luna',
    prices,
    prompts,
    settings,
    ...(emit ? { emit } : {}),
  });
}

test('telemetría bloqueada no extiende el deadline ni publica respuesta', async () => {
  let finished = 0;
  const assistant = service(
    async () => result({ decision: 'allow' }),
    async () => {
      await delay(120);
      finished++;
    },
    { deadlineMs: 20 },
  );
  await assert.rejects(assistant.respond({ text: 'Consulta' }), AppError);
  assert.equal(finished, 0, 'El llamador debe dejar de esperar antes de que termine el sink lento');
});

test('un sink que nunca termina respeta cancelación sin dejar colgada la request', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const assistant = service(
      async () => result({ decision: 'allow' }),
      () => new Promise<void>(() => {}),
      { deadlineMs: 20 },
    );
    await assert.rejects(
      assistant.respond({ text: 'Consulta' }),
      (e: unknown) => e instanceof AppError && e.code === 'deadline_exceeded',
    );
  } finally {
    clearTimeout(keepAlive);
  }
});

test('credenciales inválidas no reintentan y conservan consumo conocido', async () => {
  let calls = 0;
  const assistant = service(async () => {
    calls++;
    throw new AppError('authentication', { usage });
  });
  await assert.rejects(
    assistant.respond({ text: 'Consulta' }),
    (e: unknown) =>
      e instanceof AppError &&
      e.code === 'authentication' &&
      e.trace?.attempts[0]?.inputTokens === 20 &&
      e.trace.knownCostUsd !== '0',
  );
  assert.equal(calls, 1);
});

test('errores transitorios y JSON inválido comparten dos intentos por etapa', async () => {
  let calls = 0;
  const assistant = service(async () => {
    calls++;
    if (calls === 1) return result({ decision: 'allow' });
    if (calls === 2) throw new AppError('rate_limit', { usage });
    return { text: 'NOT JSON', status: 'completed', usage };
  });
  await assert.rejects(
    assistant.respond({ text: 'Consulta' }),
    (e: unknown) => e instanceof AppError && e.code === 'invalid_output',
  );
  assert.equal(calls, 3);
});

test('confianza baja deriva sin abstenerse y sus acciones pasan por moderación', async () => {
  const requests: CompletionRequest[] = [];
  const assistant = service(async (request) => {
    requests.push(request);
    return result(
      request.schemaName === 'safety_assessment'
        ? { decision: 'allow' }
        : {
            ...answer,
            confidence: 0.69,
            actions: Array.from({ length: 5 }, (_, i) => `Acción ${i}`),
          },
    );
  });
  const run = await assistant.process({ text: 'Consulta' });
  assert.equal(run.trace.status, 'escalated');
  assert.equal(run.trace.abstained, false);
  assert.equal(run.response.actions.length, 5);
  assert.match(run.response.actions[4]!, /Derivar/);
  assert.deepEqual(JSON.parse(requests[2]!.userContent).actions, run.response.actions);
});

test('bloquear salida no publica propuesta; logs contienen sólo metadatos', async () => {
  let calls = 0;
  const events: TelemetryEvent[] = [];
  const assistant = service(
    async () => {
      calls++;
      return result(calls === 2 ? answer : { decision: calls === 3 ? 'review' : 'allow' });
    },
    (event) => {
      events.push(event);
    },
  );
  const run = await assistant.process({ text: 'TICKET PRIVADO' });
  assert.equal(run.trace.abstained, true);
  assert.doesNotMatch(run.response.answer, /RESPUESTA PRIVADA/);
  assert.doesNotMatch(JSON.stringify(events), /TICKET PRIVADO|RESPUESTA PRIVADA|Sos asistente/);
  assert.equal(events.at(-1)?.event, 'run_summary');
});

test('rechazo SDK no reintenta ni cuenta como falla operativa', async () => {
  const assistant = service(async () => ({ text: '', status: 'refused', usage }));
  const run = await assistant.process({ text: 'Consulta' });
  assert.equal(run.trace.status, 'blocked');
  assert.equal(run.trace.errorCode, undefined);
  assert.equal(run.trace.attempts.length, 1);
});

test('presupuesto se verifica antes de la primera llamada y también tras conciliar', async () => {
  let calls = 0;
  const complete = async () => {
    calls++;
    return { ...result({ decision: 'allow' }), usage: { ...usage, inputTokens: 1_000_000 } };
  };
  await assert.rejects(
    service(complete, undefined, { ticketBudgetUsd: '0.000000001' }).respond({ text: 'Consulta' }),
    (e: unknown) => e instanceof AppError && e.code === 'budget_exceeded',
  );
  assert.equal(calls, 0);
  await assert.rejects(
    service(complete).respond({ text: 'Consulta' }),
    (e: unknown) =>
      e instanceof AppError && e.code === 'budget_exceeded' && e.trace?.attempts.length === 1,
  );
  assert.equal(calls, 1);
});

test('una llamada sin consumo preserva su reserva incluso cuando se reintenta', async () => {
  let calls = 0;
  const assistant = service(async (request) => {
    calls++;
    if (calls === 1) throw new AppError('provider_unavailable');
    return result(request.schemaName === 'safety_assessment' ? { decision: 'allow' } : answer);
  });
  const run = await assistant.process({ text: 'Consulta' });
  assert.equal(run.trace.attempts.length, 4);
  assert.equal(run.trace.usageComplete, false);
  assert.ok(Number(run.trace.reservedUnknownUsd) > 0);
  assert.ok(Number(run.trace.knownCostUsd) > 0);
});
