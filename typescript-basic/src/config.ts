import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { AppError } from './errors.js';

export const settingsSchema = z.strictObject({
  provider: z.enum(['openai', 'xai', 'google-ai']),
  apiKey: z.string().trim().min(1),
  model: z.string().trim().min(1),
});

export type ProviderSettings = z.infer<typeof settingsSchema>;

/** Función pura: recibe el entorno para poder probarla sin cambiar process.env global. */
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

/** Bootstrap solamente: el servicio no vuelve a leer archivos en cada ticket. */
export async function readEnvironment(
  path?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  try {
    const source = await readFile(path ?? new URL('../../.env', import.meta.url), 'utf8');
    return { ...parseEnv(source), ...env };
  } catch (error) {
    if (path === undefined && error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return { ...env };
    throw new AppError('configuration_error');
  }
}
