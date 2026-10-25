import type { InspectionEntry } from '../../inspection/contracts.js';

const labels: Record<InspectionEntry['kind'], string> = {
  'http.request': 'Body HTTP recibido',
  'input.received': 'Entrada recibida',
  'input.validated': 'Entrada normalizada y esquema',
  'llm.request': 'Request al LLM y esquema',
  'llm.response': 'Respuesta cruda del LLM',
  'schema.validation': 'Validación de salida y esquema',
};
const stages = {
  input_moderation: 'Moderación de entrada',
  generation: 'Clasificación y respuesta',
  output_moderation: 'Moderación de salida',
};
const fields: Record<string, string> = {
  body: 'Body de la request HTTP',
  text: 'Texto recibido',
  input: 'Entrada validada',
  systemPrompt: 'Instrucciones del sistema (contexto confiable)',
  userContent: 'Contenido enviado como usuario (datos no confiables)',
  valid: 'Validación del contrato',
  value: 'Objeto validado',
  status: 'Estado informado',
  usage: 'Consumo informado por el proveedor',
  schemaName: 'Contrato solicitado',
  maxOutputTokens: 'Límite de tokens de salida',
};

/** Canal de depuración independiente: nunca publica una propuesta como respuesta final. */
export class InspectorView {
  constructor(private readonly container: HTMLElement) {}

  reset(): void {
    this.container.replaceChildren();
  }

  append(entry: InspectionEntry): void {
    const document = this.container.ownerDocument;
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const metadata = document.createElement('p');
    summary.textContent = `#${entry.sequence} · ${labels[entry.kind]}${entry.stage ? ` · ${stages[entry.stage]}` : ''}`;
    metadata.className = 'inspection-meta';
    metadata.textContent = `${entry.timestamp.slice(11, 23)} UTC${entry.attempt ? ` · intento ${entry.attempt}` : ''} · Datos de depuración; pueden estar sin moderar.`;
    const data = entry.data;
    details.append(summary, metadata);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const list = document.createElement('dl');
      list.className = 'inspection-fields';
      for (const [key, value] of Object.entries(data)) {
        if (!fields[key]) continue;
        const label = document.createElement('dt');
        const content = document.createElement('dd');
        label.textContent = fields[key];
        content.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        if (key === 'text' && entry.kind === 'llm.response') this.describeDecision(content, value);
        list.append(label, content);
      }
      details.append(list);
    }
    const raw = document.createElement('details');
    const caption = document.createElement('summary');
    const content = document.createElement('pre');
    caption.textContent = 'Ver datos completos y esquema (JSON)';
    content.textContent = JSON.stringify(data, null, 2);
    raw.append(caption, content);
    details.append(raw);
    this.container.append(details);
  }

  /** Esta etiqueta explica el JSON observado; no sustituye la validación ni aprueba la salida. */
  private describeDecision(container: HTMLElement, value: unknown): void {
    if (typeof value !== 'string') return;
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object' || !('decision' in parsed)) return;
      const decisions: Record<string, string> = {
        allow: 'Permitido',
        review: 'Revisión requerida',
        block: 'Bloqueado',
      };
      const decision = String(parsed.decision);
      if (decisions[decision])
        container.textContent = `${decisions[decision]} · decision: ${decision}`;
    } catch {
      // Una salida inválida sigue siendo visible para investigar el parsing, sin tratarla como aprobada.
    }
  }
}
