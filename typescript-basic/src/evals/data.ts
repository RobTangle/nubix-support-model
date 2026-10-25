/**
 * Carga y valida el corpus: el conjunto de tickets y casos adversariales usados para evaluar.
 * Normaliza sus archivos JSONL (un objeto JSON por línea) a un contrato común para el runner.
 * Separar estas reglas evita mezclar errores del dataset con fallas o calidad del modelo.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { readSharedResource } from '../resources/read-shared.js';

export const categories = ['billing', 'technical', 'account', 'other'] as const;
export const categorySchema = z.enum(categories);
const text = z
  .string()
  .refine((value) => Array.from(value).length <= 8000)
  .trim()
  .min(1);
const base = {
  id: z.string().min(1),
  text,
  forbidden_patterns: z.array(z.string()),
  scenario: z.string().min(1),
};
const ticket = z.strictObject({
  ...base,
  split: z.enum(['dev', 'test']),
  category: categorySchema,
  expected_actions: z.array(z.string()),
});
const adversarial = z.strictObject({
  ...base,
  kind: z.enum(['attack', 'benign']),
  expected_category: categorySchema,
});
/** Caso con la entrada y el resultado esperado; aún no contiene una respuesta del asistente. */
export interface EvaluationCase {
  id: string;
  text: string;
  kind: 'ticket' | 'attack' | 'benign';
  expectedCategory: (typeof categories)[number];
  expectedActions: string[];
  forbiddenPatterns: string[];
  scenario: string;
}
/** dev permite ajustar decisiones; test se reserva para comprobarlas con otros tickets. */
export interface EvaluationDataset {
  tickets: (EvaluationCase & { split: 'dev' | 'test' })[];
  adversarial: EvaluationCase[];
  hashes: Record<string, string>;
}

/** Huella SHA-256 del texto exacto: detecta cambios del corpus o de otros artefactos evaluados. */
export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Compila las reglas de texto compartidas con Python; (?i) se traduce a «ignorar mayúsculas».
 * Rechaza construcciones no soportadas para evitar evaluar con una regla de significado distinto.
 */
export function compilePattern(source: string): RegExp {
  const expression = source.startsWith('(?i)') ? source.slice(4) : source;
  if (/\(\?[a-zA-Z-]|\\[AZz]|\(\?P/.test(expression)) throw new AppError('invalid_dataset');
  try {
    return new RegExp(expression, source.startsWith('(?i)') ? 'iu' : 'u');
  } catch {
    throw new AppError('invalid_dataset');
  }
}

/**
 * Exige tamaños, categorías equilibradas e IDs únicos para que las métricas sean comparables.
 * El canario es una marca sintética en las instrucciones internas: no debe venir incluida en el ataque,
 * porque encontrarla en la respuesta dejaría de ser evidencia de una posible filtración.
 */
export function parseDataset(ticketSource: string, adversarialSource: string): EvaluationDataset {
  try {
    const tickets = ticketSource
      .split(/\r?\n/u)
      .filter((line) => line.trim())
      .map((line) => ticket.parse(JSON.parse(line)));
    const attacks = adversarialSource
      .split(/\r?\n/u)
      .filter((line) => line.trim())
      .map((line) => adversarial.parse(JSON.parse(line)));
    const ids = [...tickets, ...attacks].map((row) => row.id);
    if (new Set(ids).size !== ids.length || tickets.length !== 80 || attacks.length !== 20)
      throw new Error('size');
    for (const split of ['dev', 'test'])
      for (const category of categories)
        if (tickets.filter((row) => row.split === split && row.category === category).length !== 10)
          throw new Error('balance');
    if (
      attacks.filter((row) => row.kind === 'attack').length !== 10 ||
      attacks.filter((row) => row.kind === 'benign').length !== 10
    )
      throw new Error('balance');
    for (const row of [...tickets, ...attacks])
      for (const pattern of row.forbidden_patterns) compilePattern(pattern);
    for (const id of ['attack-04', 'attack-05'])
      if (
        !attacks.find((row) => row.id === id) ||
        attacks.find((row) => row.id === id)!.text.includes('NUBBIX_CANARY_7F2A')
      )
        throw new Error('canary');
    return {
      tickets: tickets.map((row) => ({
        id: row.id,
        text: row.text,
        kind: 'ticket',
        expectedCategory: row.category,
        expectedActions: row.expected_actions,
        forbiddenPatterns: row.forbidden_patterns,
        scenario: row.scenario,
        split: row.split,
      })),
      adversarial: attacks.map((row) => ({
        id: row.id,
        text: row.text,
        kind: row.kind,
        expectedCategory: row.expected_category,
        expectedActions: [],
        forbiddenPatterns: row.forbidden_patterns,
        scenario: row.scenario,
      })),
      hashes: { tickets: hash(ticketSource), adversarial: hash(adversarialSource) },
    };
  } catch {
    throw new AppError('invalid_dataset');
  }
}

/** Lee ambos archivos compartidos y aplica las mismas validaciones antes de llamar a un LLM. */
export async function loadDataset(): Promise<EvaluationDataset> {
  const [tickets, adversarial] = await Promise.all([
    readSharedResource('datasets/tickets.jsonl'),
    readSharedResource('datasets/adversarial.jsonl'),
  ]);
  return parseDataset(tickets, adversarial);
}
