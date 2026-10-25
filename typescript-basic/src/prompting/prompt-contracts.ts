import { z } from 'zod';

// Un ID válido no implica pertenencia: las fronteras de ejecución consultan PromptRegistry.
// Este contrato portable permite validar reportes históricos sin cargar módulos Node en la UI.
export const promptVersionSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
export type PromptVersion = z.infer<typeof promptVersionSchema>;
export const promptMetadataSchema = z.strictObject({
  id: promptVersionSchema,
  label: z.string().trim().min(1).max(160),
});
export type PromptMetadata = z.infer<typeof promptMetadataSchema>;
