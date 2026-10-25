import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import { AppError } from './errors.js';
import { supportResponseSchema } from './schemas.js';

export type PromptVersion = 'basic-v1' | 'basic-v2';
export interface PromptBundle {
  version: PromptVersion;
  manualVersion: string;
  safetyVersion: string;
  system: string;
  inputModeration: string;
  outputModeration: string;
  repair: string;
  hashes: Record<string, string>;
  canaryEnabled: boolean;
}
const text = z.string().min(1);
const contextSchema = z.strictObject({ version: text, manual: text });
const baseSchema = z.strictObject({ version: z.literal('basic-v1'), system: text });
const safetySchema = z.strictObject({
  version: text,
  repair: text,
  evaluation_marker: text,
  input: text,
  output: text,
});
const examplesSchema = z.strictObject({
  version: z.literal('basic-v2'),
  examples: z.array(z.strictObject({ ticket: text, response: supportResponseSchema })).length(4),
});

/** Se cargan una vez por configuración: YAML describe contexto, Zod comprueba su contrato. */
export async function loadPrompts(
  version: PromptVersion = 'basic-v1',
  evaluation = false,
): Promise<PromptBundle> {
  try {
    if (!['basic-v1', 'basic-v2'].includes(version)) throw new AppError('configuration_error');
    const [contextSource, baseSource, safetySource, examplesSource] = await Promise.all([
      readFile(new URL('./resources/context.yaml', import.meta.url), 'utf8'),
      readFile(new URL('./prompt.yaml', import.meta.url), 'utf8'),
      readFile(new URL('./resources/safety.yaml', import.meta.url), 'utf8'),
      readFile(new URL('./resources/basic-v2.yaml', import.meta.url), 'utf8'),
    ]);
    const context = contextSchema.parse(parse(contextSource));
    const base = baseSchema.parse(parse(baseSource));
    const safety = safetySchema.parse(parse(safetySource));
    const examples = examplesSchema.parse(parse(examplesSource));
    if (new Set(examples.examples.map((item) => item.response.category)).size !== 4)
      throw new AppError('configuration_error');
    const render = (source: string): string =>
      source.replaceAll('{{manual}}', context.manual.trimEnd());
    const marker = evaluation ? `\n${safety.evaluation_marker}` : '';
    const system =
      render(base.system) +
      (version === 'basic-v2'
        ? `\nEJEMPLOS INDEPENDIENTES:\n${JSON.stringify(examples.examples)}`
        : '') +
      marker;
    const inputModeration = render(safety.input) + marker;
    const outputModeration = render(safety.output) + marker;
    const hashes = Object.fromEntries(
      Object.entries({
        system,
        inputModeration,
        outputModeration,
        repair: safety.repair,
        manual: context.manual,
        safety: safetySource,
        examples: examplesSource,
      }).map(([key, value]) => [key, createHash('sha256').update(value).digest('hex')]),
    );
    return {
      version,
      manualVersion: context.version,
      safetyVersion: safety.version,
      system,
      inputModeration,
      outputModeration,
      repair: safety.repair,
      hashes,
      canaryEnabled: evaluation,
    };
  } catch {
    throw new AppError('configuration_error');
  }
}
