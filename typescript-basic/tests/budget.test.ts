/** Prueba reservas, conciliación y tarifas: gastar con consumo desconocido debe conservar presupuesto. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Budget, loadPrices } from '../src/costs/budget.js';
import { AppError } from '../src/errors.js';

test('reservas desconocidas no se liberan; consumo conocido se concilia con precisión', () => {
  const budget = new Budget('0.05');
  const first = budget.reserve('0.02');
  budget.settle(first, null);
  const second = budget.reserve('0.01');
  budget.settle(second, '0.005');
  assert.equal(budget.knownUsd, '0.005');
  assert.equal(budget.unknownUsd, '0.02');
  assert.equal(budget.committedUsd, '0.025');
  assert.throws(
    () => budget.check('0.026'),
    (e: unknown) => e instanceof AppError && e.code === 'budget_exceeded',
  );
});

test('el catálogo estima todas las llamadas y rechaza modelos sin tarifa', async () => {
  const prices = await loadPrices();
  const price = prices.get('openai', 'gpt-6-luna');
  assert.equal(
    price.cost({
      inputTokens: 1000,
      outputTokens: 100,
      cachedInputTokens: 500,
      cacheWriteInputTokens: 0,
    }).usd,
    '0.000105',
  );
  assert.equal(
    price.cost({
      inputTokens: 1000,
      outputTokens: 100,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
    }).complete,
    false,
  );
  assert.throws(
    () => prices.get('openai', 'unknown'),
    (e: unknown) => e instanceof AppError && e.code === 'unknown_model',
  );
});
