/**
 * Contratos de datos del caso de uso: entrada del ticket, propuesta pública y decisión de moderación.
 * Zod valida valores reales; sus tipos inferidos ayudan a TypeScript y su JSON Schema comunica
 * el formato al modelo. Compartir esta definición evita mantener tres contratos contradictorios.
 */
import { z } from 'zod';

/** Python len(str) cuenta puntos Unicode; string.length en JS cuenta unidades UTF-16. */
function withinCharacters(text: string, maximum: number): boolean {
  return Array.from(text).length <= maximum;
}

// Zod valida datos reales en ejecución. TypeScript por sí solo no valida JSON externo.
// .refine agrega una regla propia; .trim normaliza y .min exige contenido después de normalizar.
// El límite de entrada se aplica ANTES de trim para no aceptar entradas enormes de espacios.
export const ticketSchema = z.strictObject({
  text: z
    .string()
    .refine((text) => withinCharacters(text, 8000))
    .trim()
    .min(1),
});

const responseText = z
  .string()
  .trim()
  .min(1)
  .refine((text) => withinCharacters(text, 4000));

// strictObject rechaza claves desconocidas; z.object, por defecto, las elimina.
// No usamos coerce: "0.8" o true no deben convertirse silenciosamente en confidence.
export const supportResponseSchema = z.strictObject({
  answer: responseText,
  confidence: z.number().min(0).max(1),
  category: z.enum(['billing', 'technical', 'account', 'other']),
  actions: z.array(responseText).max(5),
});

// infer obtiene tipos del esquema para evitar mantener dos contratos que se contradigan.
export type Ticket = z.infer<typeof ticketSchema>;
export type SupportResponse = z.infer<typeof supportResponseSchema>;

// JSON Schema comunica el contrato al LLM. Las reglas refine no son portables al
// proveedor: por eso SIEMPRE validamos otra vez con Zod al recibir la respuesta.
export const responseJsonSchema = z.toJSONSchema(supportResponseSchema);

// El moderador aporta una señal acotada; el servicio decide qué puede publicar.
export const safetyAssessmentSchema = z.strictObject({
  decision: z.enum(['allow', 'review', 'block']),
});
export const safetyJsonSchema = z.toJSONSchema(safetyAssessmentSchema);
export const HUMAN_REVIEW_ACTION = 'Derivar a un agente humano para revisión.';

/** Respuesta estática de derivación cuando el flujo se abstiene; no depende de otra generación LLM. */
export function safeResponse(): SupportResponse {
  return supportResponseSchema.parse({
    answer: 'Tu consulta requiere revisión del equipo de soporte para responder con seguridad.',
    confidence: 0,
    category: 'other',
    actions: [HUMAN_REVIEW_ACTION],
  });
}
