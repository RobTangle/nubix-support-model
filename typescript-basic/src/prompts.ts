import { PromptRegistry } from './prompt-registry.js';
import type { PromptVersion } from './prompt-contracts.js';

export type { PromptVersion } from './prompt-contracts.js';
/** Instrucciones ensambladas y huellas para reproducir una ejecución o compararla. */
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

/**
 * Atajo compatible para scripts: carga el registro y devuelve una versión validada.
 * Servidor y evals reutilizan PromptRegistry para cargar recursos una sola vez.
 * evaluation añade un canario sintético; no habilita herramientas ni cambia seguridad.
 */
export async function loadPrompts(
  version?: PromptVersion,
  evaluation = false,
): Promise<PromptBundle> {
  return (await PromptRegistry.load()).get(version, evaluation);
}
