/** Prueba límites y normalización de los contratos Zod, incluida la paridad de casos con Python. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ticketSchema, supportResponseSchema } from '../src/support/schemas.js';

const cases = JSON.parse(
  await readFile(new URL('../../tests/fixtures/basic-contract.json', import.meta.url), 'utf8'),
) as Array<{ id: string; target: string; input: unknown; valid: boolean; expected?: unknown }>;

for (const example of cases) {
  test(`Contrato compartido con Python: ${example.id}`, () => {
    const schema = example.target === 'ticket' ? ticketSchema : supportResponseSchema;
    const result = schema.safeParse(example.input);
    assert.equal(result.success, example.valid);
    if (result.success && example.expected !== undefined)
      assert.deepEqual(result.data, example.expected);
  });
}

test('el límite se mide en puntos de código como len() de Python, antes de trim', () => {
  assert.equal(ticketSchema.safeParse({ text: '😀'.repeat(8000) }).success, true);
  assert.equal(ticketSchema.safeParse({ text: '😀'.repeat(8001) }).success, false);
  assert.equal(ticketSchema.safeParse({ text: 'hola' + ' '.repeat(8000) }).success, false);
});

test('la salida rechaza infinitos, NaN y más de cinco acciones', () => {
  const value = { answer: 'Respuesta', confidence: 0.8, category: 'other', actions: [] };
  for (const confidence of [NaN, Infinity, -0.1, 1.1])
    assert.equal(supportResponseSchema.safeParse({ ...value, confidence }).success, false);
  assert.equal(
    supportResponseSchema.safeParse({ ...value, actions: Array(6).fill('Acción') }).success,
    false,
  );
});
