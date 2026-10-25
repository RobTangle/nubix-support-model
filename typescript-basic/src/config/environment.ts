/**
 * Configuración de conexión: decide proveedor, clave y modelo a partir de valores del entorno.
 * Separa lectura de archivos de validación para probarla sin alterar process.env. Los límites de
 * dinero/tiempo/tokens viven en runtime-settings.ts porque son políticas de ejecución del asistente.
 */
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { AppError } from '../errors.js';

export const settingsSchema = z.strictObject({
  provider: z.enum(['openai', 'xai', 'google-ai']),
  apiKey: z.string().trim().min(1),
  model: z.string().trim().min(1),
});

export type ProviderSettings = z.infer<typeof settingsSchema>;

/**
 * Selecciona sólo la clave del proveedor elegido, aplica el modelo predeterminado y valida datos.
 * Una variable de modelo ausente usa el default; una definida pero vacía falla por configuración.
 * Recibe el entorno explícitamente y no lo modifica ni inicia conexiones con los proveedores.
 */
export function readSettings(provider: string, env: NodeJS.ProcessEnv): ProviderSettings {
  if (provider !== 'openai' && provider !== 'xai' && provider !== 'google-ai')
    throw new AppError('invalid_provider');
  const { apiKey, model } = {
    openai: {
      apiKey: env.OPENAI_API_KEY,
      model: env.NUBBIX_OPENAI_MODEL ?? 'gpt-6-luna',
    },
    xai: {
      apiKey: env.XAI_API_KEY,
      model: env.NUBBIX_XAI_MODEL ?? 'grok-4.20-0309-non-reasoning',
    },
    'google-ai': {
      apiKey: env.GEMINI_API_KEY,
      model: env.NUBBIX_GOOGLE_AI_MODEL ?? 'gemini-3.5-flash-lite',
    },
  }[provider];
  if (!apiKey?.trim()) throw new AppError('missing_key');
  const result = settingsSchema.safeParse({ provider, apiKey, model });
  if (!result.success) throw new AppError('configuration_error');
  return result.data;
}

/**
 * Preparación inicial (bootstrap): combina el .env de la raíz con el entorno recibido, que tiene
 * prioridad. El .env predeterminado puede faltar; una ruta explícita inexistente es un error.
 * Se llama al iniciar el comando, antes de crear el asistente, para evitar I/O por cada etapa.
 */
export async function readEnvironment(
  path?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  try {
    const source = await readFile(path ?? new URL('../../../.env', import.meta.url), 'utf8');
    return { ...parseEnv(source), ...env };
  } catch (error) {
    if (path === undefined && error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return { ...env };
    throw new AppError('configuration_error');
  }
}
