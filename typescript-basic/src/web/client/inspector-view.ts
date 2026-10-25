import type { InspectionEntry } from '../../inspection/contracts.js';

const labels: Record<InspectionEntry['kind'], string> = {
  'http.request': 'Body HTTP recibido',
  'input.received': 'Entrada recibida',
  'input.validated': 'Entrada normalizada y esquema',
  'llm.request': 'Request al LLM y esquema',
  'llm.response': 'Respuesta cruda del LLM',
  'schema.validation': 'Validación de salida y esquema',
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
    const content = document.createElement('pre');
    const warning = document.createElement('p');
    summary.textContent = `#${entry.sequence} · ${labels[entry.kind]}${entry.stage ? ` · ${entry.stage}` : ''}${entry.attempt ? ` · intento ${entry.attempt}` : ''} · ${entry.timestamp.slice(11, 23)} UTC`;
    warning.className = 'debug-warning';
    warning.textContent =
      'Depuración local: puede incluir propuestas sin moderar. No es la respuesta publicada.';
    content.textContent = JSON.stringify(entry.data, null, 2);
    details.append(summary, warning, content);
    this.container.append(details);
  }
}
