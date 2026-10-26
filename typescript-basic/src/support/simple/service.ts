import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { LLMProvider } from '../../llm/provider-types.js';
import type { PromptBundle } from '../../prompting/prompts.js';
import {
  HUMAN_REVIEW_ACTION,
  safeResponse,
  safetyAssessmentSchema,
  supportResponseSchema,
  ticketSchema,
  type SupportResponse,
} from '../schemas.js';

/** Sólo las dependencias necesarias para leer el caso de uso, sin observadores ni trazas. */
export interface SimpleAssistantOptions {
  provider: LLMProvider;
  prompts: Pick<PromptBundle, 'system' | 'inputModeration' | 'outputModeration' | 'repair'>;
}

/**
 * Alternativa didáctica independiente de SupportAssistant. process muestra la secuencia completa;
 * call concentra la mecánica repetida de las tres llamadas dentro de la misma clase.
 * No usa runSession ni StructuredExecutor, ni registra contenido, eventos o consumo.
 * No tiene presupuesto: sirve para estudiar el flujo, no sustituye la implementación operativa.
 */
export class SimpleSupportAssistant {
  constructor(private readonly options: SimpleAssistantOptions) {}

  /**
   * Recibe datos externos desconocidos y devuelve únicamente el contrato público.
   * El estado de cada ticket queda en variables locales, permitiendo compartir esta instancia.
   * Cada etapa consulta al LLM: moderación de entrada, propuesta y moderación de salida.
   */
  async process(input: unknown, callerSignal?: AbortSignal): Promise<SupportResponse> {
    const ticket = ticketSchema.safeParse(input);
    if (!ticket.success) throw new AppError('invalid_input');
    const deadline = AbortSignal.timeout(60_000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
    try {
      // Este flujo elige JSON para identificar el ticket. El proveedor acepta texto y no exige JSON.
      // Otros datos de contexto podrán agregarse aquí una vez validados y contemplados en el prompt.
      const content = JSON.stringify({ ticket: ticket.data.text });
      const inputVerdict = await this.call(
        this.options.prompts.inputModeration,
        content,
        safetyAssessmentSchema,
        'safety_assessment',
        signal,
      );
      // null representa un rechazo explícito del proveedor. Sólo allow permite continuar.
      if (!inputVerdict || inputVerdict.decision !== 'allow') return safeResponse();
      const proposal = await this.call(
        this.options.prompts.system,
        content,
        supportResponseSchema,
        'support_response',
        signal,
      );
      if (!proposal) return safeResponse();
      // Se modera el objeto FINAL, incluida la acción agregada por nuestra propia aplicación.
      if (proposal.confidence < 0.7) {
        const actions = proposal.actions.filter((action) => action !== HUMAN_REVIEW_ACTION);
        proposal.actions = [...actions.slice(0, 4), HUMAN_REVIEW_ACTION];
      }
      const outputVerdict = await this.call(
        this.options.prompts.outputModeration,
        JSON.stringify(proposal),
        safetyAssessmentSchema,
        'safety_assessment',
        signal,
      );
      if (!outputVerdict || outputVerdict.decision !== 'allow') return safeResponse();
      return supportResponseSchema.parse(proposal);
    } catch (error) {
      if (callerSignal?.aborted) throw new AppError('cancelled');
      if (deadline.aborted) throw new AppError('deadline_exceeded');
      throw error instanceof AppError ? error : new AppError('internal_error');
    }
  }

  /**
   * T es el tipo inferido del esquema: la misma función devuelve una decisión o una propuesta.
   * JSON Schema guía al proveedor; Zod comprueba los datos reales que éste devuelve.
   * Dos intentos TOTALES por etapa, compartidos entre formato inválido y fallos transitorios.
   * Nunca reenviamos texto inválido como instrucciones ni publicamos una moderación fallida.
   */
  private async call<T>(
    system: string,
    content: string,
    schema: z.ZodType<T>,
    schemaName: 'support_response' | 'safety_assessment',
    ticketSignal: AbortSignal,
  ): Promise<T | null> {
    let repair = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const signal = AbortSignal.any([ticketSignal, AbortSignal.timeout(15_000)]);
      try {
        signal.throwIfAborted();
        const result = await this.options.provider.complete({
          systemPrompt: system + (repair ? `\n${this.options.prompts.repair}` : ''),
          userContent: content,
          responseSchema: z.toJSONSchema(schema),
          schemaName,
          maxOutputTokens: schemaName === 'support_response' ? 1024 : 128,
          signal,
        });
        signal.throwIfAborted();
        if (result.status === 'refused') return null;
        if (result.status !== 'completed') throw new AppError('incomplete_output');
        let value: unknown;
        try {
          value = JSON.parse(result.text);
        } catch {
          throw new AppError('invalid_output');
        }
        const parsed = schema.safeParse(value);
        if (!parsed.success) throw new AppError('invalid_output');
        return parsed.data;
      } catch (error) {
        if (ticketSignal.aborted) throw error;
        const failure = signal.aborted
          ? new AppError('timeout')
          : error instanceof AppError
            ? error
            : new AppError('provider_error');
        if (attempt === 2 || (!failure.retryable && failure.code !== 'invalid_output'))
          throw failure;
        repair = failure.code === 'invalid_output';
        if (!repair) await sleep(100, undefined, { signal: ticketSignal });
      }
    }
    throw new AppError('internal_error');
  }
}
