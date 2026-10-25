import { setTimeout as delay } from 'node:timers/promises';
import type { CompletionRequest, CompletionResult, LLMProvider } from '../llm/provider-types.js';

/** Doble didáctico, no un modelo: conserva la interfaz real y nunca abre conexiones externas. */
export class DemoProvider implements LLMProvider {
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    await delay(220, undefined, { signal: request.signal });
    const input = JSON.parse(request.userContent) as { ticket?: string };
    const text = input.ticket ?? '';
    const moderation = request.schemaName === 'safety_assessment';
    const category = /factura|cobr|pago/i.test(text)
      ? 'billing'
      : /error|report|integraci|dashboard/i.test(text)
        ? 'technical'
        : /cuenta|acceso|usuario|permiso/i.test(text)
          ? 'account'
          : 'other';
    const answers = {
      billing: {
        answer:
          'Para revisar la consulta de facturación, indicá el período y la fecha o referencia del cargo. El equipo debe verificarlo antes de gestionar un ajuste.',
        actions: ['Verificar período, fecha y referencia con el equipo de facturación.'],
      },
      technical: {
        answer:
          '¿Qué operación falla, qué mensaje aparece y desde cuándo ocurre? Indicá también el entorno o dispositivo para que soporte pueda investigarlo.',
        actions: [
          'Reunir operación afectada, mensaje, hora y entorno antes de derivar a soporte técnico.',
        ],
      },
      account: {
        answer:
          'Para revisar el acceso o los permisos, soporte debe verificar primero la titularidad por un canal seguro. No compartas contraseñas ni códigos.',
        actions: [
          'Verificar titularidad por un canal seguro antes de gestionar cambios de cuenta.',
        ],
      },
      other: {
        answer:
          '¿Podés ampliar qué necesitás resolver? Para planes o descuentos, el equipo comercial debe confirmar las condiciones disponibles.',
        actions: ['Pedir contexto y derivar al equipo correspondiente.'],
      },
    };
    return {
      status: 'completed',
      text: JSON.stringify(
        moderation
          ? { decision: text === 'DEMO_BLOCK' ? 'block' : 'allow' }
          : { ...answers[category], category, confidence: 0.86 },
      ),
      usage: {
        inputTokens: 40,
        outputTokens: moderation ? 8 : 65,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
      },
    };
  }
}
