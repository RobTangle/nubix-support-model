/**
 * Políticas de ejecución: plazos, tokens máximos y presupuestos, con límites y defaults validados.
 * Separarlas de environment.ts permite usar el mismo cliente con distintas políticas en pruebas/evals.
 * Los importes se representan como texto decimal; las duraciones se expresan en milisegundos.
 */
import { z } from 'zod';
import { AppError } from '../errors.js';

const money = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .refine((value) => Number(value) > 0 && Number.isFinite(Number(value)));
export const runtimeSettingsSchema = z.strictObject({
  callTimeoutMs: z.number().int().min(1).max(15_000).default(15_000),
  deadlineMs: z.number().int().min(1).max(60_000).default(60_000),
  generationMaxTokens: z.number().int().min(1).max(1024).default(1024),
  moderationMaxTokens: z.number().int().min(1).max(128).default(128),
  ticketBudgetUsd: money.default('0.05'),
  evalBudgetUsd: money.default('5'),
});
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;

/**
 * Lee los dos presupuestos configurables por entorno y completa los demás defaults con Zod.
 * Tiempos y tokens pueden ajustarse programáticamente mediante las opciones del asistente.
 */
export function readRuntimeSettings(env: NodeJS.ProcessEnv): RuntimeSettings {
  const result = runtimeSettingsSchema.safeParse({
    ticketBudgetUsd: env.NUBBIX_TICKET_BUDGET_USD ?? '0.05',
    evalBudgetUsd: env.NUBBIX_EVAL_BUDGET_USD ?? '5',
  });
  if (!result.success) throw new AppError('configuration_error');
  return result.data;
}
