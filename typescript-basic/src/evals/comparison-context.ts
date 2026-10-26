import { AppError } from '../errors.js';
import type { PromptBundle } from '../prompting/prompts.js';

/** Lo que el experimento de generación mantiene fijo; system y ejemplos pueden variar. */
export function promptComparisonContext(
  manualVersion: string,
  safetyVersion: string,
  hashes: Record<string, string>,
): string {
  return JSON.stringify([
    manualVersion,
    safetyVersion,
    hashes.manual,
    hashes.safety,
    hashes.inputModeration,
    hashes.outputModeration,
    hashes.repair,
  ]);
}

/** Validar antes de reservar reportes o crear un job evita gastar API en un contraste inválido. */
export function assertComparablePrompts(prompts: readonly PromptBundle[]): void {
  if (
    new Set(
      prompts.map((prompt) =>
        promptComparisonContext(prompt.manualVersion, prompt.safetyVersion, prompt.hashes),
      ),
    ).size > 1
  )
    throw new AppError('incompatible_prompts');
}
