/**
 * Contrato neutral entre el ejecutor y los proveedores. Un "puerto" describe lo que necesita
 * la aplicación; un adaptador de providers.ts lo implementa con OpenAI, xAI o Google.
 * Así el caso de uso puede cambiar de SDK o usar un doble de prueba sin cambiar sus reglas.
 */
/** Una solicitud al modelo con instrucciones, contenido, contrato de salida y límite de tokens. */
export interface CompletionRequest {
  readonly systemPrompt: string;
  /**
   * Contenido textual enviado como mensaje de usuario: texto libre o datos serializados como JSON.
   * El flujo llamador decide su formato y valida los datos; el adaptador lo transmite sin interpretarlo.
   * Agregar campos al JSON no exige cambiar este contrato, pero sí validar y documentar su uso en el flujo.
   */
  readonly userContent: string;
  readonly responseSchema: Record<string, unknown>;
  readonly signal: AbortSignal;
  readonly schemaName: string;
  readonly maxOutputTokens: number;
}

/** Resultado normalizado del SDK. text todavía requiere JSON.parse y validación con Zod. */
export interface CompletionResult {
  readonly text: string;
  readonly status: 'completed' | 'incomplete' | 'refused';
  readonly usage: TokenUsage | null;
}

/** null expresa un desglose desconocido; no equivale a cero tokens facturados. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
}

/** Las interfaces desaparecen al compilar; son contratos estáticos, no validadores. */
export interface LLMProvider {
  /**
   * Solicita al modelo una generación usando el contexto y el esquema recibidos.
   *
   * Este contrato pertenece a la integración con el LLM: no conoce tickets ni
   * políticas de soporte. Cada adaptador traduce la solicitud a su SDK, propaga
   * la señal de cancelación y normaliza el resultado y los errores.
   * El texto devuelto todavía debe validarse localmente en StructuredExecutor.
   *
   * @param request Instrucciones, contenido de usuario, JSON Schema y señal de cancelación.
   * @returns Texto generado y estado normalizado: completado, incompleto o rechazado.
   * @throws AppError Ante un fallo operativo, con diagnóstico sanitizado sin datos del SDK.
   */
  complete(request: CompletionRequest): Promise<CompletionResult>;
}
