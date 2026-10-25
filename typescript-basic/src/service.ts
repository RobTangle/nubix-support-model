/**
 * Caso de uso de soporte: moderar la entrada, generar una propuesta y moderar su salida.
 * Separa la decisión de qué publicar del transporte (CLI/HTTP) y de los detalles de cada SDK.
 * Delega el ciclo de vida de cada ticket a service-run.ts y sus llamadas a execution.ts;
 * mantener esas responsabilidades aparte permite probar y evaluar el mismo flujo desde otros bordes.
 */
import type { AssistantOptions, ProcessOptions } from './execution.js';
import { loadPrompts } from './prompts.js';
import { safeResponse, safetyAssessmentSchema, type SupportResponse } from './schemas.js';
import { generateProposal, runSession, type SupportRun } from './service-run.js';
import { runtimeSettingsSchema } from './runtime-settings.js';
import { AppError } from './errors.js';

export type { AssistantOptions, ProcessOptions } from './execution.js';
export type { SupportRun } from './service-run.js';

/** Alias conservado para estudiar el prompt de generación sin construir un cliente. */
export async function loadPrompt(): Promise<string> {
  return (await loadPrompts()).system;
}

/**
 * Coordina el trabajo de soporte con dependencias inyectadas. Una instancia puede atender varias
 * consultas: conserva configuración compartida y crea el estado de cada corrida mediante runSession.
 */
export class SupportAssistant {
  private readonly options: AssistantOptions;

  // La asignación explícita permite ver qué queda guardado en la instancia.
  // También sería válido constructor(private readonly options: AssistantOptions) {}.
  constructor(options: AssistantOptions) {
    const settings = runtimeSettingsSchema.safeParse(options.settings ?? {});
    if (!settings.success) throw new AppError('configuration_error');
    this.options = { ...options, settings: settings.data };
  }

  /**
   * Propone una respuesta validada para revisión humana; las acciones no se ejecutan.
   * El resultado público conserva cuatro campos, aunque se midan varias llamadas.
   * @param input Objeto externo con text; unknown exige validación con Zod.
   * @param callerSignal Cancelación del llamador, combinada con el plazo total.
   * @throws AppError Con diagnóstico sanitizado, sin texto crudo del SDK.
   */
  async respond(input: unknown, callerSignal?: AbortSignal): Promise<SupportResponse> {
    return (await this.process(input, callerSignal ? { signal: callerSignal } : {})).response;
  }

  /**
   * Coordina seguridad y generación. Validar JSON no prueba corrección semántica:
   * la moderación evalúa entrada y propuesta, incluyendo actions, antes de publicar.
   * La traza contiene sólo metadatos; el estado por consulta vive en runSession.
   * process devuelve respuesta + traza para reportes/evaluaciones; respond expone sólo la respuesta.
   * Sólo allow continúa: review, block o rechazo del proveedor llevan a una derivación estática.
   */
  async process(input: unknown, process: ProcessOptions = {}): Promise<SupportRun> {
    return runSession(this.options, input, process, async (ticket, executor, context) => {
      const inputVerdict = await executor.call(
        'input_moderation',
        this.options.prompts.inputModeration,
        JSON.stringify({ ticket: ticket.text }),
        safetyAssessmentSchema,
        context,
      );
      if (!inputVerdict || inputVerdict.decision !== 'allow')
        return { response: safeResponse(), status: 'blocked', abstained: true };
      const proposal = await generateProposal(
        ticket,
        executor,
        context,
        this.options.prompts.system,
      );
      if (!proposal) return { response: safeResponse(), status: 'blocked', abstained: true };
      const outputVerdict = await executor.call(
        'output_moderation',
        this.options.prompts.outputModeration,
        JSON.stringify(proposal),
        safetyAssessmentSchema,
        context,
      );
      if (!outputVerdict || outputVerdict.decision !== 'allow')
        return { response: safeResponse(), status: 'blocked', abstained: true };
      return {
        response: proposal,
        status: proposal.confidence < 0.7 ? 'escalated' : 'ok',
        abstained: false,
      };
    });
  }
}
