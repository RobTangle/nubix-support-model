import type { AssistantOptions, ProcessOptions } from '../execution.js';
import { safeResponse } from '../schemas.js';
import { generateProposal, runSession, type SupportRun } from '../service-run.js';

/** Sólo para el corpus sintético: ningún flag del servicio público omite moderación. */
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
