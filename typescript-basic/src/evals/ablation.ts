/**
 * Variante experimental que ejecuta únicamente la generación sobre el corpus sintético.
 * Una «ablación» quita un componente para medir su aporte: aquí se compara con y sin moderación.
 * Se mantiene fuera del servicio habitual para que este experimento no amplíe su API pública.
 */
import type { AssistantOptions, ProcessOptions } from '../llm/execution.js';
import { safeResponse } from '../support/schemas.js';
import { generateProposal, runSession, type SupportRun } from '../support/service-run.js';

/**
 * Crea la referencia de comparación (baseline) sin moderación, conservando validación JSON,
 * presupuesto y trazas de runSession. Sólo se usa con el corpus sintético de evaluación.
 */
export function createGenerationOnlyBaseline(options: AssistantOptions): {
  process(input: unknown, process?: ProcessOptions): Promise<SupportRun>;
} {
  return {
    async process(input, process = {}) {
      return runSession(options, input, process, async (ticket, executor, context) => {
        const proposal = await generateProposal(ticket, executor, context, options.prompts.system);
        return proposal
          ? {
              response: proposal,
              status: proposal.confidence < 0.7 ? 'escalated' : 'ok',
              abstained: false,
            }
          : { response: safeResponse(), status: 'blocked', abstained: true };
      });
    },
  };
}
